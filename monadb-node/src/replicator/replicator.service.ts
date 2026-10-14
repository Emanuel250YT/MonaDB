import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { ChunkAccount, isDirect, MAX_DIRECT_CHUNK_SIZE, ReplicatorAccount } from '@monadb/sdk';
import { Fetched, MonadService } from '../monad/monad.service';
import { StorageService } from '../storage/storage.service';
import {
  chunkRecordFromAccount,
  ChunkStateUpdate,
  stateUpdateFromAccount,
  toHex,
} from '../storage/metadata-store';
import { BackoffSummary, ChunkBackoff } from './backoff';

/** Contract errors meaning there is nothing left for this node to do (ChunkNotFound: closed by the last confirmation) */
const SETTLED_ERRORS = new Set(['AlreadyReplicated', 'FullyReplicated', 'ReplicationClosed', 'ChunkNotFound']);

/**
 * After a confirmation, a lagging RPC may keep listing the chunk without this
 * node for a few blocks; it is skipped for this long instead of sending a
 * confirmation the contract would skip.
 */
export const SETTLED_TTL_MS = 120_000;

/** How long a queued confirmation waits for others to share its transaction */
export const CONFIRM_BATCH_DELAY_MS = 250;

/** Longest delay between scans after repeated scan failures */
const MAX_SCAN_BACKOFF_MS = 30_000;

/** Registered replicators (peer endpoints) are listed again after this long */
const PEERS_TTL_MS = 60_000;

/** Timeout of one direct-chunk download from a peer */
const PEER_TIMEOUT_MS = 30_000;

export interface ScanStats {
  /** Chunks that still need replicas */
  seen: number;
  /** Of those, chunks this node works on now (unconfirmed, or confirmed but not yet verified locally) */
  candidates: number;
  /** Rebuilt from the logs (direct chunks: copied from a peer) and stored */
  stored: number;
  /** Confirmations that landed */
  confirmed: number;
  /** Left unconfirmed: low reward, replicator missing / inactive, nothing to do */
  skipped: number;
  errors: number;
}

export interface ReplicatorStatus {
  running: boolean;
  pollIntervalMs: number;
  scans: number;
  lastScanAt: string | null;
  lastScanMs: number | null;
  lastScan: ScanStats | null;
  /**
   * Since the node started, scans and pushes (wei as a string);
   * `transactions` = confirmReplications transactions, several confirmations each
   */
  totals: {
    stored: number;
    confirmed: number;
    skipped: number;
    errors: number;
    weiEarned: string;
    transactions: number;
  };
  /** Direct chunks uploaders sent to this node (PUT /chunk/:id/data) */
  pushes: { accepted: number; rejected: number };
  inFlight: number;
  lastError: string | null;
  /** Chunks waiting out a retry delay, by failure kind */
  backoff: BackoffSummary;
}

/** Answer to a pushed direct chunk (PUT /chunk/:id/data) */
export interface PushResult {
  /** 201: stored by this push; 200: this node had already confirmed the chunk */
  status: 200 | 201;
  stored: boolean;
  /** This node's confirmation is on-chain */
  confirmed: boolean;
  /** The confirmReplications transaction this push triggered */
  signature?: string;
  /** Why the chunk is stored but not confirmed */
  reason?: string;
}

type ConfirmOutcome = { signature: string } | { settled: string };

/** A confirmation waiting for its batch */
interface QueuedConfirmation {
  chunk: Fetched<ChunkAccount>;
  resolve: (outcome: ConfirmOutcome) => void;
  reject: (err: unknown) => void;
}

const sha256Hex = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const syncKey = (c: ChunkAccount) => `${c.state}:${c.confirmedReplicas}:${c.reclaimed}`;
const trimSlash = (url: string) => url.trim().replace(/\/+$/, '');
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hasReplica = (chunk: ChunkAccount, node: string) => chunk.replicators.some((r) => sameAddress(r, node));
const emptyStats = (): ScanStats => ({ seen: 0, candidates: 0, stored: 0, confirmed: 0, skipped: 0, errors: 0 });

/** Name of a contract error that means "nothing to do", if `err` is one */
function settledError(err: unknown): string | undefined {
  const name = (err as { errorName?: unknown }).errorName;
  return typeof name === 'string' && SETTLED_ERRORS.has(name) ? name : undefined;
}

/** Best-paid chunks first, then the oldest */
function byPriority(a: Fetched<ChunkAccount>, b: Fetched<ChunkAccount>): number {
  if (a.data.rewardPerReplica !== b.data.rewardPerReplica) {
    return a.data.rewardPerReplica > b.data.rewardPerReplica ? -1 : 1;
  }
  return Number(a.data.completedAt - b.data.completedAt);
}

