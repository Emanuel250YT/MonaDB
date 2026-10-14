import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAddress, hexlify } from 'ethers';
import { ChunkAccount, MAX_DIRECT_CHUNK_SIZE, MonaDBTransactionError, ReplicatorAccount } from '@monadb/sdk';
import { ReplicatorService, SETTLED_TTL_MS } from './replicator.service';
import { DEFAULT_BACKOFF } from './backoff';
import { ConfirmBatchResult, Fetched, MonadService } from '../monad/monad.service';
import { StorageService } from '../storage/storage.service';
import { FsChunkStore } from '../storage/fs-chunk-store.service';
import { FileMetadataService } from '../storage/file-metadata.service';

const newAddress = () => getAddress(hexlify(randomBytes(20)));
const newChunkId = () => hexlify(randomBytes(32));
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest();
const SEGMENT = 48 * 1024;

const peer = (authority: string, endpoint: string, active = true): ReplicatorAccount => ({
  authority,
  registered: true,
  active,
  registeredAt: 1n,
  confirmations: 0n,
  earned: 0n,
  endpoint,
});

/** A contract error the way the SDK's TransactionSender reports it */
const contractError = (name: string) => new MonaDBTransactionError('confirmReplications', name, new Error(name));

/**
 * In-memory stand-in for MonadService: the chunks of the contract, the bytes
 * their SegmentWritten events carry, this node's registration and the other
 * registered replicators.  Scans return snapshots, like an RPC would.
 * confirmReplications is lenient like the contract: chunks it cannot take
 * are skipped, not reverted.
 */
class FakeMonad {
  readonly address = newAddress();
  readonly maxConfirmationsPerTx = 8;
  readonly chunks = new Map<string, ChunkAccount>();
  readonly logs = new Map<string, Uint8Array>();
  replicator: ReplicatorAccount | null = peer(this.address, 'http://node');
  /** Every registered replicator (peers serving direct chunks) */
  peers: ReplicatorAccount[] = [];
  owners: string[] = [];
  /** Next confirmReplications outcome: sends normally when undefined */
  confirmError: Error | undefined;
  /** When set, scans keep returning this stale view (a lagging RPC) */
  frozen: Fetched<ChunkAccount>[] | null = null;
  hashes = 0;

  addChunk(bytes: Uint8Array, overrides: Partial<ChunkAccount> = {}): string {
    const id = newChunkId();
    const segments = Math.ceil(bytes.length / SEGMENT);
    this.chunks.set(id, {
      id,
      owner: newAddress(),
      contentHash: new Uint8Array(sha256(bytes)),
      writer: newAddress(),
      state: 'Hot',
      needsReplicas: true,
      reclaimed: false,
      requiredReplicas: 1,
      confirmedReplicas: 0,
      segmentSize: SEGMENT,
      segmentsTotal: segments,
      segmentsWritten: segments,
      size: bytes.length,
      rewardPerReplica: 50_000n,
      openedAt: 1_760_000_000n,
      completedAt: 1_760_000_010n,
      reclaimableAt: 1_760_003_600n,
      openedBlock: 100n,
      completedBlock: 104n,
      replicators: [],
      ...overrides,
    });
    this.logs.set(id, bytes);
    return id;
  }

  /** A direct chunk: no segments, waiting for replicas from the start, never on-chain */
  addDirect(bytes: Uint8Array, overrides: Partial<ChunkAccount> = {}): string {
    const id = this.addChunk(bytes, { segmentSize: 0, segmentsTotal: 0, segmentsWritten: 0, ...overrides });
    this.logs.delete(id);
    return id;
  }

  private snapshot(id: string): Fetched<ChunkAccount> {
    return { address: id, data: structuredClone(this.chunks.get(id)) };
  }

  replicatesOwner = (owner: string) => this.owners.length === 0 || this.owners.includes(owner);

  listChunksNeedingReplicas = jest.fn(async () => {
    if (this.frozen) return structuredClone(this.frozen);
    return [...this.chunks.keys()].filter((id) => this.chunks.get(id).needsReplicas).map((id) => this.snapshot(id));
  });

