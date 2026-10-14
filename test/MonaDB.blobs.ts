import { expect } from "chai";
import { ethers } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import { getBytes, hexlify, solidityPackedKeccak256 } from "ethers";
import {
  blobProof,
  blobRoot,
  challengeSegment as challengeSegmentTs,
  depth,
  SEGMENT_SIZE,
  segmentProof,
  shardLeafHashes,
  shardRoot,
} from "../sdk/src/merkle";
import { data, DAY, deploy, quoteBlob, registered, withReplicators } from "./helpers";

const HotBlob = 1n;
const CoolBlob = 2n;

/** n shards of `segments` KiB each, with their roots and the blob root */
function makeBlob(n: number, segments: number, seed = 1) {
  const shards = Array.from({ length: n }, (_, j) => data(segments * SEGMENT_SIZE, seed * 31 + j));
  const roots = shards.map(shardRoot);
  return { shards, roots, root: hexlify(blobRoot(roots)), shardSize: segments * SEGMENT_SIZE };
}

async function setup(opts: { k?: number; n?: number; segments?: number; epochs?: number } = {}) {
  const env = await deploy();
  const { monadb, admin, alice, replicators } = env;
  await registered(monadb, alice);
  await withReplicators(monadb, admin, replicators);
  const k = opts.k ?? 2;
  const n = opts.n ?? 3;
  const epochs = opts.epochs ?? 12;
  const blob = makeBlob(n, opts.segments ?? 8);
  const args = {
    root: blob.root,
    dataShards: k,
    totalShards: n,
    shardSize: blob.shardSize,
    payloadSize: blob.shardSize * k - 100,
    epochs,
    maxFee: ethers.MaxUint256,
  };
  const fee = await monadb.quoteBlob(blob.shardSize, n, epochs);
  await monadb.connect(alice).openBlob(args, { value: fee });
  const id: string = await monadb.blobId(alice.address, blob.root);
  return { ...env, blob, args, fee, id, k, n, epochs };
}

/** The proof a holder sends for the open challenge of shard `index` */
async function proof(monadb: any, id: string, blob: ReturnType<typeof makeBlob>, index: number) {
  const segment = Number(await monadb.challengeSegment(id, index));
  const shard = blob.shards[index];
  return {
    segmentIndex: segment,
    segment: shard.subarray(segment * SEGMENT_SIZE, (segment + 1) * SEGMENT_SIZE),
    shardProof: segmentProof(shardLeafHashes(shard), segment).map((h) => hexlify(h)),
    topProof: blobProof(blob.roots, index).map((h) => hexlify(h)),
  };
}

async function prove(monadb: any, signer: any, id: string, blob: ReturnType<typeof makeBlob>, index: number) {
  const p = await proof(monadb, id, blob, index);
  return monadb.connect(signer).proveShard(id, index, p.segment, p.shardProof, p.topProof);
}