/** A response body, refused past `max` bytes: a peer cannot make the node buffer more than a chunk */
async function readCapped(response: Response, max: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length') ?? 0) > max) throw new Error(`body larger than ${max} bytes`);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error(`body larger than ${max} bytes`);
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/**
 * ReplicatorService
 *
 * Core replicator logic.  Every POLL_INTERVAL_MS it reads the contract's
 * work queue (`pendingChunks`: complete chunks still short of replicas) —
 * there is no event log or cursor to keep — and works on every chunk this
 * node has not confirmed yet, REPLICATION_CONCURRENCY at a time:
 *
 *   a) Get the bytes and check their sha256 (skipped when a verified copy is
 *      already stored): ledger chunks are rebuilt from their SegmentWritten
 *      events; direct chunks never touch the chain and are copied from a
 *      peer — the replicators that confirmed them first, then every other
 *      active replicator
 *   b) Store the bytes (chunk store, keyed by chunk id) + metadata
 *   c) Send confirmReplications — the contract pays the chunk's reward to
 *      this node in the same transaction — unless the reward is below
 *      MIN_REWARD_WEI or this node is not a registered, active replicator
 *      (the data is kept either way).  Confirmations share transactions: up
 *      to MAX_CONFIRMATIONS_PER_TX each, sent once that many are queued or
 *      after CONFIRM_BATCH_DELAY_MS.  The batch is lenient on-chain: a chunk
 *      other nodes filled meanwhile is skipped, not reverted.  The last
 *      confirmation closes the chunk.
 *
 * Uploaders also push direct chunks over HTTP (acceptPush).  The bytes are
 * kept only when they match a direct chunk someone paid for on-chain, then
 * stored and confirmed under the same rules.
 *
 * Skipped confirmations (AlreadyReplicated / FullyReplicated /
 * ReplicationClosed / a closed chunk) mean there is nothing left to do.  Other
 * failures are logged and retried with a per-chunk backoff (invalid logged
 * data: 1 h; missing segments, direct chunks no peer serves yet, RPC or
 * transaction errors: 10 s doubling up to 10 min).  The loop never stops on
 * an error.
 *
 * Local metadata (state, confirmations) is refreshed from every scan, after
 * each confirmation, when a stored chunk leaves the needs-replicas set, and
 * once per run for records left Hot while the node was down.
 */
@Injectable()
export class ReplicatorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReplicatorService.name);

  /** Chunks being rebuilt / pushed / confirmed right now; resolves when released */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Chunks with nothing left to do, until the scan shows it (epoch ms) */
  private readonly settled = new Map<string, number>();
  /** Chunks whose local copy this process wrote or verified */
  private readonly verified = new Set<string>();
  /** Replication state last written to the metadata store, per chunk */
  private readonly synced = new Map<string, string>();
  /** Skip reason already logged, per chunk */
  private readonly skipLogged = new Map<string, string>();
  /** Per-chunk retry schedule after failures */
  readonly backoff = new ChunkBackoff();
  /** Chunk ids returned by the previous scan */
  private previousScan = new Set<string>();
  /** Local records were checked against the chain once this run */
  private reconciled = false;
  /** This node's registration as of the last read (undefined: not read yet) */
  private replicator: ReplicatorAccount | null | undefined = undefined;
  private replicatorState: 'missing' | 'inactive' | 'active' | null = null;
  /** Registered replicators, for direct-chunk downloads */
  private peers: { list: ReplicatorAccount[]; at: number } | null = null;
  /** Confirmations waiting to share a transaction */
  private readonly confirmQueue: QueuedConfirmation[] = [];
  private confirmTimer: NodeJS.Timeout | null = null;

  private readonly pollIntervalMs: number;
  private readonly concurrency: number;
  private readonly minRewardWei: bigint;
  private readonly nodeEndpoint: string;
  private readonly updateEndpointOnStart: boolean;

  private running = false;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;

  private scans = 0;
  private lastScanAt: Date | null = null;
  private lastScanMs: number | null = null;
  private lastScan: ScanStats | null = null;
  private lastError: string | null = null;
  private readonly totals = { stored: 0, confirmed: 0, skipped: 0, errors: 0, weiEarned: 0n, transactions: 0 };
  private readonly pushes = { accepted: 0, rejected: 0 };

  constructor(
    private readonly monad: MonadService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {
    this.pollIntervalMs = this.config.get<number>('replication.pollIntervalMs');
    this.concurrency = Math.max(1, this.config.get<number>('replication.concurrency'));
    this.minRewardWei = this.config.get<bigint>('replication.minRewardWei') ?? 0n;
    this.nodeEndpoint = this.config.get<string>('replication.nodeEndpoint');
    this.updateEndpointOnStart = this.config.get<boolean>('replication.updateEndpointOnStart') ?? false;
  }

  async onApplicationBootstrap(): Promise<void> {
    const me = this.monad.address;
    const replicator = await this.monad.getReplicator();

    if (!replicator) {
      this.logger.warn(
        `${me} is not a registered replicator — chunks will be stored locally but not ` +
        `confirmed on-chain (the MonaDB admin must call registerReplicator)`,
      );
    } else {
      if (!replicator.active) {
        this.logger.warn(`Replicator ${me} is inactive — chunks will be stored but not confirmed`);
      }
      this.logger.log(
        `Replicator ${me}: endpoint ${replicator.endpoint}, ${replicator.confirmations} confirmations, ` +
        `${replicator.earned} wei earned`,
      );
      await this._syncEndpoint(replicator);
    }
    this._checkReplicator(replicator);

    this.start();
    this.logger.log(`ReplicatorService scanning chunks that need replicas every ${this.pollIntervalMs} ms`);
  }

  // ── Scan loop ───────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loop = this._run();
  }

  /** Stop scanning; resolves once the current scan and the pushes in progress finished */
  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    await this.loop;
    this._flushConfirmations();
    await Promise.all([...this.inFlight.values()]);
  }

  private async _run(): Promise<void> {
    let backoff = this.pollIntervalMs;
    while (this.running) {
      let delay = this.pollIntervalMs;
      try {
        await this.scanOnce();
        backoff = this.pollIntervalMs;
      } catch (err) {
        backoff = Math.min(Math.max(backoff * 2, 1000), Math.max(MAX_SCAN_BACKOFF_MS, this.pollIntervalMs));
        delay = backoff;
        this.lastError = message(err);
        this.totals.errors++;
        this.logger.error(`Chunk scan failed: ${message(err)} — retrying in ${delay} ms`);
      }
      if (!this.running) break;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, delay);
      });
    }
  }

  /**
   * One pass: list the chunks that need replicas and work on the ones this
   * node has not confirmed.  Throws only when the scan itself fails (RPC);
   * per-chunk failures are counted and backed off.
   */
  async scanOnce(): Promise<ScanStats> {
    const started = Date.now();
    const stats = emptyStats();
    const me = this.monad.address;

    const [chunks, replicator] = await Promise.all([
      this.monad.listChunksNeedingReplicas(),
      this.monad.getReplicator(),
    ]);
    stats.seen = chunks.length;
    this._checkReplicator(replicator);

    const now = Date.now();
    const current = new Set<string>(chunks.map((c) => c.address));
    for (const [chunk, at] of this.settled) {
      if (now - at > SETTLED_TTL_MS) this.settled.delete(chunk);
    }
    for (const chunk of this.skipLogged.keys()) {
      if (!current.has(chunk)) this.skipLogged.delete(chunk);
    }
    this.backoff.retain(current);

    const candidates: Fetched<ChunkAccount>[] = [];
    for (const chunk of chunks) {
      if (hasReplica(chunk.data, me)) {
        // Already confirmed by this node: refresh the local state, and check
        // once per run that the copy is really here (repaired if not)
        this.settled.delete(chunk.address);
        await this._syncState(chunk.address, chunk.data);
        if (this.verified.has(chunk.address)) continue;
      } else if (this.settled.has(chunk.address)) {
        continue;
      }
      if (this.inFlight.has(chunk.address) || this.backoff.isBlocked(chunk.address, now)) continue;
      candidates.push(chunk);
    }
    stats.candidates = candidates.length;

    candidates.sort(byPriority);
    let cursor = 0;
    const confirming: Promise<void>[] = [];
    const worker = async () => {
      while (cursor < candidates.length && !this.stopping) {
        await this._replicate(candidates[cursor++], replicator, stats, confirming);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, candidates.length) }, worker));
    // Nothing else of this scan joins the queue: send its confirmations now
    this._flushConfirmations();
    await Promise.all(confirming);

    const retryDeparted = await this._refreshDeparted(current, stats);
    this.previousScan = new Set([...current, ...retryDeparted]);
    if (!this.reconciled) this.reconciled = await this._reconcileStored(current, stats);
    // A chunk never needs replicas again once it left the set: keep the
    // per-chunk caches bounded by the scan size
    for (const id of this.verified) {
      if (!this.previousScan.has(id)) this.verified.delete(id);
    }
    for (const id of this.synced.keys()) {
      if (!this.previousScan.has(id)) this.synced.delete(id);
    }

    this.scans++;
    this.lastScanAt = new Date();
    this.lastScanMs = Date.now() - started;
    this.lastScan = stats;
    this._addTotals(stats);
    if (stats.stored || stats.confirmed || stats.errors) {
      this.logger.log(
        `Scan: ${stats.seen} chunks need replicas, ${stats.candidates} for this node — ` +
        `${stats.stored} stored, ${stats.confirmed} confirmed, ${stats.skipped} skipped, ${stats.errors} errors`,
      );
    }
    return stats;
  }

  get status(): ReplicatorStatus {
    return {
      running: this.running,
      pollIntervalMs: this.pollIntervalMs,
      scans: this.scans,
      lastScanAt: this.lastScanAt?.toISOString() ?? null,
      lastScanMs: this.lastScanMs,
      lastScan: this.lastScan,
      totals: { ...this.totals, weiEarned: this.totals.weiEarned.toString() },
      pushes: { ...this.pushes },
      inFlight: this.inFlight.size,
      lastError: this.lastError,
      backoff: this.backoff.summary(),
    };
  }

  // ── Replication core ────────────────────────────────────────────────────────

  private async _replicate(
    chunk: Fetched<ChunkAccount>,
    replicator: ReplicatorAccount | null,
    stats: ScanStats,
    confirming: Promise<void>[],
  ): Promise<void> {
    const id = chunk.address;
    if (this.inFlight.has(id)) return;
    const release = this._hold(id);
    let queued = false;

    try {
      // ── a + b) Bytes from the logs or a peer (sha256-checked) → chunk store
      if (await this._ensureStored(chunk)) stats.stored++;

      // ── c) Confirm on-chain unless it does not pay / this node cannot ──
      const reason = this._skipReason(chunk.data, replicator);
      if (hasReplica(chunk.data, this.monad.address)) {
        // confirmed earlier: the copy is back, nothing to send
      } else if (reason) {
        stats.skipped++;
        this._logSkip(id, reason, replicator?.active === true);
      } else {
        // Shares a transaction with other confirmations: the worker moves on
        // to the next chunk while this one waits for its batch
        queued = true;
        confirming.push(
          this._confirm(chunk, stats)
            .then(() => this.backoff.clear(id), (err) => this._onFailure(chunk, err, stats))
            .finally(release),
        );
        return;
      }
      this.backoff.clear(id);
    } catch (err) {
      this._onFailure(chunk, err, stats);
    } finally {
      if (!queued) release();
    }
  }

  /** Count a failed chunk and schedule its retry */
  private _onFailure(chunk: Fetched<ChunkAccount>, err: unknown, stats: ScanStats): void {
    const id = chunk.address;
    stats.errors++;
    this.lastError = `${id}: ${message(err)}`;
    const entry = this.backoff.fail(id, err);
    const retryIn = `retrying in ${Math.round((entry.retryAt - Date.now()) / 1000)} s`;
    if (entry.kind === 'invalid') {
      this.logger.warn(`Chunk ${id} has invalid logged data (${message(err)}) — ${retryIn}`);
    } else if (entry.kind === 'incomplete' && isDirect(chunk.data)) {
      // Its uploader is usually still pushing it: quiet until it stays missing
      const level = entry.attempts >= 4 ? 'warn' : 'debug';
      this.logger[level](`Direct chunk ${id} is ${message(err)} — ${retryIn}`);
    } else if (entry.kind === 'incomplete') {
      this.logger.warn(`Chunk ${id} is incomplete in the logs (${message(err)}) — ${retryIn}`);
    } else {
      this.logger.error(`Replication of ${id} failed: ${message(err)} — ${retryIn} (attempt ${entry.attempts})`);
    }
  }

  /**
   * Make sure a verified copy of the chunk is stored.  Returns true when it
   * had to be rebuilt from the logs (or copied from a peer).
   */
  private async _ensureStored(chunk: Fetched<ChunkAccount>): Promise<boolean> {
    const id = chunk.address;
    if (this.verified.has(id)) return false;

    // Stored by an earlier run: check it once instead of re-reading the logs
    const local = await this.storage.getRawChunk(id);
    if (local) {
      if (sha256Hex(local) === toHex(chunk.data.contentHash)) {
        if (!(await this.storage.getChunkMeta(id))) {
          await this.storage.upsertChunkMeta(chunkRecordFromAccount(id, chunk.data));
        }
        this.verified.add(id);
        await this._syncState(id, chunk.data);
        return false;
      }
      this.logger.warn(`Local copy of ${id} does not match its content hash — rebuilding it`);
      await this.storage.deleteChunk(id);
    }

    if (isDirect(chunk.data)) {
      // Never on-chain: another replicator (or the uploader's push) has it
      const { data, peer } = await this._fetchFromPeers(id, chunk.data);
      await this._store(id, chunk.data, data, null);
      this.logger.log(`Stored direct chunk ${id} (${data.length} bytes, owner ${chunk.data.owner}) from ${peer}`);
      return true;
    }

    const { data, block } = await this.monad.readChunk(id, chunk.data);
    await this._store(id, chunk.data, Buffer.from(data), block);
    this.logger.log(`Stored chunk ${id} (${data.length} bytes, owner ${chunk.data.owner}) from the logs`);
    return true;
  }

  /** Write verified bytes and their metadata */
  private async _store(id: string, data: ChunkAccount, bytes: Buffer, block: number | null): Promise<void> {
    await this.storage.storeChunk(chunkRecordFromAccount(id, data, { block, storedAt: new Date() }), bytes);
    this.verified.add(id);
    this.synced.set(id, syncKey(data));
  }

  private _skipReason(data: ChunkAccount, replicator: ReplicatorAccount | null): string | null {
    if (data.rewardPerReplica < this.minRewardWei) {
      return `reward ${data.rewardPerReplica} wei < MIN_REWARD_WEI (${this.minRewardWei})`;
    }
    if (!replicator) return 'this node is not a registered replicator';
    if (!replicator.active) return 'this replicator is inactive';
    return null;
  }

  /** Warn once per chunk (replicator-wide reasons are warned by _checkReplicator) */
  private _logSkip(id: string, reason: string, chunkSpecific: boolean): void {
    if (!chunkSpecific || this.skipLogged.get(id) === reason) {
      this.logger.debug(`Not confirming ${id}: ${reason}`);
      return;
    }
    this.skipLogged.set(id, reason);
    this.logger.warn(`Stored ${id} but not confirming it: ${reason}`);
  }

  private async _confirm(chunk: Fetched<ChunkAccount>, stats: ScanStats): Promise<ConfirmOutcome> {
    const id = chunk.address;
    let outcome: ConfirmOutcome;
    try {
      outcome = await this._queueConfirmation(chunk);
    } catch (err) {
      const name = settledError(err);
      if (!name) throw err;
      outcome = { settled: name };
    }
    if ('settled' in outcome) {
      // An earlier try of ours, or the other replicas, got there first
      stats.skipped++;
      this.settled.set(id, Date.now());
      this.logger.debug(`confirmReplications ${id}: ${outcome.settled} — nothing to do`);
      return outcome;
    }

    stats.confirmed++;
    this.totals.weiEarned += chunk.data.rewardPerReplica;
    this.settled.set(id, Date.now());
    this.skipLogged.delete(id);
    this.logger.log(`Confirmed replication of ${id} in ${outcome.signature}, earned ${chunk.data.rewardPerReplica} wei`);
    await this._recordConfirmation(id, chunk.data, outcome.signature);
    return outcome;
  }

  /** Metadata after this node's confirmation, read back from the contract */
  private async _recordConfirmation(id: string, before: ChunkAccount, signature: string): Promise<void> {
    try {
      const account = await this.monad.getChunk(id);
      const update: ChunkStateUpdate = account
        ? stateUpdateFromAccount(account.data)
        : {
          // The last confirmation (ours or another replica's) closed the chunk
          state: 'Closed',
          confirmedReplicas: before.confirmedReplicas + 1,
          replicators: [...before.replicators, this.monad.address],
        };
      await this.storage.updateReplicationState(id, {
        ...update,
        confirmedAt: new Date(),
        confirmSignature: signature,
      });
      this.synced.set(id, account ? syncKey(account.data) : 'Closed');
    } catch (err) {
      this.logger.warn(`Confirmed ${id} but could not record it locally: ${message(err)}`);
    }
  }

  // ── Batched confirmations ───────────────────────────────────────────────────

  /**
   * Queue a confirmation; resolves with the hash of the transaction that
   * carried it, or how it was skipped on-chain.  The queue goes out
   * MAX_CONFIRMATIONS_PER_TX at a time, or after CONFIRM_BATCH_DELAY_MS.
   */
  private _queueConfirmation(chunk: Fetched<ChunkAccount>): Promise<ConfirmOutcome> {
    return new Promise<ConfirmOutcome>((resolve, reject) => {
      this.confirmQueue.push({ chunk, resolve, reject });
      if (this.confirmQueue.length >= this.monad.maxConfirmationsPerTx) {
        this._flushConfirmations();
      } else if (!this.confirmTimer) {
        this.confirmTimer = setTimeout(() => this._flushConfirmations(), CONFIRM_BATCH_DELAY_MS);
      }
    });
  }

  /** Send every queued confirmation now */
  private _flushConfirmations(): void {
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    while (this.confirmQueue.length > 0) {
      void this._sendConfirmations(this.confirmQueue.splice(0, this.monad.maxConfirmationsPerTx));
    }
  }

  /**
   * One confirmReplications transaction for the whole batch.  The contract
   * skips (instead of reverting on) a chunk another node completed or closed
   * meanwhile, so each chunk's outcome is read from the receipt's events.  A
   * reverted or lost transaction fails the whole batch (retried after the
   * backoff).
   */
  private async _sendConfirmations(batch: QueuedConfirmation[]): Promise<void> {
    try {
      const result = await this.monad.confirmReplications(batch.map(({ chunk }) => chunk));
      this.totals.transactions++;
      for (const queued of batch) {
        const landed = result.confirmed.has(queued.chunk.address.toLowerCase());
        queued.resolve(landed ? { signature: result.hash } : { settled: 'Skipped' });
      }
    } catch (err) {
      for (const queued of batch) queued.reject(err);
    }
  }

  // ── Direct chunks ───────────────────────────────────────────────────────────

  /**
   * PUT /chunk/:id/data — an uploader (or anyone) sends the bytes of a
   * direct chunk.  They are kept only when they match a chunk someone paid
   * for: a direct chunk of the contract that still needs replicas (the push
   * follows the upload transaction right away), with the same size and
   * sha256.  Then it is stored like a chunk rebuilt from the logs and
   * confirmed under the scan's rules (MIN_REWARD_WEI, registered, active).
   *
   *   201  stored by this push: { stored, confirmed, signature?, reason? }
   *   200  this node had already confirmed it: { stored: true, confirmed: true }
   *   400  size or sha256 mismatch       403  owner outside REPLICATE_OWNERS
   *   404  no such chunk (yet: the uploader retries)
   *   409  not direct / reclaimed / no more replicas wanted
   *   413  above MAX_DIRECT_CHUNK_SIZE   503  shutting down / RPC unavailable
   */
  async acceptPush(id: string, bytes: Buffer): Promise<PushResult> {
    if (this.stopping) throw new ServiceUnavailableException('The node is shutting down');
    try {
      if (bytes.length > MAX_DIRECT_CHUNK_SIZE) {
        throw new PayloadTooLargeException(`A direct chunk is at most ${MAX_DIRECT_CHUNK_SIZE} bytes (got ${bytes.length})`);
      }
      // A scan or another push working on this chunk finishes first
      while (this.inFlight.has(id)) await this.inFlight.get(id);
      const release = this._hold(id);
      try {
        const result = await this._acceptPush(id, bytes);
        this.pushes.accepted++;
        return result;
      } finally {
        release();
      }
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() < 500) {
        this.pushes.rejected++;
        this.logger.debug(`Rejected a push of ${id}: ${err.message}`);
      }
      throw err;
    }
  }

  private async _acceptPush(id: string, bytes: Buffer): Promise<PushResult> {
    let chunk: Fetched<ChunkAccount> | null;
    try {
      chunk = await this.monad.getChunk(id);
    } catch (err) {
      this.logger.warn(`Could not read chunk ${id} for a push: ${message(err)}`);
      throw new ServiceUnavailableException('Could not read the chunk, retry later');
    }
    if (!chunk) {
      // The last confirmation closes the chunk: a retry of a push confirmed here
      const local = await this.storage.getChunkMeta(id);
      if (local?.confirmSignature && local.contentHash === sha256Hex(bytes) && (await this.storage.hasChunk(id))) {
        return { status: 200, stored: true, confirmed: true };
      }
      throw new NotFoundException(`Chunk ${id} does not exist (yet)`);
    }

    const data = chunk.data;
    const confirmedHere = hasReplica(data, this.monad.address);
    if (!this.monad.replicatesOwner(data.owner)) {
      throw new ForbiddenException(`This node does not replicate chunks of ${data.owner}`);
    }
    if (!isDirect(data)) throw new ConflictException(`Chunk ${id} is written to the logs, not pushed`);
    if (bytes.length !== data.size) {
      throw new BadRequestException(`Chunk ${id} is ${data.size} bytes, got ${bytes.length}`);
    }
    if (!confirmedHere && data.reclaimed) throw new ConflictException(`The owner closed chunk ${id} to new replicas`);
    if (!confirmedHere && !data.needsReplicas) throw new ConflictException(`Chunk ${id} needs no more replicas`);
    if (sha256Hex(bytes) !== toHex(data.contentHash)) {
      throw new BadRequestException(`The bytes do not match the content hash of chunk ${id}`);
    }

    const stats = emptyStats();
    try {
      if (!this.verified.has(id)) {
        await this._store(id, data, bytes, null);
        stats.stored++;
        this.logger.log(`Stored direct chunk ${id} (${bytes.length} bytes, owner ${data.owner}) pushed over HTTP`);
      }
      if (confirmedHere) return { status: 200, stored: true, confirmed: true };

      const replicator = await this._currentReplicator();
      const reason = this._skipReason(data, replicator);
      if (reason) {
        stats.skipped++;
        this._logSkip(id, reason, replicator?.active === true);
        return { status: 201, stored: true, confirmed: false, reason };
      }
      try {
        const outcome = await this._confirm(chunk, stats);
        this.backoff.clear(id);
        if ('settled' in outcome) {
          return { status: 201, stored: true, confirmed: outcome.settled === 'AlreadyReplicated', reason: outcome.settled };
        }
        // refreshed by the next scan once it leaves the needs-replicas set
        this.previousScan.add(id);
        return { status: 201, stored: true, confirmed: true, signature: outcome.signature };
      } catch (err) {
        // The bytes stay: the scan retries the confirmation after the backoff
        stats.errors++;
        this.lastError = `${id}: ${message(err)}`;
        const entry = this.backoff.fail(id, err);
        this.logger.error(`Stored pushed chunk ${id} but could not confirm it: ${message(err)} (attempt ${entry.attempts})`);
        return { status: 201, stored: true, confirmed: false, reason: `confirmReplications failed: ${message(err)}` };
      }
    } finally {
      this._addTotals(stats);
    }
  }

  /** Download a direct chunk from a peer; its size and sha256 must match the account */
  private async _fetchFromPeers(id: string, chunk: ChunkAccount): Promise<{ data: Buffer; peer: string }> {
    const peers = await this._peerEndpoints(chunk);
    const contentHash = toHex(chunk.contentHash);
    for (const peer of peers) {
      try {
        const response = await fetch(`${peer}/chunk/${id}/data`, { signal: AbortSignal.timeout(PEER_TIMEOUT_MS) });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await readCapped(response, chunk.size);
        if (data.length !== chunk.size || sha256Hex(data) !== contentHash) {
          throw new Error(`served ${data.length} bytes that are not the chunk`);
        }
        return { data, peer };
      } catch (err) {
        this.logger.debug(`Peer ${peer} has no valid copy of ${id}: ${message(err)}`);
      }
    }
    throw new Error(`not available from any peer yet (${peers.length} tried)`);
  }

  /**
   * Where a direct chunk can be downloaded: the replicators that confirmed
   * it first (they hold it), then every other active replicator.  Never this
   * node (its wallet or NODE_ENDPOINT); http(s) endpoints only.
   */
  private async _peerEndpoints(chunk: ChunkAccount): Promise<string[]> {
    if (!this.peers || Date.now() - this.peers.at > PEERS_TTL_MS) {
      this.peers = { list: await this.monad.listReplicators(), at: Date.now() };
    }
    const all = this.peers.list;
    const confirmed = chunk.replicators
      .map((authority) => all.find((p) => sameAddress(p.authority, authority)))
      .filter((p): p is ReplicatorAccount => p !== undefined);
    const others = all.filter((p) => p.active && !hasReplica(chunk, p.authority));

    const own = trimSlash(this.nodeEndpoint ?? '');
    const urls: string[] = [];
    for (const peer of [...confirmed, ...others]) {
      const url = trimSlash(peer.endpoint);
      if (sameAddress(peer.authority, this.monad.address) || url === own || urls.includes(url) || !/^https?:\/\/./i.test(url)) continue;
      urls.push(url);
    }
    return urls;
  }

  // ── Shared state ────────────────────────────────────────────────────────────

  /** Mark a chunk as worked on (scan or push); the returned function releases it */
  private _hold(id: string): () => void {
    let resolve!: () => void;
    this.inFlight.set(id, new Promise<void>((r) => (resolve = r)));
    return () => {
      this.inFlight.delete(id);
      resolve();
    };
  }

  private _addTotals(stats: ScanStats): void {
    this.totals.stored += stats.stored;
    this.totals.confirmed += stats.confirmed;
    this.totals.skipped += stats.skipped;
    this.totals.errors += stats.errors;
  }

  /** The registration as of the last scan (read now when no scan ran yet) */
  private async _currentReplicator(): Promise<ReplicatorAccount | null> {
    if (this.replicator === undefined) this._checkReplicator(await this.monad.getReplicator());
    return this.replicator;
  }

  // ── Local state refresh ─────────────────────────────────────────────────────

  /** Write the chain's replication state for a stored chunk when it changed */
  private async _syncState(id: string, data: ChunkAccount): Promise<void> {
    const key = syncKey(data);
    if (this.synced.get(id) === key) return;
    try {
      await this.storage.updateReplicationState(id, stateUpdateFromAccount(data));
      this.synced.set(id, key);
    } catch (err) {
      this.logger.warn(`Could not refresh the metadata of ${id}: ${message(err)}`);
    }
  }

  /**
   * Stored chunks that dropped out of the needs-replicas set (fully
   * replicated, reclaimed or closed) get a last refresh.  Returns the ones
   * that could not be fetched, to retry on the next scan.
   */
  private async _refreshDeparted(current: Set<string>, stats: ScanStats): Promise<string[]> {
    const departed = [...this.previousScan].filter((id) => !current.has(id) && this.synced.has(id));
    if (departed.length === 0) return [];
    try {
      const accounts = await this.monad.getChunks(departed);
      for (let i = 0; i < departed.length; i++) {
        const account = accounts[i];
        if (account) {
          await this._syncState(departed[i], account.data);
        } else if (this.synced.get(departed[i]) !== 'Closed') {
          await this.storage.updateReplicationState(departed[i], { state: 'Closed' });
          this.synced.set(departed[i], 'Closed');
        }
      }
      return [];
    } catch (err) {
      stats.errors++;
      this.logger.warn(`Could not refresh ${departed.length} settled chunks: ${message(err)}`);
      return departed;
    }
  }

  /**
   * Once per run: stored chunks still recorded as Hot that the scan no
   * longer lists moved on while the node was down (or it stopped between a
   * confirmation and its metadata write).  Refresh them from the chain.
   * Returns false to retry on the next scan.
   */
  private async _reconcileStored(current: Set<string>, stats: ScanStats): Promise<boolean> {
    try {
      const stale: string[] = [];
      for (let offset = 0; ; offset += 1000) {
        const page = await this.storage.queryChunks({
          filter: { state: 'Hot' },
          orderBy: 'chunkId',
          order: 'asc',
          limit: 1000,
          offset,
        });
        stale.push(...page.map((r) => r.chunkId).filter((id) => !current.has(id)));
        if (page.length < 1000) break;
      }
      if (stale.length === 0) return true;

      const accounts = await this.monad.getChunks(stale);
      for (let i = 0; i < stale.length; i++) {
        const update: ChunkStateUpdate = accounts[i] ? stateUpdateFromAccount(accounts[i].data) : { state: 'Closed' };
        await this.storage.updateReplicationState(stale[i], update);
      }
      this.logger.log(`Refreshed ${stale.length} stored chunks whose state changed while the node was down`);
      return true;
    } catch (err) {
      stats.errors++;
      this.logger.warn(`Could not reconcile stored chunks with the chain: ${message(err)}`);
      return false;
    }
  }

  // ── Replicator account ──────────────────────────────────────────────────────

  /** Log when the registration appears, disappears or changes activity */
  private _checkReplicator(replicator: ReplicatorAccount | null): void {
    this.replicator = replicator;
    const state = !replicator ? 'missing' : replicator.active ? 'active' : 'inactive';
    if (this.replicatorState !== null && state !== this.replicatorState) {
      if (state === 'active') {
        this.logger.log(`Replicator ${this.monad.address} is active — confirming stored chunks`);
      } else {
        this.logger.warn(`Replicator ${this.monad.address} is now ${state} — confirmations paused`);
      }
    }
    this.replicatorState = state;
  }

  /** UPDATE_ENDPOINT_ON_START: publish NODE_ENDPOINT when the on-chain one differs */
  private async _syncEndpoint(replicator: ReplicatorAccount): Promise<void> {
    if (replicator.endpoint === this.nodeEndpoint) return;
    if (!this.updateEndpointOnStart) {
      this.logger.warn(
        `On-chain endpoint ${replicator.endpoint} differs from NODE_ENDPOINT ${this.nodeEndpoint} ` +
        `(UPDATE_ENDPOINT_ON_START=true updates it)`,
      );
      return;
    }
    if (!this.nodeEndpoint || Buffer.byteLength(this.nodeEndpoint) > 128) {
      this.logger.warn(`NODE_ENDPOINT must be 1–128 bytes; on-chain endpoint left unchanged`);
      return;
    }
    try {
      const signature = await this.monad.updateEndpoint(this.nodeEndpoint);
      this.logger.log(`On-chain endpoint updated to ${this.nodeEndpoint} in ${signature}`);
    } catch (err) {
      this.logger.warn(`Could not update the on-chain endpoint: ${message(err)}`);
    }
  }
}
