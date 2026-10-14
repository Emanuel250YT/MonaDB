import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Contract, getAddress, Wallet } from 'ethers';
import {
  assembleChunk,
  BlobAccount,
  ChunkAccount,
  ConfigAccount,
  createMonadProvider,
  decodeBlob,
  decodeChunk,
  decodeConfig,
  decodeReplicator,
  MonadJsonRpcProvider,
  MONADB_ABI,
  monadbInterface,
  readSegments,
  ReplicatorAccount,
  revertName,
  TransactionSender,
  TxRequest,
  TxResult,
} from '@monadb/sdk';
import { loadReplicatorWallet } from './wallet';

/** An on-chain entry and its id (chunk / blob id, 0x + 64 hex, lower case) */
export interface Fetched<T> {
  address: string;
  data: T;
}

/** A chunk rebuilt from its SegmentWritten events */
export interface LedgerChunk {
  data: Uint8Array;
  /** Highest block among the segment events */
  block: number;
}

/** Outcome of one confirmReplications transaction */
export interface ConfirmBatchResult {
  hash: string;
  /** Chunk ids (lower case) this node's confirmation landed for; the others were skipped on-chain */
  confirmed: Set<string>;
  /** Gas charged (limit × price) */
  fee: bigint;
}

/** Ids per pendingChunks / pendingBlobs page */
const QUEUE_PAGE = 500;
/** Entries per getChunks / getBlobs call (a blob view carries 32 slots) */
const CHUNK_READ_BATCH = 50;
const BLOB_READ_BATCH = 20;
/**
 * Extra gas per chunk of a confirmation batch that another node could turn
 * into this node's last confirmation before the batch lands (closing the
 * chunk costs more than the estimate saw).  The sender's own headroom (75k)
 * covers one; Monad charges the limit, so only the others get this.
 */
const LAST_CONFIRMATION_MARGIN = 35_000n;

const REPLICATION_CONFIRMED = monadbInterface.getEvent('ReplicationConfirmed')!.topicHash;
const lower = (id: string) => id.toLowerCase();

/**
 * MonadService
 *
 * Thin wrapper around @monadb/sdk for everything the node does on-chain:
 *   • read the work queues (`pendingChunks`, `pendingBlobs`: complete chunks
 *     still short of replicas, blobs with a vacant shard slot) and the
 *     entries they point to — no log cursor, no filters (Monad RPCs have no
 *     eth_newFilter),
 *   • rebuild a ledger chunk from its `SegmentWritten` events (eth_getLogs
 *     between the chunk's opened and completed blocks),
 *   • list the registered replicators (peers serving chunks and shards),
 *   • send confirmReplications / confirmShard / proofs / claims, one at a
 *     time (one nonce sequence), each with an explicit gas limit: Monad
 *     charges the limit, not the gas used.
 */
@Injectable()
export class MonadService implements OnModuleInit {
  private readonly logger = new Logger(MonadService.name);

  private provider: MonadJsonRpcProvider;
  private wallet: Wallet;
  private contract: Contract;
  private sender: TransactionSender;
  private contractAddress: string;
  private networkName: string;
  private rpcUrl: string;
  private chainId: number;
  private logsBlockRange: number;
  private owners: string[] = [];
  private txQueue: Promise<unknown> = Promise.resolve();
  readonly maxConfirmationsPerTx: number;

  constructor(private readonly config: ConfigService) {
    this.maxConfirmationsPerTx = this.config.get<number>('monad.maxConfirmationsPerTx') ?? 8;
  }

