import { Provider, Signer, TransactionReceipt, TransactionRequest } from 'ethers';
import { revertName } from './contract';

/**
 * Sending transactions on Monad: the network charges `gasLimit × price`, not
 * the gas used, so every transaction carries an explicit limit from
 * `eth_estimateGas` plus a small margin.  A call that would revert fails at
 * estimation and costs nothing.
 */

export interface TxRequest {
  signer: Signer;
  to: string;
  data: string;
  value?: bigint;
  /** Fixed gas limit (skips estimation) */
  gasLimit?: bigint;
  /** Explicit EIP-1559 fees (default: the signer's provider fills them) */
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  label?: string;
}

export interface TxResult {
  hash: string;
  receipt: TransactionReceipt;
  gasLimit: bigint;
  /** What Monad charges: gasLimit × effective gas price */
  fee: bigint;
}

export interface SenderOptions {
  /** Margin over eth_estimateGas, in % (default 10) */
  gasBufferPct?: number;
  /**
   * Smallest margin over eth_estimateGas, in gas (default 75 000): a call's
   * cost can change between the estimate and its block when others act on
   * the same entry (e.g. the confirmation that fills a blob also takes it out
   * of the work queue), and small calls would run out of gas with 10 %.
   */
  minGasHeadroom?: bigint;
  /** Transactions in flight at once in sendAll (default 8) */
  concurrency?: number;
  /** Give up waiting for a receipt after this long (default 120 s) */
  timeoutMs?: number;
  /**
   * Apply Monad's reserve-balance rule to transactions that send value
   * (default: on Monad chains 10143 and 143).  See `waitForEmptyingWindow`.
   */
  reserveBalanceRule?: boolean;
}

/** Monad's per-account reserve (`user_reserve_balance`) */
export const MONAD_RESERVE_BALANCE = 10n * 10n ** 18n;
/** Blocks without transactions from an account before it may dip into its reserve (`k`) */
export const MONAD_EMPTYING_BLOCKS = 3;
const MONAD_CHAINS = new Set([10143, 143]);

