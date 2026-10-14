import { getAddress, getBytes, Interface, isAddress, solidityPackedKeccak256, ZeroAddress } from 'ethers';
import abi from './abi/MonaDB.json';
import { sha256 } from './crypto';

/**
 * MonaDB contract: ABI, ids, decoded views and the economics, mirrored from
 * contracts/ (the contract is the source of truth).
 */

export const MONADB_ABI = abi;
export const monadbInterface = new Interface(abi);

/** A checksummed 0x address */
export type Address = string;
/** A 0x-prefixed 32-byte id (chunk, blob, record) */
export type Hex32 = string;

export type ChunkState = 'Pending' | 'Hot' | 'Cool';
export type BlobState = 'Hot' | 'Cool';

const CHUNK_STATES = [null, 'Pending', 'Hot', 'Cool'] as const;
const BLOB_STATES = [null, 'Hot', 'Cool'] as const;

/** A vacant shard slot's holder */
export const VACANT: Address = ZeroAddress;

// ── Bounds (mirror MonaDBBase) ───────────────────────────────────────────────

export const MAX_REPLICAS = 16;
export const MAX_CHUNK_SIZE = 4 * 1024 * 1024;
export const MAX_DIRECT_CHUNK_SIZE = 16 * 1024 * 1024;
export const MIN_SEGMENT_SIZE = 32;
export const MAX_SEGMENT_SIZE = 96 * 1024;
export const MAX_SEGMENTS = 4096;
export const MAX_RECORD_CONTENT = 2048;
/** Seconds after which an unconfirmed direct chunk or an unheld blob can be closed */
export const DIRECT_ABORT_DELAY = 600n;
/** Blocks between a challenge and the block whose hash picks the segment */
export const CHALLENGE_DELAY_BLOCKS = 2n;

// ── Decoded views ────────────────────────────────────────────────────────────

export interface ConfigAccount {
  admin: Address;
  treasury: Address;
  /** Wei per requested replica (covers the node's confirmation) */
  baseFeePerReplica: bigint;
  /** Wei per MiB per replica, charged pro rata to the byte */
  pricePerMib: bigint;
  /** Wei per MiB of shard per epoch, pro rata */
  pricePerMibEpoch: bigint;
  protocolFeeBps: number;
  replicationThresholdPct: number;
  replicationWindow: bigint;
  /** Blob storage is prepaid per epoch of this many seconds */
  epochSeconds: bigint;
  /** Blocks a holder has to answer a challenge after its target block */
  challengeWindowBlocks: bigint;
  /** Seconds between two challenges of one shard slot */
  challengeCooldown: bigint;
  /** Share of forfeited rewards paid to whoever reports a failed challenge */
  challengerBountyBps: number;
}

export interface ConfigParams {
  treasury: Address;
  baseFeePerReplica: bigint;
  pricePerMib: bigint;
  pricePerMibEpoch: bigint;
  protocolFeeBps: number;
  replicationThresholdPct: number;
  replicationWindow: bigint;
  epochSeconds: bigint;
  challengeWindowBlocks: bigint;
  challengeCooldown: bigint;
  challengerBountyBps: number;
}

export interface IdentityAccount {
  user: Address;
  encryptionKey: Uint8Array;
  registeredAt: bigint;
  updatedAt: bigint;
  recordNonce: bigint;
}

export interface ReplicatorAccount {
  authority: Address;
  registered: boolean;
  active: boolean;
  registeredAt: bigint;
  confirmations: bigint;
  /** Wei earned from confirmations and shard rewards */
  earned: bigint;
  endpoint: string;
}

export interface ChunkAccount {
  /** keccak256("chunk", owner, contentHash) */
  id: Hex32;
  owner: Address;
  contentHash: Uint8Array;
  writer: Address;
  state: ChunkState;
  needsReplicas: boolean;
  reclaimed: boolean;
  requiredReplicas: number;
  confirmedReplicas: number;
  /** 0 = direct chunk */
  segmentSize: number;
  segmentsTotal: number;
  segmentsWritten: number;
  size: number;
  rewardPerReplica: bigint;
  openedAt: bigint;
  completedAt: bigint;
  reclaimableAt: bigint;
  /** Blocks bounding the chunk's SegmentWritten events */
  openedBlock: bigint;
  completedBlock: bigint;
  replicators: Address[];
}