  async onModuleInit(): Promise<void> {
    this.networkName = this.config.get<string>('monad.network');
    this.rpcUrl = this.config.get<string>('monad.rpcUrl');
    this.chainId = this.config.get<number>('monad.chainId');
    this.logsBlockRange = this.config.get<number>('monad.logsBlockRange') ?? 100;
    this.owners = (this.config.get<string[]>('replication.owners') ?? []).map((o) => getAddress(o));
    const contract = this.config.get<string>('monad.contract');
    if (!contract) {
      throw new Error('Set MONADB_CONTRACT (the MonaDB contract address) or MONADB_DEPLOYMENT (a deployments/monad-<network>.json)');
    }
    this.contractAddress = getAddress(contract);

    this.provider = createMonadProvider(this.rpcUrl, this.chainId);
    this.wallet = loadReplicatorWallet(
      {
        privateKey: this.config.get<string>('monad.replicatorPrivateKey'),
        keyFile: this.config.get<string>('monad.replicatorKeyFile'),
      },
      this.provider,
    );
    this.contract = new Contract(this.contractAddress, MONADB_ABI, this.provider);
    this.sender = new TransactionSender(this.provider, {
      gasBufferPct: this.config.get<number>('monad.gasBufferPct') ?? 15,
      timeoutMs: this.config.get<number>('monad.txTimeoutMs') ?? 60_000,
    });

    // Fail fast: RPC reachable, right chain, a MonaDB contract at the address
    let chainId: number;
    try {
      chainId = Number(await this.provider.send('eth_chainId', []));
    } catch (err) {
      throw new Error(`Monad RPC ${this.rpcUrl} is unreachable: ${(err as Error).message}`);
    }
    if (chainId !== this.chainId) {
      throw new Error(`${this.rpcUrl} is chain ${chainId}, not MONAD_CHAIN_ID ${this.chainId}`);
    }
    if ((await this.provider.getCode(this.contractAddress)) === '0x') {
      throw new Error(`No contract at ${this.contractAddress} on chain ${chainId}`);
    }
    try {
      await this.contract.getConfig();
    } catch (err) {
      throw new Error(`${this.contractAddress} is not a MonaDB contract: ${(err as Error).message}`);
    }

    this.logger.log(`Connected to Monad ${this.networkName} (chain ${chainId}): ${this.network.rpcUrl}`);
    this.logger.log(`Replicator wallet: ${this.wallet.address}`);
    this.logger.log(`MonaDB contract: ${this.contractAddress}`);
    if (this.owners.length > 0) this.logger.log(`Replicating only data of: ${this.owners.join(', ')}`);
  }

  // ── Chunks ──────────────────────────────────────────────────────────────────

  /**
   * Every chunk in the on-chain work queue (complete, not reclaimed, short
   * of replicas), limited to REPLICATE_OWNERS when set.
   */
  async listChunksNeedingReplicas(): Promise<Fetched<ChunkAccount>[]> {
    const count = Number(await this.contract.pendingChunkCount());
    const ids: string[] = [];
    for (let offset = 0; offset < count; offset += QUEUE_PAGE) {
      ids.push(...((await this.contract.pendingChunks(offset, QUEUE_PAGE)) as string[]));
    }
    const chunks = await this.getChunks(ids);
    return chunks.filter((c): c is Fetched<ChunkAccount> => c !== null && c.data.needsReplicas && this.replicatesOwner(c.data.owner));
  }

  async getChunk(id: string): Promise<Fetched<ChunkAccount> | null> {
    return (await this.getChunks([id]))[0];
  }

  /** Many chunks at once (null for closed / never opened) */
  async getChunks(ids: string[]): Promise<(Fetched<ChunkAccount> | null)[]> {
    const out: (Fetched<ChunkAccount> | null)[] = [];
    for (let i = 0; i < ids.length; i += CHUNK_READ_BATCH) {
      const slice = ids.slice(i, i + CHUNK_READ_BATCH).map(lower);
      const raw = (await this.contract.getChunks(slice)) as unknown[];
      raw.forEach((r, j) => {
        const data = decodeChunk(r, slice[j]);
        out.push(data ? { address: slice[j], data } : null);
      });
    }
    return out;
  }

  /**
   * Rebuild a ledger chunk from its SegmentWritten events (between its
   * opened and completed blocks) and check it against its sha256.  Throws
   * when a segment is missing or the bytes do not hash to it.
   */
  async readChunk(id: string, chunk: ChunkAccount): Promise<LedgerChunk> {
    const segments = await readSegments(this.provider, this.contractAddress, lower(id), Number(chunk.openedBlock), {
      segmentsTotal: chunk.segmentsTotal,
      toBlock: chunk.completedBlock > 0n ? Number(chunk.completedBlock) : undefined,
      maxBlockRange: this.logsBlockRange,
    });
    if (segments.length < chunk.segmentsTotal) {
      throw new Error(`Segment ${firstMissing(segments.map((s) => s.index))} is missing from the logs`);
    }
    const data = assembleChunk(segments, chunk.contentHash);
    const block = segments.reduce((max, s) => (s.blockNumber > max ? s.blockNumber : max), 0);
    return { data, block };
  }