  getReplicator = jest.fn(async () => (this.replicator ? { ...this.replicator } : null));

  readChunk = jest.fn(async (id: string, chunk: ChunkAccount) => {
    const data = this.logs.get(id);
    if (!data) throw new Error('Segment 0 is missing from the logs');
    if (!sha256(data).equals(Buffer.from(chunk.contentHash))) throw new Error('Ledger segments do not match the chunk hash');
    return { data, block: 4242 };
  });

  /** Mirrors confirmReplications: skips what it cannot take, applies the rest */
  confirmReplications = jest.fn(async (batch: Fetched<ChunkAccount>[]): Promise<ConfirmBatchResult> => {
    if (this.confirmError) {
      const err = this.confirmError;
      this.confirmError = undefined;
      throw err;
    }
    const confirmed = new Set<string>();
    for (const { address } of batch) {
      const chunk = this.chunks.get(address);
      if (!chunk || chunk.reclaimed || chunk.confirmedReplicas >= chunk.requiredReplicas || chunk.replicators.includes(this.address)) continue;
      chunk.replicators.push(this.address);
      chunk.confirmedReplicas++;
      if (chunk.confirmedReplicas >= Math.max(1, Math.floor((chunk.requiredReplicas * 60) / 100))) chunk.state = 'Cool';
      if (chunk.confirmedReplicas === chunk.requiredReplicas) {
        // the last confirmation closes the chunk
        chunk.needsReplicas = false;
        this.chunks.delete(address);
      }
      confirmed.add(address);
    }
    return { hash: `sig${++this.hashes}`, confirmed, fee: 0n };
  });
  listReplicators = jest.fn(async () => structuredClone(this.peers));

  getChunk = jest.fn(async (id: string) => (this.chunks.has(id) ? this.snapshot(id) : null));
  getChunks = jest.fn(async (ids: string[]) => ids.map((id) => (this.chunks.has(id) ? this.snapshot(id) : null)));
  updateEndpoint = jest.fn(async () => 'hashEndpoint');
}

