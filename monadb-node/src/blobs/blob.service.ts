import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BlobAccount,
  blobProof,
  blobRoot,
  ConfigAccount,
  depth,
  MerkleTree,
  packHashes,
  rebuildShardFragment,
  rewardBetween,
  ShardHasher,
  unpackHashes,
  VACANT,
  verifyFragment,
} from '@monadb/sdk';
import { Fetched, MonadService } from '../monad/monad.service';
import { BLOB_STORE, BlobStore } from '../storage/blob-store';
import { StorageService } from '../storage/storage.service';
import { BlobShardRecord } from '../storage/metadata-store';

const SEGMENT = 1024;
/** Pushes not continued for this long are dropped (staged bytes and hashing state) */
const ABANDONED_PUSH_MS = 60 * 60 * 1000;
const MIN_FRAGMENT = 1024;
const MAX_FRAGMENT = 1024 * 1024;
/** Largest body of one PUT /blob/:blob/shard/:index (the SDK sends 8 MiB) */
export const MAX_SHARD_REQUEST = 16 * 1024 * 1024;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const fromHex = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isVacant = (holder: string) => sameAddress(holder, VACANT);

/** The chain's head: deadlines are compared to its block number and timestamp */
interface Head {
  block: bigint;
  time: bigint;
}

/** Public, verifiable description of a blob this node holds a shard of */
export interface BlobInfo {
  blob: string;
  root: string;
  dataShards: number;
  totalShards: number;
  shardSize: number;
  fragmentSize: number;
  /** Shard roots r_0…r_{n-1} (hex); blobRoot(roots) is the on-chain root */
  roots: string[];
}

export interface PushResult {
  status: 201 | 202 | 200;
  received: number;
  stored?: boolean;
  confirmed?: boolean;
  signature?: string;
  reason?: string;
}

interface Incoming {
  /** Last append (epoch ms) */
  touchedAt: number;
  hasher: ShardHasher;
  roots: Uint8Array[];
  fragmentSize: number;
  shardSize: number;
  received: number;
}

export interface BlobStatus {
  held: number;
  incoming: number;
  totals: {
    pushesStored: number;
    rebuilt: number;
    confirmed: number;
    proofs: number;
    claims: number;
    weiClaimed: string;
    challengesSent: number;
    challengesWon: number;
    lost: number;
    errors: number;
  };
  lastError: string | null;
}

/**
 * BlobService
 *
 * The node's side of erasure-coded blobs (docs/blob-protocol.md):
 *
 *   • receives shards pushed by uploaders (resumable appends), checks them
 *     against the shard roots and the on-chain blob root, stores them and
 *     takes the slot with confirmShard;
 *   • serves fragments with their Merkle proof, so readers verify each
 *     fragment on its own;
 *   • every BLOB_POLL_INTERVAL_MS: answers challenges on the shards it holds
 *     (before their deadline block), challenges itself and claims its rewards
 *     when enough accrued, drops shards it lost or that expired, rebuilds a
 *     vacant slot of a blob from k other holders, and optionally challenges
 *     other holders (bounty when they fail).
 */