  // ── Replicators ─────────────────────────────────────────────────────────────

  /** This node's registration, or null when the admin has not registered it */
  async getReplicator(): Promise<ReplicatorAccount | null> {
    return decodeReplicator(await this.contract.getReplicator(this.wallet.address), this.wallet.address);
  }

  /** Every registered replicator, active or not (their endpoints serve chunks and shards) */
  async listReplicators(): Promise<ReplicatorAccount[]> {
    const count = Number(await this.contract.replicatorCount());
    const out: ReplicatorAccount[] = [];
    for (let offset = 0; offset < count; offset += 100) {
      const [authorities, list] = (await this.contract.getReplicators(offset, 100)) as [string[], unknown[]];
      authorities.forEach((authority, i) => {
        const r = decodeReplicator(list[i], authority);
        if (r) out.push(r);
      });
    }
    return out;
  }

  // ── Blobs (docs/blob-protocol.md) ───────────────────────────────────────────

  /** Blobs with a vacant shard slot (the on-chain queue; expired ones are left to the caller) */
  async listBlobsNeedingHolders(): Promise<Fetched<BlobAccount>[]> {
    const count = Number(await this.contract.pendingBlobCount());
    const ids: string[] = [];
    for (let offset = 0; offset < count; offset += QUEUE_PAGE) {
      ids.push(...((await this.contract.pendingBlobs(offset, QUEUE_PAGE)) as string[]));
    }
    const blobs = await this.getBlobs(ids);
    return blobs.filter((b): b is Fetched<BlobAccount> => b !== null && this.replicatesOwner(b.data.owner));
  }

  async getBlob(id: string): Promise<Fetched<BlobAccount> | null> {
    return (await this.getBlobs([id]))[0];
  }

  /** Many blobs at once (null for closed / never opened) */
  async getBlobs(ids: string[]): Promise<(Fetched<BlobAccount> | null)[]> {
    const out: (Fetched<BlobAccount> | null)[] = [];
    for (let i = 0; i < ids.length; i += BLOB_READ_BATCH) {
      const slice = ids.slice(i, i + BLOB_READ_BATCH).map(lower);
      const raw = (await this.contract.getBlobs(slice)) as unknown[];
      raw.forEach((r, j) => {
        const data = decodeBlob(r, slice[j]);
        out.push(data ? { address: slice[j], data } : null);
      });
    }
    return out;
  }

  /** Whether `owner`'s data may be stored here (REPLICATE_OWNERS) */
  replicatesOwner(owner: string): boolean {
    return this.owners.length === 0 || this.owners.some((o) => o.toLowerCase() === owner.toLowerCase());
  }

  async getConfig(): Promise<ConfigAccount> {
    const [raw, admin] = await Promise.all([this.contract.getConfig(), this.contract.admin()]);
    return decodeConfig(raw, admin);
  }

  /**
   * The segment the open challenge of shard `index` asks for, computed by
   * the contract from the challenge block's hash; null while that block is
   * not old enough for BLOCKHASH (wait for the next one).
   */
  async challengeSegment(blob: string, index: number): Promise<number | null> {
    try {
      return Number(await this.contract.challengeSegment(lower(blob), index));
    } catch (err) {
      if (revertName(err) === 'ChallengeNotReady') return null;
      throw err;
    }
  }

  async claimableShardRewards(blob: string, index: number): Promise<bigint> {
    return BigInt(await this.contract.claimableShardRewards(lower(blob), index));
  }

  /** Take shard slot `index` of `blob` (this node stored and verified the shard) */
  async confirmShard(blob: string, index: number): Promise<string> {
    return (await this.send('confirmShard', [lower(blob), index], `confirmShard ${blob}#${index}`)).hash;
  }

  async createChallenge(blob: string, index: number): Promise<string> {
    return (await this.send('createChallenge', [lower(blob), index], `createChallenge ${blob}#${index}`)).hash;
  }

  /** Answer a challenge: the 1 KiB segment plus its Merkle path to the blob root */
  async proveShard(blob: string, index: number, segment: Uint8Array, shardProof: Uint8Array[], topProof: Uint8Array[]): Promise<string> {
    return (await this.send('proveShard', [lower(blob), index, segment, shardProof, topProof], `proveShard ${blob}#${index}`)).hash;
  }