export interface RecordAccount {
  id: Hex32;
  owner: Address;
  nonce: bigint;
  createdAt: bigint;
  updatedAt: bigint;
  /** Block of the upload transaction */
  createdBlock: bigint;
  schema: string;
  content: Uint8Array;
}

export interface GrantAccount {
  record: Hex32;
  viewer: Address;
  grantedAt: bigint;
  updatedAt: bigint;
  content: Uint8Array;
}

export interface ShardSlot {
  /** VACANT (the zero address) = no holder */
  holder: Address;
  provenAt: bigint;
  claimedUntil: bigint;
  lastChallengeAt: bigint;
  /** 0 = no open challenge */
  challengeBlock: bigint;
  challengeDeadline: bigint;
}

/** Erasure-coded payload (docs/blob-protocol.md) */
export interface BlobAccount {
  id: Hex32;
  owner: Address;
  root: Uint8Array;
  state: BlobState;
  needsHolders: boolean;
  dataShards: number;
  totalShards: number;
  held: number;
  shardSize: bigint;
  payloadSize: bigint;
  epochs: number;
  rewardPerShardEpoch: bigint;
  /** Wei still escrowed for the holders */
  escrow: bigint;
  openedAt: bigint;
  expiresAt: bigint;
  /** One per shard (`totalShards` entries) */
  slots: ShardSlot[];
}

const big = (v: unknown) => BigInt(v as bigint);
const num = (v: unknown) => Number(v as bigint);

export function decodeConfig(r: any, admin: Address): ConfigAccount {
  return {
    admin,
    treasury: r.treasury,
    baseFeePerReplica: big(r.baseFeePerReplica),
    pricePerMib: big(r.pricePerMib),
    pricePerMibEpoch: big(r.pricePerMibEpoch),
    protocolFeeBps: num(r.protocolFeeBps),
    replicationThresholdPct: num(r.replicationThresholdPct),
    replicationWindow: big(r.replicationWindow),
    epochSeconds: big(r.epochSeconds),
    challengeWindowBlocks: big(r.challengeWindowBlocks),
    challengeCooldown: big(r.challengeCooldown),
    challengerBountyBps: num(r.challengerBountyBps),
  };
}

/** ConfigParams in the tuple shape the contract takes */
export function encodeConfig(p: ConfigParams) {
  return {
    treasury: p.treasury,
    baseFeePerReplica: p.baseFeePerReplica,
    pricePerMib: p.pricePerMib,
    pricePerMibEpoch: p.pricePerMibEpoch,
    protocolFeeBps: p.protocolFeeBps,
    replicationThresholdPct: p.replicationThresholdPct,
    replicationWindow: p.replicationWindow,
    epochSeconds: p.epochSeconds,
    challengeWindowBlocks: p.challengeWindowBlocks,
    challengeCooldown: p.challengeCooldown,
    challengerBountyBps: p.challengerBountyBps,
  };
}

/** null when the user never registered */
export function decodeIdentity(r: any, user: Address): IdentityAccount | null {
  if (big(r.registeredAt) === 0n) return null;
  return {
    user,
    encryptionKey: getBytes(r.encryptionKey),
    registeredAt: big(r.registeredAt),
    updatedAt: big(r.updatedAt),
    recordNonce: big(r.recordNonce),
  };
}

export function decodeReplicator(r: any, authority: Address): ReplicatorAccount | null {
  if (!r.registered) return null;
  return {
    authority,
    registered: r.registered,
    active: r.active,
    registeredAt: big(r.registeredAt),
    confirmations: big(r.confirmations),
    earned: big(r.earned),
    endpoint: r.endpoint,
  };
}

/** null for state None (never opened, or closed) */
export function decodeChunk(r: any, id: Hex32): ChunkAccount | null {
  const state = CHUNK_STATES[num(r.state)];
  if (!state) return null;
  return {
    id,
    owner: r.owner,
    contentHash: getBytes(r.contentHash),
    writer: r.writer,
    state,
    needsReplicas: r.needsReplicas,
    reclaimed: r.reclaimed,
    requiredReplicas: num(r.requiredReplicas),
    confirmedReplicas: num(r.confirmedReplicas),
    segmentSize: num(r.segmentSize),
    segmentsTotal: num(r.segmentsTotal),
    segmentsWritten: num(r.segmentsWritten),
    size: num(r.size),
    rewardPerReplica: big(r.rewardPerReplica),
    openedAt: big(r.openedAt),
    completedAt: big(r.completedAt),
    reclaimableAt: big(r.reclaimableAt),
    openedBlock: big(r.openedBlock),
    completedBlock: big(r.completedBlock),
    replicators: [...r.replicators],
  };
}