/** A transaction the contract rejected (custom error name when known) */
export class MonaDBTransactionError extends Error {
  constructor(
    readonly label: string,
    readonly errorName: string | undefined,
    cause: unknown,
  ) {
    const reason = errorName ?? (cause as { shortMessage?: string })?.shortMessage ?? (cause as Error)?.message ?? String(cause);
    super(`${label}: ${reason}`);
    this.name = 'MonaDBTransactionError';
    this.cause = cause;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TransactionSender {
  readonly concurrency: number;
  private readonly buffer: bigint;
  private readonly headroom: bigint;
  private readonly timeoutMs: number;
  private reserveRule?: Promise<boolean>;

  constructor(
    readonly provider: Provider,
    options: SenderOptions = {},
  ) {
    this.buffer = BigInt(options.gasBufferPct ?? 10);
    this.headroom = options.minGasHeadroom ?? 75_000n;
    this.concurrency = options.concurrency ?? 8;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (options.reserveBalanceRule !== undefined) this.reserveRule = Promise.resolve(options.reserveBalanceRule);
  }

  private appliesReserveRule(): Promise<boolean> {
    this.reserveRule ??= this.provider
      .getNetwork()
      .then((n) => MONAD_CHAINS.has(Number(n.chainId)))
      .catch(() => false);
    return this.reserveRule;
  }

  /**
   * Monad keeps a 10 MON reserve per account: a transaction that sends value
   * and leaves the sender under min(balance, 10 MON) reverts, unless it is an
   * "emptying" transaction, i.e. the sender sent nothing in the previous 3
   * blocks.  Before such a transaction, wait for that quiet window (a few
   * hundred ms after the wallet's previous transaction).
   */
  async waitForEmptyingWindow(from: string, value: bigint, gasLimit: bigint): Promise<void> {
    if (value === 0n || !(await this.appliesReserveRule())) return;
    const [balance, fee] = await Promise.all([this.provider.getBalance(from), this.provider.getFeeData()]);
    const gasCost = gasLimit * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
    if (balance - value - gasCost >= MONAD_RESERVE_BALANCE) return;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const latest = await this.provider.getBlockNumber();
      const [now, before] = await Promise.all([
        this.provider.getTransactionCount(from, latest),
        this.provider.getTransactionCount(from, Math.max(0, latest - MONAD_EMPTYING_BLOCKS)),
      ]).catch(() => [0, 0]);
      // one more block of margin: the transaction lands in a later block than `latest`
      if (now === before) return;
      await sleep(400);
    }
  }

  /** eth_estimateGas + max(10 %, 75 000); throws MonaDBTransactionError on a revert */
  async estimate(request: TxRequest): Promise<bigint> {
    if (request.gasLimit !== undefined) return request.gasLimit;
    try {
      const from = await request.signer.getAddress();
      const estimate = await this.provider.estimateGas({ from, to: request.to, data: request.data, value: request.value ?? 0n });
      const margin = (estimate * this.buffer) / 100n;
      return estimate + (margin > this.headroom ? margin : this.headroom);
    } catch (err) {
      throw new MonaDBTransactionError(request.label ?? 'transaction', revertName(err), err);
    }
  }

  /** Estimate, send and wait for the receipt */
  async send(request: TxRequest): Promise<TxResult> {
    const gasLimit = await this.estimate(request);
    if (request.value) await this.waitForEmptyingWindow(await request.signer.getAddress(), request.value, gasLimit);
    const hash = await this.broadcast(request, gasLimit);
    return this.confirm(request, hash, gasLimit);
  }

  private async broadcast(request: TxRequest, gasLimit: bigint, nonce?: number): Promise<string> {
    const tx: TransactionRequest = { to: request.to, data: request.data, value: request.value ?? 0n, gasLimit };
    if (nonce !== undefined) tx.nonce = nonce;
    if (request.maxFeePerGas !== undefined) tx.maxFeePerGas = request.maxFeePerGas;
    if (request.maxPriorityFeePerGas !== undefined) tx.maxPriorityFeePerGas = request.maxPriorityFeePerGas;
    try {
      return (await request.signer.sendTransaction(tx)).hash;
    } catch (err) {
      throw new MonaDBTransactionError(request.label ?? 'transaction', revertName(err), err);
    }
  }

  private async confirm(request: TxRequest, hash: string, gasLimit: bigint): Promise<TxResult> {
    const label = request.label ?? 'transaction';
    const deadline = Date.now() + this.timeoutMs;
    for (let delay = 200; ; delay = Math.min(delay * 2, 2_000)) {
      const receipt = await this.provider.getTransactionReceipt(hash).catch(() => null);
      if (receipt) {
        if (receipt.status !== 1) throw new MonaDBTransactionError(label, 'reverted', new Error(`transaction ${hash} reverted`));
        return { hash, receipt, gasLimit, fee: gasLimit * (receipt.gasPrice ?? 0n) };
      }
      if (Date.now() > deadline) throw new MonaDBTransactionError(label, undefined, new Error(`no receipt for ${hash} after ${this.timeoutMs} ms`));
      await sleep(delay);
    }
  }

  /**
   * Send many transactions of ONE signer (a session key or a node wallet).
   * Every request is estimated first, so a request that would revert never
   * takes a nonce: `isDone(errorName)` marks such a revert as already done
   * (e.g. a segment written by an earlier attempt), anything else throws.
   * Transactions are broadcast in nonce order, with up to `concurrency`
   * waiting for their receipt at once.
   */
  async sendAll(
    requests: TxRequest[],
    {
      isDone,
      onConfirmed,
    }: { isDone?: (errorName: string | undefined) => boolean; onConfirmed?: (result: TxResult | null, index: number) => void } = {},
  ): Promise<(TxResult | null)[]> {
    if (requests.length === 0) return [];
    const signer = requests[0].signer;
    const from = await signer.getAddress();
    const results: (TxResult | null)[] = new Array(requests.length).fill(null);

    // 1. estimate, a few at a time
    const limits: (bigint | null)[] = new Array(requests.length).fill(null);
    let cursor = 0;
    const estimator = async () => {
      while (cursor < requests.length) {
        const i = cursor++;
        try {
          limits[i] = await this.estimate(requests[i]);
        } catch (err) {
          if (err instanceof MonaDBTransactionError && isDone?.(err.errorName)) {
            onConfirmed?.(null, i);
            continue;
          }
          throw err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, requests.length) }, estimator));

    // 2. broadcast in nonce order, keep `concurrency` receipts pending
    let nonce = await this.provider.getTransactionCount(from, 'pending');
    const inFlight = new Set<Promise<void>>();
    let failure: unknown;
    for (let i = 0; i < requests.length && failure === undefined; i++) {
      if (limits[i] === null) continue;
      while (inFlight.size >= this.concurrency) await Promise.race(inFlight);
      if (failure !== undefined) break;
      const hash = await this.broadcast(requests[i], limits[i]!, nonce++);
      const waiting: Promise<void> = this.confirm(requests[i], hash, limits[i]!)
        .then((result) => {
          results[i] = result;
          onConfirmed?.(result, i);
        })
        .catch((err) => {
          failure ??= err;
        })
        .finally(() => inFlight.delete(waiting));
      inFlight.add(waiting);
    }
    await Promise.all(inFlight);
    if (failure !== undefined) throw failure;
    return results;
  }
}
