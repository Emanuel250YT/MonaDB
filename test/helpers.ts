import { ethers } from "hardhat";
import { sha256 } from "@noble/hashes/sha256";
import { hexlify, randomBytes } from "ethers";

export const MIB = 1024n * 1024n;
export const DAY = 86_400;

/** Default protocol settings used by the tests */
export function defaultParams(treasury: string) {
  return {
    treasury,
    baseFeePerReplica: ethers.parseUnits("10", "gwei") * 1000n, // 0.00001 MON
    pricePerMib: ethers.parseUnits("20", "gwei") * 1000n, // 0.00002 MON per MiB
    pricePerMibEpoch: ethers.parseUnits("200", "gwei"),
    protocolFeeBps: 1000,
    replicationThresholdPct: 60,
    replicationWindow: 7 * DAY,
    epochSeconds: 30 * DAY,
    challengeWindowBlocks: 100,
    challengeCooldown: 3600,
    challengerBountyBps: 1000,
  };
}

export type Params = ReturnType<typeof defaultParams>;

/** Deploy MonaDB with the default config; accounts: admin, treasury, users, replicators */
export async function deploy(overrides: Partial<Params> = {}) {
  const [admin, treasury, alice, bob, carol, r1, r2, r3, r4, r5] = await ethers.getSigners();
  const params = { ...defaultParams(treasury.address), ...overrides };
  const monadb: any = await ethers.deployContract("MonaDB", [params]);
  await monadb.waitForDeployment();
  return { monadb, params, admin, treasury, alice, bob, carol, replicators: [r1, r2, r3, r4, r5] };
}

export function key(): string {
  return hexlify(randomBytes(32));
}

/** Deterministic pseudo-random bytes (xorshift32), no repeating pattern */
export function data(len: number, seed = 7): Uint8Array {
  const out = new Uint8Array(len);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < len; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

export function sha(bytes: Uint8Array): string {
  return hexlify(sha256(bytes));
}

export async function registered(monadb: any, ...users: any[]) {
  for (const u of users) await monadb.connect(u).registerIdentity(key());
}

export async function withReplicators(monadb: any, admin: any, nodes: any[]) {
  for (const [i, n] of nodes.entries()) {
    await monadb.connect(admin).registerReplicator(n.address, `http://node-${i}.test`);
  }
}

export function quote(params: Params, size: bigint, replicas: bigint): bigint {
  const storage = (size * params.pricePerMib + MIB - 1n) / MIB;
  return replicas * (params.baseFeePerReplica + storage);
}

export function quoteBlob(params: Params, shardSize: bigint, n: bigint, epochs: bigint): bigint {
  const storage = (shardSize * params.pricePerMibEpoch * epochs + MIB - 1n) / MIB;
  return n * (params.baseFeePerReplica + storage);
}

export function chunkArgs(bytes: Uint8Array, opts: { segmentSize?: number; replicas?: number; maxFee?: bigint } = {}) {
  return {
    contentHash: sha(bytes),
    size: bytes.length,
    segmentSize: opts.segmentSize ?? 0,
    replicas: opts.replicas ?? 2,
    maxFee: opts.maxFee ?? ethers.MaxUint256,
  };
}

/** Open a chunk paying its exact quote; returns its id */
export async function openChunk(monadb: any, owner: any, bytes: Uint8Array, opts: { segmentSize?: number; replicas?: number; writer?: string } = {}) {
  const args = chunkArgs(bytes, opts);
  const fee = await monadb.quoteChunk(args.size, args.replicas);
  await monadb.connect(owner).openChunk(args, opts.writer ?? ethers.ZeroAddress, { value: fee });
  return monadb.chunkId(owner.address, args.contentHash) as Promise<string>;
}

/** Write every segment of a ledger chunk */
export async function writeAll(monadb: any, writer: any, id: string, bytes: Uint8Array, segmentSize: number) {
  for (let i = 0; i * segmentSize < bytes.length; i++) {
    await monadb.connect(writer).writeSegment(id, i, bytes.subarray(i * segmentSize, (i + 1) * segmentSize));
  }
}

export async function gasCost(tx: any): Promise<bigint> {
  const receipt = await tx.wait();
  return BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice);
}