describe("MonaDB: blobs", () => {
  it("prepays storage and escrows it per shard and epoch", async () => {
    const { monadb, params, blob, fee, id, alice, n, epochs } = await setup();
    expect(fee).to.equal(quoteBlob(params, BigInt(blob.shardSize), BigInt(n), BigInt(epochs)));
    expect(id).to.equal(solidityPackedKeccak256(["string", "address", "bytes32"], ["blob", alice.address, blob.root]));
    const b = await monadb.getBlob(id);
    const protocol = (fee * 1000n) / 10_000n;
    const perSlotEpoch = (fee - protocol) / BigInt(n * epochs);
    expect(b.rewardPerShardEpoch).to.equal(perSlotEpoch);
    expect(b.escrow).to.equal(perSlotEpoch * BigInt(n * epochs));
    expect(await monadb.protocolFees()).to.equal(fee - b.escrow);
    expect(b.state).to.equal(HotBlob);
    expect(b.needsHolders).to.equal(true);
    expect(b.expiresAt - b.openedAt).to.equal(BigInt(epochs * 30 * DAY));
    expect(await monadb.pendingBlobs(0, 10)).to.deep.equal([id]);
    expect(await ethers.provider.getBalance(await monadb.getAddress())).to.equal(fee);
  });

  it("validates the layout and the epochs", async () => {
    const { monadb, alice, args } = await setup();
    const open = (over: any) => monadb.connect(alice).openBlob({ ...args, root: hexlify(data(32, 77)), ...over }, { value: 10n ** 18n });
    await expect(open({ dataShards: 0 })).to.be.revertedWithCustomError(monadb, "InvalidShardLayout");
    await expect(open({ dataShards: 4, totalShards: 3 })).to.be.revertedWithCustomError(monadb, "InvalidShardLayout");
    await expect(open({ totalShards: 33 })).to.be.revertedWithCustomError(monadb, "InvalidShardLayout");
    await expect(open({ shardSize: 0 })).to.be.revertedWithCustomError(monadb, "InvalidShardLayout");
    await expect(open({ shardSize: 1000 })).to.be.revertedWithCustomError(monadb, "InvalidShardLayout");
    await expect(open({ shardSize: (1n << 40n) + 1024n })).to.be.revertedWithCustomError(monadb, "InvalidShardLayout");
    await expect(open({ epochs: 0 })).to.be.revertedWithCustomError(monadb, "InvalidEpochs");
    await expect(open({ epochs: 1201 })).to.be.revertedWithCustomError(monadb, "InvalidEpochs");
    await expect(open({ maxFee: 1n })).to.be.revertedWithCustomError(monadb, "FeeAboveMax");
    await expect(monadb.connect(alice).openBlob(args, { value: 10n ** 18n })).to.be.revertedWithCustomError(monadb, "BlobExists");
  });

  it("fills the slots with holders and cools the blob at k", async () => {
    const { monadb, id, alice, replicators: [r1, r2, r3, r4] } = await setup();
    await expect(monadb.connect(alice).confirmShard(id, 0)).to.be.revertedWithCustomError(monadb, "ReplicatorInactive");
    await expect(monadb.connect(r1).confirmShard(id, 3)).to.be.revertedWithCustomError(monadb, "InvalidShardIndex");
    await expect(monadb.connect(r1).confirmShard(id, 0)).to.emit(monadb, "ShardConfirmed").withArgs(id, 0, r1.address, 1);
    await expect(monadb.connect(r2).confirmShard(id, 0)).to.be.revertedWithCustomError(monadb, "SlotOccupied");
    await expect(monadb.connect(r1).confirmShard(id, 1)).to.be.revertedWithCustomError(monadb, "AlreadyHolder");
    expect((await monadb.getBlob(id)).state).to.equal(HotBlob);
    await monadb.connect(r2).confirmShard(id, 1);
    expect((await monadb.getBlob(id)).state).to.equal(CoolBlob);
    expect(await monadb.pendingBlobCount()).to.equal(1n);
    await monadb.connect(r3).confirmShard(id, 2);
    const b = await monadb.getBlob(id);
    expect(b.held).to.equal(3n);
    expect(b.needsHolders).to.equal(false);
    expect(b.slots[2].holder).to.equal(r3.address);
    expect(await monadb.pendingBlobCount()).to.equal(0n);
    void r4;
  });

  it("answers challenges with storage proofs and unlocks rewards up to the last proof", async () => {
    const { monadb, id, blob, replicators: [r1, r2], alice } = await setup();
    await monadb.connect(r1).confirmShard(id, 0);
    // confirming opened a challenge two blocks ahead
    await expect(monadb.challengeSegment(id, 0)).to.be.revertedWithCustomError(monadb, "ChallengeNotReady");
    await mine(3);
    const slot = (await monadb.getBlob(id)).slots[0];
    const segment = Number(await monadb.challengeSegment(id, 0));
    // the node can compute the same segment from the block hash
    const header = await ethers.provider.getBlock(Number(slot.challengeBlock));
    expect(challengeSegmentTs(getBytes(header!.hash!), getBytes(id), 0, blob.shardSize)).to.equal(segment);

    // a wrong answer is rejected
    const good = await proof(monadb, id, blob, 0);
    const wrong = blob.shards[0].subarray(((segment + 1) % 8) * 1024, (((segment + 1) % 8) + 1) * 1024);
    await expect(monadb.connect(r2).proveShard(id, 0, wrong, good.shardProof, good.topProof)).to.be.revertedWithCustomError(monadb, "InvalidProof");
    await expect(monadb.connect(r2).proveShard(id, 0, good.segment, good.shardProof.slice(1), good.topProof)).to.be.revertedWithCustomError(
      monadb,
      "InvalidProof",
    );
    await expect(monadb.connect(r2).proveShard(id, 0, good.segment.subarray(1), good.shardProof, good.topProof)).to.be.revertedWithCustomError(
      monadb,
      "InvalidSegment",
    );
    expect(good.shardProof).to.have.length(depth(8));
    // anyone holding the bytes can answer
    await expect(monadb.connect(r2).proveShard(id, 0, good.segment, good.shardProof, good.topProof)).to.emit(monadb, "ShardProven");
    await expect(prove(monadb, r1, id, blob, 0)).to.be.revertedWithCustomError(monadb, "NoChallenge");

    // the proof unlocked the few seconds since the confirmation
    const proven = await monadb.getBlob(id);
    const early = (BigInt(proven.rewardPerShardEpoch) * BigInt(proven.slots[0].provenAt - proven.slots[0].claimedUntil)) / BigInt(30 * DAY);
    expect(await monadb.claimableShardRewards(id, 0)).to.equal(early);
    await expect(monadb.connect(r2).claimShardRewards(id, 0)).to.be.revertedWithCustomError(monadb, "NotHolder");
    if (early > 0n) await monadb.connect(r1).claimShardRewards(id, 0);
    // time passing without a proof unlocks nothing
    await time.increase(15 * DAY);
    const b0 = await monadb.getBlob(id);
    await expect(monadb.connect(r1).claimShardRewards(id, 0)).to.be.revertedWithCustomError(monadb, "NothingToClaim");

    // a new proof unlocks the elapsed time
    await expect(monadb.connect(alice).createChallenge(id, 0)).to.emit(monadb, "ShardChallenged");
    await expect(monadb.connect(alice).createChallenge(id, 0)).to.be.revertedWithCustomError(monadb, "ChallengeOpen");
    await mine(3);
    await prove(monadb, r1, id, blob, 0);
    const provenAt = BigInt((await monadb.getBlob(id)).slots[0].provenAt);
    const expected = (b0.rewardPerShardEpoch * (provenAt - b0.slots[0].claimedUntil)) / BigInt(30 * DAY);
    expect(await monadb.claimableShardRewards(id, 0)).to.equal(expected);
    await expect(monadb.connect(r1).claimShardRewards(id, 0)).to.changeEtherBalance(r1, expected);
    expect((await monadb.getBlob(id)).escrow).to.equal(b0.escrow - expected);
    expect((await monadb.getReplicator(r1.address)).earned).to.equal(expected + early);
  });

  it("frees the slot of an unanswered challenge and pays the reporter a bounty", async () => {
    const { monadb, id, blob, params, replicators: [r1, r2, r3], bob } = await setup();
    await monadb.connect(r1).confirmShard(id, 0);
    await mine(3);
    await prove(monadb, r1, id, blob, 0);
    await time.increase(10 * DAY);
    await monadb.connect(bob).createChallenge(id, 0);
    await expect(monadb.connect(bob).failChallenge(id, 0)).to.be.revertedWithCustomError(monadb, "ChallengeStillOpen");
    await mine(2 + params.challengeWindowBlocks);
    await expect(prove(monadb, r1, id, blob, 0)).to.be.revertedWithCustomError(monadb, "ChallengeExpired");

    const before = await monadb.getBlob(id);
    const tx = await monadb.connect(bob).failChallenge(id, 0);
    const receipt = await tx.wait();
    const lost = receipt.logs.map((l: any) => monadb.interface.parseLog(l)).find((e: any) => e?.name === "ShardLost");
    const forfeited: bigint = lost.args.forfeited;
    const bounty: bigint = lost.args.bounty;
    expect(forfeited).to.be.greaterThan(0n);
    expect(bounty).to.equal((forfeited * 1000n) / 10_000n);
    const after = await monadb.getBlob(id);
    expect(after.held).to.equal(0n);
    expect(after.slots[0].holder).to.equal(ethers.ZeroAddress);
    expect(after.escrow).to.equal(before.escrow - bounty);
    expect(after.needsHolders).to.equal(true);
    expect(await monadb.pendingBlobs(0, 10)).to.deep.equal([id]);

    // the shard is rebuilt by another node, which takes the slot
    await monadb.connect(r2).confirmShard(id, 0);
    expect((await monadb.getBlob(id)).slots[0].holder).to.equal(r2.address);
    void r3;
  });

  it("keeps a node from squatting a slot without the bytes", async () => {
    const { monadb, id, params, replicators: [r1, r2], bob } = await setup();
    await monadb.connect(r1).confirmShard(id, 1);
    // r1 never answers the challenge opened by its own confirmation
    await mine(3 + params.challengeWindowBlocks);
    await monadb.connect(bob).failChallenge(id, 1);
    expect((await monadb.getBlob(id)).slots[1].holder).to.equal(ethers.ZeroAddress);
    await monadb.connect(r2).confirmShard(id, 1);
  });

  it("respects the challenge cooldown", async () => {
    const { monadb, id, blob, replicators: [r1], bob } = await setup();
    await monadb.connect(r1).confirmShard(id, 0);
    await mine(3);
    await prove(monadb, r1, id, blob, 0);
    await expect(monadb.connect(bob).createChallenge(id, 0)).to.be.revertedWithCustomError(monadb, "ChallengeCooldown");
    await expect(monadb.connect(bob).createChallenge(id, 1)).to.be.revertedWithCustomError(monadb, "SlotVacant");
    await time.increase(3600);
    await monadb.connect(bob).createChallenge(id, 0);
  });

  it("stops rewards at expiry and returns the rest to the owner", async () => {
    const { monadb, id, blob, replicators: [r1], alice } = await setup({ epochs: 1 });
    await monadb.connect(r1).confirmShard(id, 0);
    await mine(3);
    await prove(monadb, r1, id, blob, 0);
    await time.increase(45 * DAY); // past expiry (30 days), inside the grace epoch
    await expect(monadb.connect(r1).confirmShard(id, 1)).to.be.revertedWithCustomError(monadb, "BlobExpired");
    await monadb.connect(alice).createChallenge(id, 0);
    await mine(3);
    await prove(monadb, r1, id, blob, 0);
    const b = await monadb.getBlob(id);
    // one slot, from its confirmation to expiry (a few seconds short of the epoch)
    const earned = (BigInt(b.rewardPerShardEpoch) * BigInt(b.expiresAt - b.slots[0].claimedUntil)) / BigInt(30 * DAY);
    expect(earned).to.be.lessThanOrEqual(b.rewardPerShardEpoch);
    await expect(monadb.connect(r1).claimShardRewards(id, 0)).to.changeEtherBalance(r1, earned);
    await expect(monadb.connect(alice).closeBlob(id)).to.be.revertedWithCustomError(monadb, "BlobNotClosable");
    await time.increase(15 * DAY);
    const rest = (await monadb.getBlob(id)).escrow;
    expect(rest).to.equal(b.escrow - earned);
    await expect(monadb.connect(alice).closeBlob(id)).to.changeEtherBalance(alice, rest);
    expect((await monadb.getBlob(id)).state).to.equal(0n);
    expect(await monadb.blobCountOf(alice.address)).to.equal(0n);
    expect(await monadb.pendingBlobCount()).to.equal(0n);
  });

  it("closes abandoned blobs after the abort delay", async () => {
    const { monadb, id, alice, bob, fee } = await setup();
    await expect(monadb.connect(alice).closeBlob(id)).to.be.revertedWithCustomError(monadb, "BlobNotClosable");
    await time.increase(600);
    expect(await monadb.isBlobClosable(id)).to.equal(true);
    await expect(monadb.connect(bob).closeBlob(id)).to.be.revertedWithCustomError(monadb, "NotOwner");
    const escrow = (await monadb.getBlob(id)).escrow;
    await expect(monadb.connect(alice).closeBlob(id)).to.changeEtherBalance(alice, escrow);
    expect(escrow).to.be.lessThan(fee);
  });

  it("extends a blob at its own rate", async () => {
    const { monadb, id, alice, params, n } = await setup({ epochs: 2 });
    const b = await monadb.getBlob(id);
    const escrow = b.rewardPerShardEpoch * BigInt(n) * 3n;
    const fee = escrow + (escrow * 1000n) / 9000n;
    expect(await monadb.quoteExtension(id, 3)).to.equal(fee);
    await expect(monadb.connect(alice).extendBlob(id, 3, fee - 1n)).to.be.revertedWithCustomError(monadb, "FeeAboveMax");
    await expect(monadb.connect(alice).extendBlob(id, 1199, ethers.MaxUint256, { value: 10n ** 20n })).to.be.revertedWithCustomError(
      monadb,
      "InvalidEpochs",
    );
    await expect(monadb.connect(alice).extendBlob(id, 3, fee, { value: fee + 5n })).to.changeEtherBalance(alice, -fee);
    const after = await monadb.getBlob(id);
    expect(after.epochs).to.equal(5n);
    expect(after.escrow).to.equal(b.escrow + escrow);
    expect(after.expiresAt - b.expiresAt).to.equal(BigInt(3 * params.epochSeconds));
    await time.increase(5 * 30 * DAY);
    await expect(monadb.connect(alice).extendBlob(id, 1, fee, { value: fee })).to.be.revertedWithCustomError(monadb, "BlobExpired");
  });

  it("matches the TypeScript Merkle helpers on larger trees", async () => {
    // 5 shards (padded top tree), 13 segments (padded shard tree)
    const { monadb, admin, alice, replicators } = await deploy();
    await registered(monadb, alice);
    await withReplicators(monadb, admin, replicators);
    const blob = makeBlob(5, 13, 3);
    const args = { root: blob.root, dataShards: 3, totalShards: 5, shardSize: blob.shardSize, payloadSize: 1, epochs: 1, maxFee: ethers.MaxUint256 };
    await monadb.connect(alice).openBlob(args, { value: await monadb.quoteBlob(blob.shardSize, 5, 1) });
    const id = await monadb.blobId(alice.address, blob.root);
    for (let i = 0; i < 5; i++) await monadb.connect(replicators[i]).confirmShard(id, i);
    await mine(3);
    for (let i = 0; i < 5; i++) await prove(monadb, replicators[i], id, blob, i);
    const b = await monadb.getBlob(id);
    for (let i = 0; i < 5; i++) expect(b.slots[i].challengeBlock).to.equal(0n);
  });
});