  async failChallenge(blob: string, index: number): Promise<string> {
    return (await this.send('failChallenge', [lower(blob), index], `failChallenge ${blob}#${index}`)).hash;
  }

  async claimShardRewards(blob: string, index: number): Promise<string> {
    return (await this.send('claimShardRewards', [lower(blob), index], `claimShardRewards ${blob}#${index}`)).hash;
  }

  // ── Transactions ────────────────────────────────────────────────────────────

  /**
   * Confirm up to MAX_CONFIRMATIONS_PER_TX chunks in one transaction; the
   * contract pays each chunk's reward in it.  `confirmReplications` is
   * lenient: a chunk another node filled (or closed, or this node already
   * confirmed) is skipped instead of reverting the batch, so the outcome of
   * each chunk is read back from the receipt's ReplicationConfirmed events.
   */
  async confirmReplications(chunks: Fetched<ChunkAccount>[]): Promise<ConfirmBatchResult> {
    const ids = chunks.map((c) => lower(c.address));
    const mayClose = chunks.filter((c) => c.data.requiredReplicas - c.data.confirmedReplicas >= 2).length;
    const margin = BigInt(Math.max(0, mayClose - 1)) * LAST_CONFIRMATION_MARGIN;
    const label = ids.length === 1 ? `confirmReplications ${ids[0]}` : `confirmReplications of ${ids.length} chunks`;
    const result = await this.send('confirmReplications', [ids], label, margin);
    const me = this.wallet.address.toLowerCase();
    const confirmed = new Set<string>();
    for (const log of result.receipt.logs) {
      if (log.topics[0] !== REPLICATION_CONFIRMED || log.address.toLowerCase() !== this.contractAddress.toLowerCase()) continue;
      const parsed = monadbInterface.parseLog(log);
      if (parsed && String(parsed.args.replicator).toLowerCase() === me) confirmed.add(lower(parsed.args.chunk));
    }
    return { hash: result.hash, confirmed, fee: result.fee };
  }

  async updateEndpoint(endpoint: string): Promise<string> {
    return (await this.send('updateReplicatorEndpoint', [endpoint], 'updateReplicatorEndpoint')).hash;
  }

  /**
   * Estimate (plus `extraGas`), send and wait, one transaction at a time: the
   * wallet has one nonce sequence and the receipt arrives in ~1 block.
   * Contract errors surface as MonaDBTransactionError with `errorName`.
   */
  private send(method: string, args: unknown[], label: string, extraGas = 0n): Promise<TxResult> {
    const run = async () => {
      const request: TxRequest = {
        signer: this.wallet,
        to: this.contractAddress,
        data: monadbInterface.encodeFunctionData(method, args),
        label,
      };
      if (extraGas > 0n) request.gasLimit = (await this.sender.estimate(request)) + extraGas;
      return this.sender.send(request);
    };
    const next = this.txQueue.then(run, run);
    this.txQueue = next.catch(() => undefined);
    return next;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Replicator wallet (gas payer, reward recipient), checksummed */
  get address(): string {
    return this.wallet.address;
  }

  /** Network details for /status; the RPC URL is cut to its origin (API keys) */
  get network(): { network: string; chainId: number; rpcUrl: string; contract: string } {
    let rpcUrl = this.rpcUrl;
    try {
      rpcUrl = new URL(this.rpcUrl).origin;
    } catch {
      // not a URL; shown as configured
    }
    return { network: this.networkName, chainId: this.chainId, rpcUrl, contract: this.contractAddress };
  }

  /** MON balance of the replicator wallet (wei) */
  async getBalance(): Promise<bigint> {
    return this.provider.getBalance(this.wallet.address);
  }

  async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  /** The latest block's number and timestamp: what the contract compares deadlines to */
  async head(): Promise<{ block: number; time: bigint }> {
    const block = await this.provider.getBlock('latest');
    if (!block) throw new Error('The RPC returned no latest block');
    return { block: block.number, time: BigInt(block.timestamp) };
  }
}

function firstMissing(indexes: number[]): number {
  const have = new Set(indexes);
  let i = 0;
  while (have.has(i)) i++;
  return i;
}