@Injectable()
export class BlobService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BlobService.name);
  private readonly incoming = new Map<string, Incoming>();
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Merkle trees of held shards (LRU), so a fragment proof costs O(log N) instead of O(N) */
  private readonly treeCache = new Map<string, { tree: MerkleTree; bytes: number }>();
  private readonly treeLoads = new Map<string, Promise<MerkleTree>>();
  private treeCacheBytes = 0;
  private heldCount = 0;
  private config: ConfigAccount | null = null;
  private endpoints = new Map<string, string>();
  private endpointsAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private busy = false;
  private lastError: string | null = null;
  private readonly totals = {
    pushesStored: 0,
    rebuilt: 0,
    confirmed: 0,
    proofs: 0,
    claims: 0,
    weiClaimed: 0n,
    challengesSent: 0,
    challengesWon: 0,
    lost: 0,
    errors: 0,
  };

  private readonly pollIntervalMs: number;
  private readonly repair: boolean;
  private readonly challengeOthers: boolean;
  private readonly challengeIntervalMs: number;
  private readonly claimMinWei: bigint;
  private readonly minRewardWei: bigint;
  private readonly nodeEndpoint: string;
  private readonly leafCacheLimit: number;
  private readonly maxShardBytes: number;
  private lastChallengeRound = 0;

  constructor(
    private readonly monad: MonadService,
    private readonly storage: StorageService,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
    private readonly configService: ConfigService,
  ) {
    this.pollIntervalMs = this.configService.get<number>('blobs.pollIntervalMs') ?? 10_000;
    this.repair = this.configService.get<boolean>('blobs.repair') ?? true;
    this.challengeOthers = this.configService.get<boolean>('blobs.challengeOthers') ?? false;
    this.challengeIntervalMs = this.configService.get<number>('blobs.challengeIntervalMs') ?? 600_000;
    this.claimMinWei = this.configService.get<bigint>('blobs.claimMinWei') ?? 50_000_000_000_000_000n;
    this.minRewardWei = this.configService.get<bigint>('replication.minRewardWei') ?? 0n;
    this.nodeEndpoint = (this.configService.get<string>('replication.nodeEndpoint') ?? '').replace(/\/$/, '');
    this.leafCacheLimit = this.configService.get<number>('blobs.leafCacheBytes') ?? 256 * 1024 * 1024;
    this.maxShardBytes = this.configService.get<number>('blobs.maxShardBytes') ?? 2 * 1024 * 1024 * 1024;
  }

  onApplicationBootstrap(): void {
    if (this.configService.get<boolean>('blobs.enabled') === false) return;
    this.running = true;
    this.schedule(1_000);
    this.logger.log(
      `BlobService: maintenance every ${this.pollIntervalMs} ms (repair ${this.repair ? 'on' : 'off'}, ` +
        `challenging others ${this.challengeOthers ? 'on' : 'off'})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
  }

  get status(): BlobStatus {
    return {
      held: this.heldCount,
      incoming: this.incoming.size,
      totals: { ...this.totals, weiClaimed: this.totals.weiClaimed.toString() },
      lastError: this.lastError,
    };
  }

  // ── HTTP: pushes ────────────────────────────────────────────────────────────

  /**
   * PUT /blob/:blob/shard/:index?offset=N — append shard bytes.  The first
   * request (offset 0) carries the shard roots and the fragment size; the
   * last one completes the shard, which is verified, stored and confirmed.
   */
  async acceptPush(
    blob: string,
    index: number,
    offset: number,
    bytes: Buffer,
    header: { roots?: string; fragmentSize?: string },
  ): Promise<PushResult> {
    return this.withLock(this.key(blob, index), () => this._acceptPush(blob, index, offset, bytes, header));
  }

  private async _acceptPush(
    blob: string,
    index: number,
    offset: number,
    bytes: Buffer,
    header: { roots?: string; fragmentSize?: string },
  ): Promise<PushResult> {
    if (bytes.length > MAX_SHARD_REQUEST) throw new PayloadTooLargeException(`At most ${MAX_SHARD_REQUEST} bytes per request`);
    const [account, head] = await Promise.all([this.monad.getBlob(blob), this.head()]);
    if (!account) throw new NotFoundException(`Blob ${blob} does not exist (yet)`);
    const data = account.data;
    if (!this.monad.replicatesOwner(data.owner)) throw new ForbiddenException(`This node does not store blobs of ${data.owner}`);
    if (index >= data.totalShards) throw new BadRequestException(`Shard index ${index} ≥ ${data.totalShards}`);
    const me = this.monad.address;
    const slot = data.slots[index];
    const key = this.key(blob, index);
    if (sameAddress(slot.holder, me)) {
      const local = await this.storage.getBlobShard(blob, index);
      if (local && (local.state === 'Confirmed' || local.state === 'Stored')) {
        return { status: 200, received: Number(data.shardSize), stored: true, confirmed: true };
      }
    }
    if (!isVacant(slot.holder) && !sameAddress(slot.holder, me)) throw new ConflictException(`Shard ${index} already has a holder`);
    const other = data.slots.findIndex((s, i) => sameAddress(s.holder, me) && i !== index);
    if (other >= 0) throw new ConflictException(`This node already holds shard ${other} of the blob`);
    if (head.time >= data.expiresAt) throw new ConflictException('The blob has expired');
    if (data.shardSize > BigInt(this.maxShardBytes)) {
      throw new PayloadTooLargeException(`This node stores shards of at most ${this.maxShardBytes} bytes (BLOB_MAX_SHARD_BYTES)`);
    }

    const shardSize = Number(data.shardSize);
    let state = this.incoming.get(key);
    if (offset === 0) {
      const parts = (header.roots ?? '').split(',').map((r) => r.trim()).filter(Boolean);
      if (parts.some((r) => !/^[0-9a-f]{64}$/i.test(r))) throw new BadRequestException('x-monadb-shard-roots must be 64-character hex roots');
      const roots = parts.map(fromHex);
      if (roots.length !== data.totalShards || roots.some((r) => r.length !== 32)) {
        throw new BadRequestException(`x-monadb-shard-roots must list ${data.totalShards} hex roots`);
      }
      if (hex(blobRoot(roots)) !== hex(data.root)) throw new BadRequestException('The shard roots do not match the blob root');
      const fragmentSize = Number(header.fragmentSize);
      if (!isFragmentSize(fragmentSize, shardSize)) {
        throw new BadRequestException('x-monadb-fragment-size must be a power of two between 1 KiB and 1 MiB dividing the shard');
      }
      await this.blobs.discardStaged(key);
      state = { touchedAt: Date.now(), hasher: new ShardHasher(), roots, fragmentSize, shardSize, received: 0 };
      this.incoming.set(key, state);
    } else if (!state || state.received !== offset) {
      throw new ConflictException(`Expected offset ${state?.received ?? 0}; restart the shard from offset 0`);
    }
    if (offset + bytes.length > shardSize) throw new BadRequestException(`The shard is ${shardSize} bytes`);

    state.received = await this.blobs.stageAppend(key, offset, bytes);
    state.touchedAt = Date.now();
    state.hasher.update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (state.received < shardSize) return { status: 202, received: state.received };

    this.incoming.delete(key);
    const root = state.hasher.root();
    if (hex(root) !== hex(state.roots[index])) {
      await this.blobs.discardStaged(key);
      throw new BadRequestException(`Shard ${index} does not hash to its root`);
    }
    await this.commitShard(blob, index, data, state.hasher.leafHashes(), state.roots, state.fragmentSize);
    this.totals.pushesStored++;
    this.logger.log(`Stored shard ${index} of blob ${blob} (${shardSize} bytes) pushed by its uploader`);
    const confirmation = await this.confirm(blob, index, data);
    return { status: 201, received: shardSize, stored: true, ...confirmation };
  }

  // ── HTTP: reads ─────────────────────────────────────────────────────────────

  async info(blob: string): Promise<BlobInfo> {
    const shards = await this.storage.listBlobShards({ blob, limit: 1 });
    const record = shards[0];
    const packed = await this.blobs.getObject(this.rootsKey(blob));
    if (!record || !packed) throw new NotFoundException(`This node holds no shard of ${blob}`);
    return {
      blob,
      root: record.root,
      dataShards: record.dataShards,
      totalShards: record.totalShards,
      shardSize: record.shardSize,
      fragmentSize: record.fragmentSize ?? 0,
      roots: unpackHashes(new Uint8Array(packed)).map(hex),
    };
  }

  /** One fragment of a shard this node holds, with its proof to the shard root */
  async fragment(blob: string, index: number, stripe: number): Promise<{ data: Buffer; proof: string[] }> {
    const record = await this.storage.getBlobShard(blob, index);
    if (!record || !record.fragmentSize || (record.state !== 'Confirmed' && record.state !== 'Stored')) {
      throw new NotFoundException(`This node holds no shard ${index} of ${blob}`);
    }
    const stripes = record.shardSize / record.fragmentSize;
    if (!Number.isInteger(stripe) || stripe < 0 || stripe >= stripes) throw new BadRequestException(`Stripe out of range (0–${stripes - 1})`);
    const key = this.key(blob, index);
    const data = await this.blobs.readRange(key, stripe * record.fragmentSize, record.fragmentSize);
    if (!data) throw new NotFoundException(`Shard ${index} of ${blob} is missing`);
    const tree = await this.shardTree(key);
    return { data, proof: tree.fragmentProof(record.fragmentSize / SEGMENT, stripe).map(hex) };
  }

  // ── Maintenance loop ────────────────────────────────────────────────────────

  private schedule(delay = this.pollIntervalMs): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    this.busy = true;
    try {
      await this.pruneAbandoned();
      this.config = (await this.monad.getConfig()) ?? this.config;
      if (this.config && this.config.epochSeconds > 0n) {
        await this.maintainHoldings();
        if (this.repair) await this.repairOne();
        if (this.challengeOthers && Date.now() - this.lastChallengeRound >= this.challengeIntervalMs) {
          this.lastChallengeRound = Date.now();
          await this.challengeRound();
        }
      }
    } catch (err) {
      this.totals.errors++;
      this.lastError = message(err);
      this.logger.warn(`Blob maintenance failed: ${message(err)}`);
    } finally {
      this.busy = false;
      this.schedule();
    }
  }

  /** Answer challenges, prove + claim when due, drop shards lost or expired */
  async maintainHoldings(): Promise<void> {
    const held: BlobShardRecord[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.storage.listBlobShards({ state: 'Confirmed', limit: 500, offset });
      held.push(...page);
      if (page.length < 500) break;
    }
    this.heldCount = held.length;
    if (held.length === 0) return;
    const config = this.config!;
    const me = this.monad.address;
    const head = await this.head();
    for (let i = 0; i < held.length; i += 100) {
      const batch = held.slice(i, i + 100);
      const accounts = await this.monad.getBlobs(batch.map((r) => r.blob));
      for (let j = 0; j < batch.length; j++) {
        const record = batch[j];
        const blob = record.blob;
        const account = accounts[j];
        try {
          if (!account) {
            await this.drop(record, 'Expired', 'the blob was closed');
            continue;
          }
          const slot = account.data.slots[record.index];
          if (!slot || !sameAddress(slot.holder, me)) {
            this.totals.lost++;
            await this.drop(record, 'Lost', 'this node no longer holds the slot (a challenge went unanswered)');
            continue;
          }
          await this.maintainSlot(blob, record.index, account, config, head);
        } catch (err) {
          this.totals.errors++;
          this.lastError = `${blob}#${record.index}: ${message(err)}`;
          this.logger.warn(`Blob ${blob} shard ${record.index}: ${message(err)}`);
        }
      }
    }
  }

  private async maintainSlot(
    blob: string,
    index: number,
    account: Fetched<BlobAccount>,
    config: ConfigAccount,
    head: Head,
  ): Promise<void> {
    const data = account.data;
    const slot = data.slots[index];
    const now = head.time;

    // 1. An open challenge: answer once its block is old enough for BLOCKHASH, before the deadline
    if (slot.challengeBlock !== 0n) {
      if (head.block > slot.challengeBlock && head.block <= slot.challengeDeadline) await this.prove(blob, index, data);
      return;
    }

    // 2. Rewards: they unlock up to the last proof, so prove before claiming
    const until = slot.provenAt < data.expiresAt ? slot.provenAt : data.expiresAt;
    const claimable = rewardBetween(data, config.epochSeconds, slot.claimedUntil, until);
    const end = now < data.expiresAt ? now : data.expiresAt;
    const unproven = rewardBetween(data, config.epochSeconds, slot.provenAt, end);
    const expired = now >= data.expiresAt;
    const cooldownOver = now >= slot.lastChallengeAt + config.challengeCooldown;
    const grace = data.expiresAt + config.epochSeconds;
    // Claim what the last proof unlocked before proving again
    const payable = claimable > data.escrow ? data.escrow : claimable;
    if (payable > 0n && (payable >= this.claimMinWei || expired)) {
      const signature = await this.monad.claimShardRewards(blob, index);
      this.totals.claims++;
      this.totals.weiClaimed += payable;
      await this.storage.updateBlobShard(blob, index, { claimedUntil: new Date(Number(until) * 1000) });
      this.logger.log(`Claimed ${payable} wei for shard ${index} of ${blob} in ${signature}`);
      return;
    }
    if ((unproven >= this.claimMinWei || (expired && slot.provenAt < data.expiresAt)) && cooldownOver && now < grace) {
      await this.monad.createChallenge(blob, index);
      this.logger.log(`Challenged my own shard ${index} of ${blob} to unlock ${unproven} wei`);
      return; // answered on a later tick, once the challenge block is old enough
    }

    // 3. One epoch after expiry the owner may close the blob: nothing left to earn
    if (expired && now >= grace && payable === 0n) {
      await this.drop((await this.storage.getBlobShard(blob, index))!, 'Expired', 'the blob expired');
    }
  }

  private async prove(blob: string, index: number, data: BlobAccount): Promise<void> {
    // The contract picks the segment from the challenge block's hash
    const segment = await this.monad.challengeSegment(blob, index);
    if (segment === null) {
      this.logger.debug(`Challenge of ${blob}#${index} is not ready yet (its block is too recent for BLOCKHASH)`);
      return;
    }
    const key = this.key(blob, index);
    const bytes = await this.blobs.readRange(key, segment * SEGMENT, SEGMENT);
    const packedRoots = await this.blobs.getObject(this.rootsKey(blob));
    if (!bytes || !packedRoots) throw new Error(`shard ${index} of ${blob} is missing locally; cannot answer the challenge`);
    const tree = await this.shardTree(key);
    const roots = unpackHashes(new Uint8Array(packedRoots));
    const signature = await this.monad.proveShard(blob, index, new Uint8Array(bytes), tree.proof(segment), blobProof(roots, index));
    this.totals.proofs++;
    await this.storage.updateBlobShard(blob, index, { provenAt: new Date() });
    this.logger.log(`Proved shard ${index} of ${blob} (segment ${segment}) in ${signature}`);
  }

  /** Rebuild one vacant slot of a blob that needs holders, from k other holders */
  async repairOne(): Promise<boolean> {
    const me = this.monad.address;
    const [pending, head] = await Promise.all([this.monad.listBlobsNeedingHolders(), this.head()]);
    const now = head.time;
    const candidates = pending.filter((b) => {
      const d = b.data;
      if (now >= d.expiresAt || d.held < d.dataShards || d.shardSize > BigInt(this.maxShardBytes)) return false;
      if (d.slots.some((s) => sameAddress(s.holder, me))) return false;
      const remaining = (d.expiresAt - now) * d.rewardPerShardEpoch / (this.config!.epochSeconds || 1n);
      return remaining >= this.minRewardWei;
    });
    for (const blob of candidates) {
      const index = blob.data.slots.findIndex((s) => isVacant(s.holder));
      if (index < 0 || this.incoming.has(this.key(blob.address, index))) continue;
      if (await this.storage.getBlobShard(blob.address, index)) continue;
      try {
        await this.withLock(this.key(blob.address, index), () => this.rebuild(blob, index));
        return true;
      } catch (err) {
        this.totals.errors++;
        this.lastError = `${blob.address}#${index}: ${message(err)}`;
        this.logger.warn(`Could not rebuild shard ${index} of ${blob.address}: ${message(err)}`);
      }
    }
    return false;
  }

  private async rebuild(blob: Fetched<BlobAccount>, target: number): Promise<void> {
    const data = blob.data;
    const k = data.dataShards;
    const m = data.totalShards - k;
    const holders = data.slots
      .map((s, i) => ({ index: i, holder: s.holder }))
      .filter((h) => !isVacant(h.holder) && !sameAddress(h.holder, this.monad.address));
    const endpoints = await this.holderEndpoints();
    const sources = holders
      .map((h) => ({ ...h, url: endpoints.get(h.holder.toLowerCase()) }))
      .filter((h): h is { index: number; holder: string; url: string } => !!h.url && h.url !== this.nodeEndpoint);
    if (sources.length < k) throw new Error(`only ${sources.length} reachable holders, ${k} needed`);

    // Layout and roots from a holder, checked against the on-chain root
    let info: BlobInfo | null = null;
    for (const source of sources) {
      try {
        const response = await fetch(`${source.url}/blob/${blob.address}/info`, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) continue;
        const candidate = (await response.json()) as BlobInfo;
        if (!Array.isArray(candidate.roots) || candidate.roots.some((r) => typeof r !== 'string' || !/^[0-9a-f]{64}$/i.test(r))) continue;
        const roots = candidate.roots.map(fromHex);
        if (roots.length === data.totalShards && hex(blobRoot(roots)) === hex(data.root) && isFragmentSize(candidate.fragmentSize, Number(data.shardSize))) {
          info = candidate;
          break;
        }
      } catch {
        // next holder
      }
    }
    if (!info) throw new Error('no holder served a layout matching the blob root');
    const roots = info.roots.map(fromHex);
    const fragmentSize = info.fragmentSize;
    const stripes = Number(data.shardSize) / fragmentSize;

    const key = this.key(blob.address, target);
    await this.blobs.discardStaged(key);
    const hasher = new ShardHasher();
    let received = 0;
    for (let stripe = 0; stripe < stripes; stripe++) {
      const fragments: (Uint8Array | null)[] = new Array(data.totalShards).fill(null);
      let have = 0;
      for (const source of sources) {
        if (have >= k) break;
        const fragment = await this.fetchFragment(source.url, blob.address, source.index, stripe, roots[source.index], fragmentSize, stripes);
        if (fragment) {
          fragments[source.index] = fragment;
          have++;
        }
      }
      if (have < k) throw new Error(`stripe ${stripe}: only ${have} verified fragments, ${k} needed`);
      const rebuilt = rebuildShardFragment(fragments, k, m, target);
      received = await this.blobs.stageAppend(key, received, Buffer.from(rebuilt));
      hasher.update(rebuilt);
    }
    if (hex(hasher.root()) !== hex(roots[target])) {
      await this.blobs.discardStaged(key);
      throw new Error(`rebuilt shard ${target} does not hash to its root`);
    }
    await this.commitShard(blob.address, target, data, hasher.leafHashes(), roots, fragmentSize);
    this.totals.rebuilt++;
    this.logger.log(`Rebuilt shard ${target} of ${blob.address} from ${k} other holders`);
    await this.confirm(blob.address, target, data);
  }

  /** A peer's fragment: exactly `fragmentSize` bytes with a proof of the stripe tree's depth */
  private async fetchFragment(
    url: string,
    blob: string,
    index: number,
    stripe: number,
    shardRoot: Uint8Array,
    fragmentSize: number,
    stripes: number,
  ): Promise<Uint8Array | null> {
    try {
      const response = await fetch(`${url}/blob/${blob}/shard/${index}/fragment/${stripe}`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return null;
      const header = (response.headers.get('x-monadb-proof') ?? '').split(',').filter(Boolean);
      if (header.length !== depth(stripes) || header.some((h) => !/^[0-9a-f]{64}$/i.test(h))) return null;
      const fragment = new Uint8Array(await response.arrayBuffer());
      if (fragment.length !== fragmentSize) return null;
      return verifyFragment(fragment, stripe, header.map(fromHex), shardRoot) ? fragment : null;
    } catch {
      return null;
    }
  }

  /**
   * Challenge one random slot held by another replicator; report the
   * challenges that went unanswered (bounty).  The contract has no list of
   * every blob, so the candidates are the blobs this node holds a shard of
   * (its co-holders) plus the blobs in the work queue.
   */
  async challengeRound(): Promise<void> {
    const me = this.monad.address;
    const head = await this.head();
    const ids = new Set<string>();
    for (let offset = 0; ; offset += 500) {
      const page = await this.storage.listBlobShards({ state: 'Confirmed', limit: 500, offset });
      for (const r of page) ids.add(r.blob.toLowerCase());
      if (page.length < 500) break;
    }
    const pending = await this.monad.listBlobsNeedingHolders();
    const blobs = new Map<string, Fetched<BlobAccount>>(pending.map((b) => [b.address, b]));
    for (const b of await this.monad.getBlobs([...ids].filter((id) => !blobs.has(id)))) if (b) blobs.set(b.address, b);

    // report challenges that expired
    for (const blob of blobs.values()) {
      for (let i = 0; i < blob.data.slots.length; i++) {
        const s = blob.data.slots[i];
        if (!isVacant(s.holder) && !sameAddress(s.holder, me) && s.challengeBlock !== 0n && head.block > s.challengeDeadline) {
          try {
            await this.monad.failChallenge(blob.address, i);
            this.totals.challengesWon++;
            this.logger.log(`Reported the unanswered challenge of ${blob.address}#${i} (holder ${s.holder})`);
          } catch (err) {
            this.logger.debug(`failChallenge ${blob.address}#${i}: ${message(err)}`);
          }
        }
      }
    }
    const targets = [...blobs.values()].flatMap((b) =>
      b.data.slots
        .map((s, i) => ({ blob: b.address, index: i, slot: s }))
        .filter(
          (t) =>
            !isVacant(t.slot.holder) &&
            !sameAddress(t.slot.holder, me) &&
            t.slot.challengeBlock === 0n &&
            head.time >= t.slot.lastChallengeAt + this.config!.challengeCooldown &&
            head.time < b.data.expiresAt,
        ),
    );
    if (targets.length === 0) return;
    const pick = targets[Math.floor(Math.random() * targets.length)];
    await this.monad.createChallenge(pick.blob, pick.index);
    this.totals.challengesSent++;
    this.logger.log(`Challenged ${pick.blob}#${pick.index} (holder ${pick.slot.holder})`);
  }

  /** Drop pushes nobody continued (a client that went away mid-shard) */
  private async pruneAbandoned(): Promise<void> {
    const cutoff = Date.now() - ABANDONED_PUSH_MS;
    for (const [key, state] of this.incoming) {
      if (state.touchedAt < cutoff) this.incoming.delete(key);
    }
    const dropped = await this.blobs.pruneStaged(ABANDONED_PUSH_MS);
    if (dropped.length > 0) this.logger.log(`Dropped ${dropped.length} abandoned shard upload(s)`);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async commitShard(
    blob: string,
    index: number,
    data: BlobAccount,
    leafHashes: Uint8Array,
    roots: Uint8Array[],
    fragmentSize: number,
  ): Promise<void> {
    const key = this.key(blob, index);
    await this.blobs.putObject(`${key}.leaves`, Buffer.from(leafHashes));
    await this.blobs.putObject(this.rootsKey(blob), Buffer.from(packHashes(roots)));
    await this.blobs.commit(key);
    this.uncacheTree(key);
    await this.storage.upsertBlobShard({
      blob,
      index,
      owner: data.owner,
      root: hex(data.root),
      shardRoot: hex(roots[index]),
      shardSize: Number(data.shardSize),
      dataShards: data.dataShards,
      totalShards: data.totalShards,
      fragmentSize,
      state: 'Stored',
      storedAt: new Date(),
      confirmedAt: null,
      confirmSignature: null,
      provenAt: null,
      claimedUntil: null,
      expiresAt: new Date(Number(data.expiresAt) * 1000),
    });
  }

  /** confirmShard unless this node may not (not registered, inactive); the data is kept either way */
  private async confirm(blob: string, index: number, data: BlobAccount): Promise<{ confirmed: boolean; signature?: string; reason?: string }> {
    void data;
    const replicator = await this.monad.getReplicator();
    if (!replicator) return { confirmed: false, reason: 'this node is not a registered replicator' };
    if (!replicator.active) return { confirmed: false, reason: 'this replicator is inactive' };
    try {
      const signature = await this.monad.confirmShard(blob, index);
      this.totals.confirmed++;
      const now = new Date();
      await this.storage.updateBlobShard(blob, index, {
        state: 'Confirmed',
        confirmedAt: now,
        confirmSignature: signature,
        provenAt: now,
        claimedUntil: now,
      });
      this.logger.log(`Confirmed shard ${index} of ${blob} in ${signature}`);
      return { confirmed: true, signature };
    } catch (err) {
      this.logger.warn(`confirmShard ${blob}#${index} failed: ${message(err)}`);
      return { confirmed: false, reason: message(err) };
    }
  }

  private async drop(record: BlobShardRecord, state: 'Lost' | 'Expired', why: string): Promise<void> {
    const key = this.key(record.blob, record.index);
    await this.blobs.delete(key).catch(() => undefined);
    await this.blobs.delete(`${key}.leaves`).catch(() => undefined);
    this.uncacheTree(key);
    await this.storage.updateBlobShard(record.blob, record.index, { state });
    this.logger.log(`Dropped shard ${record.index} of ${record.blob}: ${why}`);
  }

  /** The shard's Merkle tree, built once from its stored leaf hashes */
  private async shardTree(key: string): Promise<MerkleTree> {
    const cached = this.treeCache.get(key);
    if (cached) {
      // refresh LRU position
      this.treeCache.delete(key);
      this.treeCache.set(key, cached);
      return cached.tree;
    }
    let load = this.treeLoads.get(key);
    if (!load) {
      load = (async () => {
        const stored = await this.blobs.getObject(`${key}.leaves`);
        if (!stored) throw new NotFoundException(`Leaf hashes of ${key} are missing`);
        const leaves = new Uint8Array(stored);
        const tree = new MerkleTree(leaves);
        // every level above the leaves adds about as much again
        this.cacheTree(key, tree, 2 * leaves.length);
        return tree;
      })().finally(() => this.treeLoads.delete(key));
      this.treeLoads.set(key, load);
    }
    return load;
  }

  private cacheTree(key: string, tree: MerkleTree, bytes: number): void {
    this.uncacheTree(key);
    this.treeCache.set(key, { tree, bytes });
    this.treeCacheBytes += bytes;
    for (const [k, v] of this.treeCache) {
      if (this.treeCacheBytes <= this.leafCacheLimit || k === key) break;
      this.treeCache.delete(k);
      this.treeCacheBytes -= v.bytes;
    }
  }

  private uncacheTree(key: string): void {
    const old = this.treeCache.get(key);
    if (old) {
      this.treeCacheBytes -= old.bytes;
      this.treeCache.delete(key);
    }
  }

  private async holderEndpoints(): Promise<Map<string, string>> {
    if (Date.now() - this.endpointsAt > 60_000) {
      const replicators = await this.monad.listReplicators();
      this.endpoints = new Map(replicators.filter((r) => r.active).map((r) => [r.authority.toLowerCase(), r.endpoint.replace(/\/$/, '')]));
      this.endpointsAt = Date.now();
    }
    return this.endpoints;
  }

  private key(blob: string, index: number): string {
    return `${blob}/${index}`;
  }

  private rootsKey(blob: string): string {
    return `${blob}/roots`;
  }

  /** The chain's head (block number, timestamp): what the contract compares deadlines to */
  private async head(): Promise<Head> {
    const head = await this.monad.head();
    return { block: BigInt(head.block), time: head.time };
  }

  /** Serialize work on one shard (a push and a repair never interleave) */
  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    while (this.locks.has(key)) await this.locks.get(key)!.catch(() => undefined);
    const promise = work();
    this.locks.set(key, promise);
    try {
      return await promise;
    } finally {
      this.locks.delete(key);
    }
  }
}

function isFragmentSize(fragmentSize: number, shardSize: number): boolean {
  return (
    Number.isInteger(fragmentSize) &&
    fragmentSize >= MIN_FRAGMENT &&
    fragmentSize <= MAX_FRAGMENT &&
    (fragmentSize & (fragmentSize - 1)) === 0 &&
    shardSize % fragmentSize === 0
  );
}