describe("MonaDB: batches", () => {
  it("extends several blobs in one payable call", async () => {
    const { monadb, id, alice, admin, replicators } = await setup({ epochs: 2 });
    void admin;
    void replicators;
    const blob2 = makeBlob(3, 4, 9);
    await monadb
      .connect(alice)
      .openBlob(
        { root: blob2.root, dataShards: 2, totalShards: 3, shardSize: blob2.shardSize, payloadSize: 1, epochs: 2, maxFee: ethers.MaxUint256 },
        { value: await monadb.quoteBlob(blob2.shardSize, 3, 2) },
      );
    const id2 = await monadb.blobId(alice.address, blob2.root);
    const fee = (await monadb.quoteExtension(id, 4)) + (await monadb.quoteExtension(id2, 4));
    await expect(monadb.connect(alice).extendBlobs([id, id2], 4, fee - 1n, { value: fee })).to.be.revertedWithCustomError(monadb, "FeeAboveMax");
    await expect(monadb.connect(alice).extendBlobs([id, id2], 4, fee, { value: fee + 7n })).to.changeEtherBalance(alice, -fee);
    expect((await monadb.getBlob(id)).epochs).to.equal(6n);
    expect((await monadb.getBlob(id2)).epochs).to.equal(6n);
  });

  it("batches owner calls with multicall: delete a record and close its chunks", async () => {
    const { monadb, alice, bob } = await setup();
    await registered(monadb, bob);
    const chunk = data(100, 4);
    const args = { contentHash: hexlify(require("@noble/hashes/sha256").sha256(chunk)), size: 100, segmentSize: 50, replicas: 2, maxFee: ethers.MaxUint256 };
    await monadb.connect(alice).upload([args], [], ethers.ZeroAddress, "s", "0x1234", { value: await monadb.quoteChunk(100, 2) });
    const record = await monadb.recordId(alice.address, 0);
    const chunkId = await monadb.chunkId(alice.address, args.contentHash);
    await monadb.connect(alice).grantAccess(record, bob.address, "0x99");
    const calls = [
      monadb.interface.encodeFunctionData("deleteRecord", [record]),
      monadb.interface.encodeFunctionData("closeChunk", [chunkId]),
    ];
    await monadb.connect(alice).multicall(calls);
    expect((await monadb.getRecord(record)).owner).to.equal(ethers.ZeroAddress);
    expect((await monadb.getChunk(chunkId)).state).to.equal(0n);
    expect(await monadb.grantsTo(bob.address, 0, 10)).to.deep.equal([]);
    // payable functions get no value through multicall
    await expect(monadb.connect(alice).multicall([monadb.interface.encodeFunctionData("openChunk", [args, ethers.ZeroAddress])])).to.be.reverted;
  });
});