describe('ReplicatorService', () => {
  let dataDir: string;
  let monad: FakeMonad;
  let storage: StorageService;
  let now: number;

  const config = (replication: Record<string, unknown> = {}) =>
    new ConfigService({
      storage: { dataDir, chunkStore: 'fs', metadataStore: 'file' },
      replication: {
        pollIntervalMs: 1_000,
        concurrency: 3,
        minRewardWei: 0n,
        nodeEndpoint: 'http://node',
        updateEndpointOnStart: false,
        ...replication,
      },
    });

  /** A fresh service (= a node restart) over the same data directory */
  const replicatorWith = (replication: Record<string, unknown> = {}) => {
    if (replication.owners) monad.owners = replication.owners as string[];
    return new ReplicatorService(monad as unknown as MonadService, storage, config(replication));
  };

  /** Chunk ids of every confirmReplications call */
  const batches = () => monad.confirmReplications.mock.calls.map(([batch]) => batch.map((c) => c.address));

  beforeAll(() => Logger.overrideLogger(false));

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monadb-replicator-'));
    const cfg = config();
    const chunks = new FsChunkStore(cfg);
    const metadata = new FileMetadataService(cfg);
    await chunks.onModuleInit();
    await metadata.onModuleInit();
    storage = new StorageService(chunks, metadata, cfg);
    monad = new FakeMonad();
    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Batches leave only when full or at the end of a scan (the 250 ms timer never fires) */
  const holdBatchTimer = () =>
    jest.useFakeTimers({
      doNotFake: ['Date', 'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval'],
    });

  /** Peers answer from `routes` (bytes, or an HTTP status); other URLs are unreachable */
  const servePeers = (routes: Record<string, Uint8Array | number>) =>
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const route = routes[String(input)];
      if (route === undefined) throw new TypeError('fetch failed');
      return typeof route === 'number' ? new Response('not here', { status: route }) : new Response(new Uint8Array(route));
    });

  it('rebuilds a new chunk from the logs, stores it and confirms it', async () => {
    const bytes = randomBytes(100_000);
    const chunk = monad.addChunk(bytes);
    const replicator = replicatorWith();

    const stats = await replicator.scanOnce();

    expect(stats).toEqual({ seen: 1, candidates: 1, stored: 1, confirmed: 1, skipped: 0, errors: 0 });
    expect(await storage.getRawChunk(chunk)).toEqual(bytes);
    expect(batches()).toEqual([[chunk]]);
    expect(monad.chunks.has(chunk)).toBe(false); // the last confirmation closed it
    const meta = await storage.getChunkMeta(chunk);
    expect(meta).toMatchObject({
      chunkId: chunk,
      contentHash: sha256(bytes).toString('hex'),
      size: 100_000,
      state: 'Closed',
      confirmedReplicas: 1,
      replicators: [monad.address],
      rewardPerReplica: '50000',
      block: 4242,
      confirmSignature: 'sig1',
    });
    expect(meta.confirmedAt).toBeInstanceOf(Date);
    expect(replicator.status.totals).toMatchObject({ stored: 1, confirmed: 1, weiEarned: '50000', transactions: 1 });
  });

  it('skips chunks this node already confirmed (and only checks its copy once)', async () => {
    const bytes = randomBytes(2_000);
    const chunk = monad.addChunk(bytes, { requiredReplicas: 3, confirmedReplicas: 1, replicators: [] });
    monad.chunks.get(chunk).replicators.push(monad.address);
    await storage.storeChunk(
      { chunkId: chunk, owner: 'o', contentHash: sha256(bytes).toString('hex'), size: 2_000, requiredReplicas: 3,
        confirmedReplicas: 0, state: 'Hot', reclaimed: false, rewardPerReplica: '1', replicators: [], block: 1,
        uploadedAt: new Date(), storedAt: new Date(), confirmedAt: null, confirmSignature: null },
      bytes,
    );
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ seen: 1, candidates: 1, stored: 0, confirmed: 0, skipped: 0 });
    expect(await replicator.scanOnce()).toMatchObject({ seen: 1, candidates: 0 });
    expect(monad.readChunk).not.toHaveBeenCalled();
    expect(monad.confirmReplications).not.toHaveBeenCalled();
    // local state refreshed from the scan
    expect(await storage.getChunkMeta(chunk)).toMatchObject({ confirmedReplicas: 1, replicators: [monad.address] });
  });

  it('matches its own confirmations in any address case', async () => {
    const chunk = monad.addChunk(randomBytes(500), { requiredReplicas: 2, confirmedReplicas: 1 });
    monad.chunks.get(chunk).replicators.push(monad.address.toLowerCase());
    expect(await replicatorWith().scanOnce()).toMatchObject({ stored: 1, confirmed: 0, skipped: 0 });
    expect(monad.confirmReplications).not.toHaveBeenCalled();
  });

  it('re-fetches a chunk it confirmed earlier but lost locally, without confirming again', async () => {
    const chunk = monad.addChunk(randomBytes(500), { requiredReplicas: 2, confirmedReplicas: 1 });
    monad.chunks.get(chunk).replicators.push(monad.address);

    expect(await replicatorWith().scanOnce()).toMatchObject({ stored: 1, confirmed: 0, skipped: 0 });
    expect(monad.confirmReplications).not.toHaveBeenCalled();
    expect(await storage.hasChunk(chunk)).toBe(true);
  });

  it('stores but does not confirm chunks paying less than MIN_REWARD_WEI', async () => {
    const bytes = randomBytes(1_000);
    const chunk = monad.addChunk(bytes, { rewardPerReplica: 999n });
    const replicator = replicatorWith({ minRewardWei: 1_000n });

    expect(await replicator.scanOnce()).toMatchObject({ stored: 1, confirmed: 0, skipped: 1, errors: 0 });
    expect(await replicator.scanOnce()).toMatchObject({ stored: 0, confirmed: 0, skipped: 1, errors: 0 });
    expect(await storage.getRawChunk(chunk)).toEqual(bytes);
    expect(monad.readChunk).toHaveBeenCalledTimes(1); // idempotent: the stored copy is reused
    expect(monad.confirmReplications).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['inactive', { active: false }],
  ])('keeps the data but does not confirm while the registration is %s', async (_, replicator) => {
    const chunk = monad.addChunk(randomBytes(1_000));
    monad.replicator = replicator === null ? null : { ...monad.replicator, ...replicator };
    const service = replicatorWith();

    expect(await service.scanOnce()).toMatchObject({ stored: 1, confirmed: 0, skipped: 1 });
    expect(monad.confirmReplications).not.toHaveBeenCalled();
    expect(await storage.hasChunk(chunk)).toBe(true);

    // once (re)activated, the stored copy is confirmed without reading the logs again
    monad.replicator = peer(monad.address, 'http://node');
    expect(await service.scanOnce()).toMatchObject({ stored: 0, confirmed: 1 });
    expect(monad.readChunk).toHaveBeenCalledTimes(1);
  });

  it('reuses a verified copy after a restart and replaces a corrupt one', async () => {
    const bytes = randomBytes(3_000);
    const good = monad.addChunk(bytes, { rewardPerReplica: 1n });
    const bad = monad.addChunk(randomBytes(3_000), { rewardPerReplica: 1n });
    const skipAll = { minRewardWei: 10n };

    await replicatorWith(skipAll).scanOnce();
    expect(monad.readChunk).toHaveBeenCalledTimes(2);
    await storage.storeChunk((await storage.getChunkMeta(bad))!, Buffer.from('bit rot'));

    const restarted = replicatorWith(skipAll);
    expect(await restarted.scanOnce()).toMatchObject({ stored: 1, errors: 0 });
    expect(monad.readChunk).toHaveBeenCalledTimes(3);
    expect(monad.readChunk).toHaveBeenLastCalledWith(bad, expect.anything());
    expect(await storage.getRawChunk(good)).toEqual(bytes);
    expect(await storage.getRawChunk(bad)).toEqual(Buffer.from(monad.logs.get(bad)));
  });

  it.each([
    ['filled by other replicas', (chunk: ChunkAccount) => Object.assign(chunk, { confirmedReplicas: chunk.requiredReplicas })],
    ['reclaimed by its owner', (chunk: ChunkAccount) => Object.assign(chunk, { reclaimed: true })],
  ])('treats a chunk %s since the scan as nothing to do (skipped on-chain, no retry)', async (_, change) => {
    const chunk = monad.addChunk(randomBytes(100), { requiredReplicas: 2 });
    monad.frozen = await monad.listChunksNeedingReplicas();
    change(monad.chunks.get(chunk));
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ stored: 1, confirmed: 0, skipped: 1, errors: 0 });
    expect(replicator.backoff.get(chunk)).toBeUndefined();
    // settled: not sent again while the scan still lists it
    expect(await replicator.scanOnce()).toMatchObject({ candidates: 0 });
    expect(monad.confirmReplications).toHaveBeenCalledTimes(1);
  });

  it.each(['AlreadyReplicated', 'FullyReplicated', 'ReplicationClosed', 'ChunkNotFound'])(
    'treats a %s revert as nothing to do',
    async (name) => {
      const chunk = monad.addChunk(randomBytes(100));
      monad.confirmError = contractError(name);
      const replicator = replicatorWith();

      expect(await replicator.scanOnce()).toMatchObject({ stored: 1, confirmed: 0, skipped: 1, errors: 0 });
      expect(replicator.backoff.get(chunk)).toBeUndefined();
      expect(await replicator.scanOnce()).toMatchObject({ candidates: 0 });
    },
  );

  it('backs off other transaction errors and retries later', async () => {
    const chunk = monad.addChunk(randomBytes(100));
    monad.confirmError = contractError('ReplicatorInactive');
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ stored: 1, confirmed: 0, errors: 1 });
    expect(replicator.backoff.get(chunk)).toMatchObject({ kind: 'error', attempts: 1, retryAt: now + DEFAULT_BACKOFF.baseMs });
    expect(replicator.status.lastError).toContain('ReplicatorInactive');

    now += 5_000;
    expect(await replicator.scanOnce()).toMatchObject({ candidates: 0 });
    now += DEFAULT_BACKOFF.baseMs;
    expect(await replicator.scanOnce()).toMatchObject({ candidates: 1, stored: 0, confirmed: 1, errors: 0 });
    expect(replicator.backoff.get(chunk)).toBeUndefined();
  });

  it('does not confirm twice while a lagging scan still lists the chunk without this node', async () => {
    const chunk = monad.addChunk(randomBytes(100), { requiredReplicas: 2 });
    monad.frozen = await monad.listChunksNeedingReplicas(); // the RPC's view before our confirmation
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ confirmed: 1 });
    expect(await replicator.scanOnce()).toMatchObject({ candidates: 0, confirmed: 0 });

    // past the TTL the contract itself skips it (already confirmed): still not an error
    now += SETTLED_TTL_MS + 1;
    expect(await replicator.scanOnce()).toMatchObject({ confirmed: 0, skipped: 1, errors: 0 });
    expect(monad.confirmReplications).toHaveBeenCalledTimes(2);
    expect((await storage.getChunkMeta(chunk)).confirmSignature).toBe('sig1');
  });

  it('skips chunks with invalid logged data for an hour', async () => {
    const chunk = monad.addChunk(randomBytes(100));
    monad.logs.set(chunk, randomBytes(100)); // segments that do not hash to contentHash
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ stored: 0, errors: 1 });
    expect(replicator.backoff.get(chunk)).toMatchObject({ kind: 'invalid', retryAt: now + 60 * 60_000 });
    expect(await storage.hasChunk(chunk)).toBe(false);

    for (const step of [10_000, 10 * 60_000, 40 * 60_000]) {
      now += step;
      await replicator.scanOnce();
    }
    expect(monad.readChunk).toHaveBeenCalledTimes(1);

    now += 60 * 60_000;
    await replicator.scanOnce();
    expect(monad.readChunk).toHaveBeenCalledTimes(2);
    expect(replicator.status.backoff).toMatchObject({ invalid: 1, incomplete: 0, error: 0 });
  });

  it('backs off incomplete logs exponentially (10 s doubling, capped at 10 min)', async () => {
    const chunk = monad.addChunk(randomBytes(100));
    monad.logs.delete(chunk); // "Segment 0 is missing"
    const replicator = replicatorWith();
    const delays: number[] = [];

    for (let i = 0; i < 8; i++) {
      await replicator.scanOnce();
      const entry = replicator.backoff.get(chunk);
      delays.push(entry.retryAt - now);
      now = entry.retryAt;
    }
    expect(delays).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000]);
    expect(monad.readChunk).toHaveBeenCalledTimes(8);
    expect(replicator.status.backoff).toMatchObject({ invalid: 0, incomplete: 1, error: 0 });
    expect(replicator.status.backoff.chunks[0]).toMatchObject({ chunk, kind: 'incomplete', attempts: 8 });

    // the segment shows up: replicated, backoff cleared
    monad.logs.set(chunk, randomBytes(100));
    monad.chunks.get(chunk).contentHash = new Uint8Array(sha256(monad.logs.get(chunk)));
    expect(await replicator.scanOnce()).toMatchObject({ stored: 1, confirmed: 1 });
    expect(replicator.status.backoff).toMatchObject({ invalid: 0, incomplete: 0, error: 0, chunks: [] });
  });

  it('never works on the same chunk twice at once', async () => {
    monad.addChunk(randomBytes(100));
    let release: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = monad.readChunk.getMockImplementation();
    monad.readChunk.mockImplementationOnce(async (...args) => {
      await gate;
      return original(...args);
    });
    const replicator = replicatorWith();

    const first = replicator.scanOnce();
    await new Promise((r) => setImmediate(r));
    const second = await replicator.scanOnce(); // runs while the first is still reading
    release();
    expect(second).toMatchObject({ candidates: 0 });
    expect(await first).toMatchObject({ stored: 1, confirmed: 1 });
    expect(monad.readChunk).toHaveBeenCalledTimes(1);
  });

  it('refreshes stored chunks that leave the queue (Closed when the chunk is gone)', async () => {
    const chunk = monad.addChunk(randomBytes(100), { requiredReplicas: 2 });
    const replicator = replicatorWith();
    await replicator.scanOnce();
    expect((await storage.getChunkMeta(chunk)).state).toBe('Cool');

    // another replica completes it (the last confirmation closes it)
    monad.chunks.delete(chunk);
    await replicator.scanOnce();
    expect((await storage.getChunkMeta(chunk)).state).toBe('Closed');
    expect(monad.getChunks).toHaveBeenCalledWith([chunk]);
  });

  it('reconciles records left Hot while the node was down, once per run', async () => {
    const settledBytes = randomBytes(100);
    const settled = monad.addChunk(settledBytes, { requiredReplicas: 2 });
    const closed = monad.addChunk(randomBytes(100));
    await replicatorWith({ minRewardWei: 10n ** 9n }).scanOnce(); // stored, not confirmed: Hot
    expect((await storage.getChunkMeta(settled)).state).toBe('Hot');

    // while "down": other replicas move one chunk on (reclaimed by its owner), the other closes
    Object.assign(monad.chunks.get(settled), { needsReplicas: false, reclaimed: true, state: 'Cool', confirmedReplicas: 1, replicators: [newAddress()] });
    monad.chunks.delete(closed);

    const restarted = replicatorWith();
    await restarted.scanOnce();
    expect(await storage.getChunkMeta(settled)).toMatchObject({ state: 'Cool', confirmedReplicas: 1, reclaimed: true });
    expect((await storage.getChunkMeta(closed)).state).toBe('Closed');

    await restarted.scanOnce();
    expect(monad.getChunks).toHaveBeenCalledTimes(1);
  });

  it('keeps scanning after a failed scan', async () => {
    monad.listChunksNeedingReplicas.mockRejectedValueOnce(new Error('429 Too Many Requests'));
    (Date.now as jest.Mock).mockRestore();
    const replicator = replicatorWith({ pollIntervalMs: 100 });

    replicator.start();
    await new Promise((r) => setTimeout(r, 1_300));
    await replicator.stop();

    expect(monad.listChunksNeedingReplicas.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(replicator.status).toMatchObject({ running: false, lastError: '429 Too Many Requests' });
    expect(replicator.status.scans).toBeGreaterThanOrEqual(1);
  });

  // ── Batched confirmations ───────────────────────────────────────────────────

  it('confirms up to 8 chunks per transaction', async () => {
    holdBatchTimer();
    const chunks = Array.from({ length: 10 }, () => monad.addChunk(randomBytes(500)));
    const replicator = replicatorWith({ concurrency: 10 });

    expect(await replicator.scanOnce()).toMatchObject({ candidates: 10, stored: 10, confirmed: 10, errors: 0 });
    expect(batches().map((b) => b.length)).toEqual([8, 2]);
    expect(new Set(batches().flat())).toEqual(new Set(chunks));
    expect(replicator.status.totals).toMatchObject({ confirmed: 10, transactions: 2, weiEarned: '500000' });
    const hashes = await Promise.all(chunks.map(async (c) => (await storage.getChunkMeta(c)).confirmSignature));
    expect(new Set(hashes)).toEqual(new Set(['sig1', 'sig2']));
  });

  it('settles a chunk others completed meanwhile without holding up its batch', async () => {
    holdBatchTimer();
    const chunks = Array.from({ length: 3 }, () => monad.addChunk(randomBytes(500)));
    monad.frozen = await monad.listChunksNeedingReplicas();
    monad.chunks.delete(chunks[1]); // completed (and closed) by other replicas since the scan's view
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ candidates: 3, stored: 3, confirmed: 2, skipped: 1, errors: 0 });
    expect(monad.confirmReplications).toHaveBeenCalledTimes(1);
    expect(replicator.status.totals.transactions).toBe(1);
    for (const chunk of chunks) expect(replicator.backoff.get(chunk)).toBeUndefined();
    // the closed one is settled too: nothing is sent again while the scan lists it
    expect(await replicator.scanOnce()).toMatchObject({ candidates: 0 });
  });

  it('fails the whole batch on a transport error', async () => {
    holdBatchTimer();
    const chunks = Array.from({ length: 3 }, () => monad.addChunk(randomBytes(500)));
    monad.confirmError = new Error('no receipt after 60000 ms');
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ stored: 3, confirmed: 0, errors: 3 });
    expect(monad.confirmReplications).toHaveBeenCalledTimes(1);
    for (const chunk of chunks) expect(replicator.backoff.get(chunk)).toMatchObject({ kind: 'error', attempts: 1 });
  });

  // ── Direct chunks ───────────────────────────────────────────────────────────

  it('accepts a pushed direct chunk: stores it and confirms it', async () => {
    const bytes = randomBytes(5_000);
    const chunk = monad.addDirect(bytes);
    const owner = monad.chunks.get(chunk).owner;
    const replicator = replicatorWith();

    expect(await replicator.acceptPush(chunk, bytes)).toEqual({ status: 201, stored: true, confirmed: true, signature: 'sig1' });
    expect(monad.getChunk).toHaveBeenCalledWith(chunk);
    expect(batches()).toEqual([[chunk]]);
    expect(monad.chunks.has(chunk)).toBe(false); // the last confirmation closed it
    expect(await storage.getRawChunk(chunk)).toEqual(bytes);
    expect(await storage.getChunkMeta(chunk)).toMatchObject({
      owner,
      size: 5_000,
      state: 'Closed',
      confirmedReplicas: 1,
      replicators: [monad.address],
      block: null,
      confirmSignature: 'sig1',
    });
    expect(replicator.status).toMatchObject({
      pushes: { accepted: 1, rejected: 0 },
      totals: { stored: 1, confirmed: 1, weiEarned: '50000', transactions: 1 },
    });
    expect(await replicator.scanOnce()).toMatchObject({ seen: 0, errors: 0 });
  });

  it.each<[string, number, (bytes: Buffer) => { chunk: string; push: Buffer; owners?: string[] }]>([
    ['the bytes do not hash to the content hash', 400, (bytes) => ({ chunk: monad.addDirect(bytes), push: randomBytes(bytes.length) })],
    ['the size differs', 400, (bytes) => ({ chunk: monad.addDirect(bytes), push: bytes.subarray(1) })],
    ['the chunk is written to the logs', 409, (bytes) => ({ chunk: monad.addChunk(bytes), push: bytes })],
    ['the owner reclaimed the chunk', 409, (bytes) => ({ chunk: monad.addDirect(bytes, { reclaimed: true, needsReplicas: false }), push: bytes })],
    ['the chunk needs no more replicas', 409, (bytes) => ({ chunk: monad.addDirect(bytes, { needsReplicas: false }), push: bytes })],
    ['the chunk does not exist (yet)', 404, (bytes) => ({ chunk: newChunkId(), push: bytes })],
    ['the owner is not in REPLICATE_OWNERS', 403, (bytes) => ({ chunk: monad.addDirect(bytes), push: bytes, owners: [newAddress()] })],
    ['it is larger than 16 MiB', 413, () => ({ chunk: newChunkId(), push: Buffer.alloc(MAX_DIRECT_CHUNK_SIZE + 1) })],
  ])('rejects a push when %s (%i)', async (_, status, setup) => {
    const { chunk, push, owners } = setup(randomBytes(2_000));
    const replicator = replicatorWith(owners ? { owners } : {});

    await expect(replicator.acceptPush(chunk, push)).rejects.toMatchObject({ status });
    expect(await storage.hasChunk(chunk)).toBe(false);
    expect(monad.confirmReplications).not.toHaveBeenCalled();
    expect(replicator.status.pushes).toEqual({ accepted: 0, rejected: 1 });
  });

  it('answers a repeated push idempotently, also once the chunk closed', async () => {
    const bytes = randomBytes(3_000);
    const chunk = monad.addDirect(bytes, { requiredReplicas: 2 });
    const replicator = replicatorWith();

    expect(await replicator.acceptPush(chunk, bytes)).toMatchObject({ status: 201, confirmed: true });
    expect(await replicator.acceptPush(chunk, bytes)).toEqual({ status: 200, stored: true, confirmed: true });
    monad.chunks.delete(chunk); // another replica completed it
    expect(await replicator.acceptPush(chunk, bytes)).toEqual({ status: 200, stored: true, confirmed: true });
    await expect(replicator.acceptPush(chunk, randomBytes(3_000))).rejects.toMatchObject({ status: 404 });
    expect(monad.confirmReplications).toHaveBeenCalledTimes(1);
    expect(replicator.status.pushes).toEqual({ accepted: 3, rejected: 1 });
  });

  it('stores a pushed chunk it cannot confirm and says why', async () => {
    const bytes = randomBytes(1_000);
    const chunk = monad.addDirect(bytes, { rewardPerReplica: 10n });
    const replicator = replicatorWith({ minRewardWei: 1_000n });

    expect(await replicator.acceptPush(chunk, bytes)).toEqual({
      status: 201,
      stored: true,
      confirmed: false,
      reason: 'reward 10 wei < MIN_REWARD_WEI (1000)',
    });
    expect(await storage.getRawChunk(chunk)).toEqual(bytes);
    expect(monad.confirmReplications).not.toHaveBeenCalled();
  });

  it('copies a direct chunk from a peer: the replicators that confirmed it first, never itself', async () => {
    const bytes = randomBytes(4_000);
    const confirmedBy = newAddress();
    const chunk = monad.addDirect(bytes, { requiredReplicas: 3, confirmedReplicas: 1, replicators: [confirmedBy] });
    monad.peers = [
      peer(newAddress(), 'http://node/'), // a second registration with this node's endpoint
      peer(monad.address, 'http://self'),
      peer(newAddress(), 'http://good'),
      peer(newAddress(), 'http://inactive', false),
      peer(confirmedBy.toLowerCase(), 'http://liar/'),
    ];
    const fetchMock = servePeers({
      [`http://liar/chunk/${chunk}/data`]: randomBytes(4_000), // not the chunk: skipped
      [`http://good/chunk/${chunk}/data`]: bytes,
    });
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ candidates: 1, stored: 1, confirmed: 1, errors: 0 });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`http://liar/chunk/${chunk}/data`, `http://good/chunk/${chunk}/data`]);
    expect(monad.readChunk).not.toHaveBeenCalled();
    expect(await storage.getRawChunk(chunk)).toEqual(bytes);
    expect(await storage.getChunkMeta(chunk)).toMatchObject({ block: null, confirmedReplicas: 2, confirmSignature: 'sig1' });
  });

  it('retries a direct chunk no peer serves yet (incomplete), until its push arrives', async () => {
    const bytes = randomBytes(1_000);
    const chunk = monad.addDirect(bytes);
    monad.peers = [peer(newAddress(), 'http://a'), peer(newAddress(), 'http://b')];
    const fetchMock = servePeers({ [`http://a/chunk/${chunk}/data`]: 404 }); // b is unreachable
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ candidates: 1, stored: 0, confirmed: 0, errors: 1 });
    expect(replicator.backoff.get(chunk)).toMatchObject({ kind: 'incomplete', retryAt: now + DEFAULT_BACKOFF.baseMs });
    expect(replicator.status.lastError).toContain('not available from any peer yet (2 tried)');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await replicator.scanOnce()).toMatchObject({ candidates: 0 }); // backed off

    expect(await replicator.acceptPush(chunk, bytes)).toMatchObject({ status: 201, confirmed: true });
    expect(replicator.backoff.get(chunk)).toBeUndefined();
    expect(monad.readChunk).not.toHaveBeenCalled();
  });

  it('makes a push wait while a scan works on the same chunk', async () => {
    const bytes = randomBytes(1_000);
    const chunk = monad.addDirect(bytes);
    monad.peers = [peer(newAddress(), 'http://slow')];
    let release: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      await gate;
      return new Response('not here', { status: 404 });
    });
    const replicator = replicatorWith();

    const scan = replicator.scanOnce();
    while (fetchMock.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
    let answered = false;
    const push = replicator.acceptPush(chunk, bytes).finally(() => (answered = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(answered).toBe(false);

    release();
    expect(await scan).toMatchObject({ stored: 0, errors: 1 });
    expect(await push).toMatchObject({ status: 201, stored: true, confirmed: true });
    expect(monad.confirmReplications).toHaveBeenCalledTimes(1);
  });
});
