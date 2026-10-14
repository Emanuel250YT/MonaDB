import { FetchRequest, JsonRpcPayload, JsonRpcProvider, JsonRpcResult, Network } from 'ethers';

/**
 * Filter-based RPC methods.  Monad RPC endpoints answer them with "Method not
 * found", so MonaDB never depends on them.
 */
export const FORBIDDEN_RPC_METHODS = new Set([
  'eth_newFilter',
  'eth_newBlockFilter',
  'eth_newPendingTransactionFilter',
  'eth_getFilterChanges',
  'eth_getFilterLogs',
  'eth_uninstallFilter',
]);

export interface MonadProviderOptions {
  /** Polling interval for receipts and blocks (default 500 ms: Monad makes a block every 400 ms) */
  pollingIntervalMs?: number;
  /** Retries of a rate-limited (HTTP 429) or failed request (default 4) */
  retries?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * JsonRpcProvider tuned for Monad:
 *   • static network (no repeated eth_chainId probes),
 *   • `polling: true`, so ethers never falls back to eth_newFilter,
 *   • no response cache, so back-to-back reads see the newest block,
 *   • retries with backoff on HTTP 429 and network errors,
 *   • a hard guard that rejects filter methods before they hit the wire.
 */
export class MonadJsonRpcProvider extends JsonRpcProvider {
  private readonly retries: number;

  constructor(url: string | FetchRequest, chainId: number, options: MonadProviderOptions = {}) {
    const network = Network.from(chainId);
    super(url, network, {
      staticNetwork: network,
      polling: true,
      pollingInterval: options.pollingIntervalMs ?? 500,
      cacheTimeout: -1,
      batchMaxCount: 1,
    });
    this.retries = options.retries ?? 4;
  }

  async _send(payload: JsonRpcPayload | Array<JsonRpcPayload>): Promise<Array<JsonRpcResult>> {
    const requests = Array.isArray(payload) ? payload : [payload];
    for (const { method } of requests) {
      if (FORBIDDEN_RPC_METHODS.has(method)) {
        throw new Error(`${method} is not supported on Monad; use eth_getLogs or eth_call polling`);
      }
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await super._send(payload);
      } catch (err) {
        const e = err as { code?: string; message?: string; shortMessage?: string };
        const text = `${e.message ?? ''} ${e.shortMessage ?? ''}`;
        const transient = e.code === 'SERVER_ERROR' || e.code === 'TIMEOUT' || /429|rate limit|ECONNRESET|ETIMEDOUT|fetch failed/i.test(text);
        if (!transient || attempt >= this.retries) throw err;
        await sleep(Math.min(8_000, 400 * 2 ** attempt));
      }
    }
  }
}

/** A provider for a MonaDB deployment */
export function createMonadProvider(url: string, chainId: number, options?: MonadProviderOptions): MonadJsonRpcProvider {
  return new MonadJsonRpcProvider(url, chainId, options);
}