export function decodeBlob(r: any, id: Hex32): BlobAccount | null {
  const state = BLOB_STATES[num(r.state)];
  if (!state) return null;
  const totalShards = num(r.totalShards);
  return {
    id,
    owner: r.owner,
    root: getBytes(r.root),
    state,
    needsHolders: r.needsHolders,
    dataShards: num(r.dataShards),
    totalShards,
    held: num(r.held),
    shardSize: big(r.shardSize),
    payloadSize: big(r.payloadSize),
    epochs: num(r.epochs),
    rewardPerShardEpoch: big(r.rewardPerShardEpoch),
    escrow: big(r.escrow),
    openedAt: big(r.openedAt),
    expiresAt: big(r.expiresAt),
    slots: [...r.slots].slice(0, totalShards).map((s: any) => ({
      holder: s.holder,
      provenAt: big(s.provenAt),
      claimedUntil: big(s.claimedUntil),
      lastChallengeAt: big(s.lastChallengeAt),
      challengeBlock: big(s.challengeBlock),
      challengeDeadline: big(s.challengeDeadline),
    })),
  };
}

export function decodeRecord(r: any, id: Hex32): RecordAccount | null {
  if (r.owner === ZeroAddress) return null;
  return {
    id,
    owner: r.owner,
    nonce: big(r.nonce),
    createdAt: big(r.createdAt),
    updatedAt: big(r.updatedAt),
    createdBlock: big(r.createdBlock),
    schema: r.schema,
    content: getBytes(r.content),
  };
}

export function decodeGrant(r: any, record: Hex32, viewer: Address): GrantAccount | null {
  if (big(r.grantedAt) === 0n) return null;
  return { record, viewer, grantedAt: big(r.grantedAt), updatedAt: big(r.updatedAt), content: getBytes(r.content) };
}

// ── Ids (mirror chunkId / blobId / recordId) ─────────────────────────────────

export const ids = {
  chunk: (owner: Address, contentHash: Uint8Array | string): Hex32 =>
    solidityPackedKeccak256(['string', 'address', 'bytes32'], ['chunk', owner, contentHash]),
  blob: (owner: Address, root: Uint8Array | string): Hex32 =>
    solidityPackedKeccak256(['string', 'address', 'bytes32'], ['blob', owner, root]),
  record: (owner: Address, nonce: bigint | number): Hex32 =>
    solidityPackedKeccak256(['string', 'address', 'uint64'], ['record', owner, nonce]),
};

export const isHex32 = (value: string) => /^0x[0-9a-fA-F]{64}$/.test(value);
export const isEvmAddress = (value: string) => isAddress(value);
export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const checksum = (a: string) => getAddress(a);

// ── Economics (mirror the contract) ──────────────────────────────────────────

const MIB = 1_048_576n;

export function quoteChunk(config: Pick<ConfigAccount, 'baseFeePerReplica' | 'pricePerMib'>, size: number, replicas: number): bigint {
  const storage = (BigInt(size) * config.pricePerMib + MIB - 1n) / MIB;
  return BigInt(replicas) * (config.baseFeePerReplica + storage);
}

/** Blob price: `n × (baseFeePerReplica + ⌈shardSize × pricePerMibEpoch × epochs / MiB⌉)` */
export function quoteBlob(
  config: Pick<ConfigAccount, 'baseFeePerReplica' | 'pricePerMibEpoch'>,
  shardSize: bigint,
  totalShards: number,
  epochs: number,
): bigint {
  const storage = (shardSize * config.pricePerMibEpoch * BigInt(epochs) + MIB - 1n) / MIB;
  return BigInt(totalShards) * (config.baseFeePerReplica + storage);
}

export function splitFee(config: Pick<ConfigAccount, 'protocolFeeBps'>, fee: bigint, replicas: number) {
  const protocol = (fee * BigInt(config.protocolFeeBps)) / 10_000n;
  const rewardPerReplica = (fee - protocol) / BigInt(replicas);
  return { protocolFee: fee - rewardPerReplica * BigInt(replicas), rewardPerReplica };
}

