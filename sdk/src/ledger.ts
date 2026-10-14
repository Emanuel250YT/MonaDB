import { getBytes, Provider } from 'ethers';
import { Hex32, monadbInterface } from './contract';
import { sha256 } from './crypto';
import { toHex } from './manifest';

/** One `SegmentWritten` event found in the logs */
export interface LedgerSegment {
  index: number;
  data: Uint8Array;
  blockNumber: number;
  transactionHash: string;
}

export interface ReadLedgerOptions {
  /** Blocks per eth_getLogs call (public Monad RPCs cap it at 100) */
  maxBlockRange?: number;
  /** Stop once this many distinct segments were found */
  segmentsTotal?: number;
  /** Highest block to look at (default: latest) */
  toBlock?: number;
  /** Stop once this returns true for the segments found so far (sorted by index) */
  until?: (segments: LedgerSegment[]) => boolean;
}

const SEGMENT_WRITTEN = monadbInterface.getEvent('SegmentWritten')!.topicHash;

/** Errors RPCs return when an eth_getLogs range is too large */
export function isRangeError(err: unknown): boolean {
  const e = err as { error?: { code?: number; message?: string }; message?: string; info?: { error?: { code?: number; message?: string } } };
  const code = e?.error?.code ?? e?.info?.error?.code;
  if (code === -32614 || code === -32602 || code === -32005) return true;
  const text = `${e?.message ?? ''} ${e?.error?.message ?? ''} ${e?.info?.error?.message ?? ''}`;
  return /block range|limited to|too many|query returned more than|exceed/i.test(text);
}

/**
 * Every `SegmentWritten` event of `chunk` from `fromBlock`, read with
 * eth_getLogs in windows (halved when the RPC rejects a range).  The contract
 * accepts each index once, so the result is unambiguous.
 */
export async function readSegments(
  provider: Provider,
  contract: string,
  chunk: Hex32,
  fromBlock: number,
  options: ReadLedgerOptions = {},
): Promise<LedgerSegment[]> {
  let range = Math.max(1, options.maxBlockRange ?? 100);
  const last = options.toBlock ?? (await provider.getBlockNumber());
  const found = new Map<number, LedgerSegment>();
  let from = fromBlock;
  while (from <= last) {
    const to = Math.min(from + range - 1, last);
    let logs;
    try {
      logs = await provider.getLogs({ address: contract, topics: [SEGMENT_WRITTEN, chunk], fromBlock: from, toBlock: to });
    } catch (err) {
      if (isRangeError(err) && range > 1) {
        range = Math.max(1, Math.floor(range / 2));
        continue;
      }
      throw err;
    }
    for (const log of logs) {
      const parsed = monadbInterface.parseLog(log);
      if (!parsed) continue;
      const index = Number(parsed.args.index);
      if (!found.has(index)) {
        found.set(index, { index, data: getBytes(parsed.args.data), blockNumber: log.blockNumber, transactionHash: log.transactionHash });
      }
    }
    if (options.segmentsTotal !== undefined && found.size >= options.segmentsTotal) break;
    if (options.until && found.size > 0 && options.until([...found.values()].sort((a, b) => a.index - b.index))) break;
    from = to + 1;
  }
  return [...found.values()].sort((a, b) => a.index - b.index);
}

/** Concatenate segments 0..n-1 and check the chunk's sha256 */
export function assembleChunk(segments: LedgerSegment[], contentHash: Uint8Array): Uint8Array {
  const sorted = [...segments].sort((a, b) => a.index - b.index);
  sorted.forEach((s, i) => {
    if (s.index !== i) throw new Error(`Missing ledger segment ${i}`);
  });
  const total = sorted.reduce((n, s) => n + s.data.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const s of sorted) {
    out.set(s.data, offset);
    offset += s.data.length;
  }
  if (toHex(sha256(out)) !== toHex(contentHash)) throw new Error('Ledger segments do not match the chunk hash');
  return out;
}

/**
 * Rebuild a ledger chunk from the logs.  `fromBlock` is the chunk's
 * `openedBlock` (or, once the chunk is closed, its record's `createdBlock`);
 * `segmentsTotal` stops the scan early when known.  Without it the scan goes
 * up to `maxBlocks` past `fromBlock` (default 20 000 blocks, ~2 h on Monad).
 */
export async function readChunkFromLedger(
  provider: Provider,
  contract: string,
  chunk: Hex32,
  contentHash: Uint8Array,
  fromBlock: number,
  { segmentsTotal, toBlock, maxBlocks = 20_000, maxBlockRange }: ReadLedgerOptions & { maxBlocks?: number } = {},
): Promise<Uint8Array> {
  const latest = await provider.getBlockNumber();
  const last = Math.min(toBlock ?? latest, fromBlock + maxBlocks, latest);
  // without the segment count, stop as soon as a complete prefix hashes to the chunk
  const complete = (found: LedgerSegment[]) => {
    if (found.some((s, i) => s.index !== i)) return false;
    try {
      assembleChunk(found, contentHash);
      return true;
    } catch {
      return false;
    }
  };
  const segments = await readSegments(provider, contract, chunk, fromBlock, {
    segmentsTotal,
    toBlock: last,
    maxBlockRange,
    until: segmentsTotal === undefined ? complete : undefined,
  });
  if (segments.length === 0) throw new Error(`No ledger segments for chunk ${chunk} in blocks ${fromBlock}–${last}`);
  return assembleChunk(segments, contentHash);
}