/** Protocol share and per-slot, per-epoch reward of a blob fee */
export function splitBlobFee(config: Pick<ConfigAccount, 'protocolFeeBps'>, fee: bigint, totalShards: number, epochs: number) {
  const slotEpochs = BigInt(totalShards) * BigInt(epochs);
  const protocol = (fee * BigInt(config.protocolFeeBps)) / 10_000n;
  const rewardPerShardEpoch = (fee - protocol) / slotEpochs;
  return { protocolFee: fee - rewardPerShardEpoch * slotEpochs, rewardPerShardEpoch };
}

/** Price of `epochs` more epochs of a blob (mirrors quoteExtension) */
export function quoteExtension(config: Pick<ConfigAccount, 'protocolFeeBps'>, blob: Pick<BlobAccount, 'rewardPerShardEpoch' | 'totalShards'>, epochs: number): bigint {
  const escrow = blob.rewardPerShardEpoch * BigInt(blob.totalShards) * BigInt(epochs);
  return escrow + (escrow * BigInt(config.protocolFeeBps)) / BigInt(10_000 - config.protocolFeeBps);
}

/** Reward of one slot over [from, to), prorated per second */
export function rewardBetween(blob: Pick<BlobAccount, 'rewardPerShardEpoch'>, epochSeconds: bigint, from: bigint, to: bigint): bigint {
  if (to <= from || epochSeconds <= 0n) return 0n;
  return (blob.rewardPerShardEpoch * (to - from)) / epochSeconds;
}

/** The segment a challenge asks for: sha256(blockHash ‖ blob ‖ [index]) as u64 LE mod segments */
export function challengedSegment(blockHash: Uint8Array | string, blob: Hex32, index: number, segments: bigint): bigint {
  const seed = sha256(Uint8Array.from([...getBytes(blockHash), ...getBytes(blob), index]));
  return new DataView(seed.buffer, seed.byteOffset, 8).getBigUint64(0, true) % segments;
}

export const isDirect = (chunk: Pick<ChunkAccount, 'segmentSize'>) => chunk.segmentSize === 0;

/**
 * The owner can close the chunk now (mirrors `_closable`): a Pending upload,
 * a direct chunk nobody confirmed after DIRECT_ABORT_DELAY, or any chunk
 * after its replication window.
 */
export function isClosable(chunk: ChunkAccount, now = BigInt(Math.floor(Date.now() / 1000))): boolean {
  if (chunk.state === 'Pending') return true;
  if (isDirect(chunk) && chunk.confirmedReplicas === 0 && now >= chunk.openedAt + DIRECT_ABORT_DELAY) return true;
  return now >= chunk.reclaimableAt;
}

export function isBlobClosable(blob: BlobAccount, epochSeconds: bigint, now = BigInt(Math.floor(Date.now() / 1000))): boolean {
  return now >= blob.expiresAt + epochSeconds || (blob.held === 0 && now >= blob.openedAt + DIRECT_ABORT_DELAY);
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** Custom error names of the contract */
export const MONADB_ERRORS = Object.fromEntries(
  (abi as { type: string; name?: string }[]).filter((e) => e.type === 'error').map((e) => [e.name!, e.name!]),
) as Record<string, string>;

/**
 * The contract's custom error name inside an ethers / RPC error (estimateGas
 * and eth_call revert data), or undefined.
 */
export function revertName(err: unknown): string | undefined {
  const e = err as any;
  if (e?.revert?.name) return e.revert.name;
  const candidates = [e?.data, e?.error?.data, e?.info?.error?.data, e?.error?.error?.data, e?.info?.error?.data?.data];
  for (const data of candidates) {
    const hex = typeof data === 'string' ? data : typeof data?.data === 'string' ? data.data : undefined;
    if (!hex || hex.length < 10) continue;
    try {
      const parsed = monadbInterface.parseError(hex);
      if (parsed) return parsed.name;
    } catch {
      // not ours
    }
  }
  const text = `${e?.shortMessage ?? ''} ${e?.message ?? ''}`;
  const match = /reverted with custom error '([A-Za-z]+)\(/.exec(text) ?? /custom error ([A-Za-z]+)\(/.exec(text);
  return match?.[1];
}
