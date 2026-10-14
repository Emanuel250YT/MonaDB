import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { hexlify } from "ethers";
import {
  chunkArgs,
  data,
  DAY,
  defaultParams,
  deploy,
  gasCost,
  key,
  MIB,
  openChunk,
  quote,
  registered,
  sha,
  withReplicators,
  writeAll,
} from "./helpers";

const Hot = 2n;
const Pending = 1n;
const Cool = 3n;
const None = 0n;

describe("MonaDB: admin and identity", () => {
  it("stores the configuration and the admin", async () => {
    const { monadb, params, admin } = await deploy();
    expect(await monadb.admin()).to.equal(admin.address);
    const config = await monadb.getConfig();
    expect(config.treasury).to.equal(params.treasury);
    expect(config.pricePerMib).to.equal(params.pricePerMib);
    expect(config.challengeWindowBlocks).to.equal(params.challengeWindowBlocks);
  });

  it("validates config updates and keeps them admin only", async () => {
    const { monadb, params, admin, alice } = await deploy();
    await expect(monadb.connect(alice).updateConfig(params)).to.be.revertedWithCustomError(monadb, "NotAdmin");
    for (const bad of [
      { protocolFeeBps: 3001 },
      { replicationThresholdPct: 0 },
      { replicationThresholdPct: 101 },
      { replicationWindow: 60 },
      { epochSeconds: 59 },
      { challengeWindowBlocks: 0 },
      { challengeWindowBlocks: 241 },
      { challengerBountyBps: 10_001 },
      { treasury: ethers.ZeroAddress },
    ]) {
      const call = monadb.connect(admin).updateConfig({ ...params, ...bad });
      await expect(call).to.be.reverted;
    }
    await monadb.connect(admin).updateConfig({ ...params, pricePerMib: 5n });
    expect((await monadb.getConfig()).pricePerMib).to.equal(5n);
    await expect(ethers.deployContract("MonaDB", [{ ...params, epochSeconds: 0 }])).to.be.reverted;
  });

  it("transfers the admin role", async () => {
    const { monadb, admin, alice } = await deploy();
    await expect(monadb.connect(admin).transferAdmin(ethers.ZeroAddress)).to.be.revertedWithCustomError(monadb, "ZeroAddress");
    await monadb.connect(admin).transferAdmin(alice.address);
    expect(await monadb.admin()).to.equal(alice.address);
    await expect(monadb.connect(admin).transferAdmin(admin.address)).to.be.revertedWithCustomError(monadb, "NotAdmin");
  });

  it("lets the admin approve replicators, which manage their endpoint", async () => {
    const { monadb, admin, alice, replicators: [r1, r2] } = await deploy();
    await expect(monadb.connect(alice).registerReplicator(r1.address, "http://x")).to.be.revertedWithCustomError(monadb, "NotAdmin");
    await expect(monadb.connect(admin).registerReplicator(r1.address, "")).to.be.revertedWithCustomError(monadb, "InvalidEndpoint");
    await expect(monadb.connect(admin).registerReplicator(r1.address, "x".repeat(129))).to.be.revertedWithCustomError(monadb, "InvalidEndpoint");
    await expect(monadb.connect(admin).registerReplicator(r1.address, "http://node-1"))
      .to.emit(monadb, "ReplicatorUpdated")
      .withArgs(r1.address, true, "http://node-1");
    await expect(monadb.connect(admin).registerReplicator(r1.address, "http://again")).to.be.revertedWithCustomError(monadb, "ReplicatorExists");
    await monadb.connect(admin).registerReplicator(r2.address, "http://node-2");

    await monadb.connect(r1).updateReplicatorEndpoint("https://node-1.example");
    await expect(monadb.connect(alice).updateReplicatorEndpoint("https://x")).to.be.revertedWithCustomError(monadb, "UnknownReplicator");
    await monadb.connect(admin).setReplicatorActive(r2.address, false);

    const [authorities, list] = await monadb.getReplicators(0, 10);
    expect(authorities).to.deep.equal([r1.address, r2.address]);
    expect(list[0].endpoint).to.equal("https://node-1.example");
    expect(list[1].active).to.equal(false);
    expect(await monadb.replicatorCount()).to.equal(2n);
    const [page] = await monadb.getReplicators(1, 10);
    expect(page).to.deep.equal([r2.address]);
    const [empty] = await monadb.getReplicators(5, 10);
    expect(empty).to.deep.equal([]);
  });

  it("registers and rotates identities", async () => {
    const { monadb, alice } = await deploy();
    await expect(monadb.connect(alice).registerIdentity(ethers.ZeroHash)).to.be.revertedWithCustomError(monadb, "InvalidEncryptionKey");
    await expect(monadb.connect(alice).updateIdentity(key())).to.be.revertedWithCustomError(monadb, "NotRegistered");
    const k1 = key();
    await expect(monadb.connect(alice).registerIdentity(k1)).to.emit(monadb, "IdentityRegistered").withArgs(alice.address, k1);
    await expect(monadb.connect(alice).registerIdentity(key())).to.be.revertedWithCustomError(monadb, "AlreadyRegistered");
    const k2 = key();
    await monadb.connect(alice).updateIdentity(k2);
    const identity = await monadb.getIdentity(alice.address);
    expect(identity.encryptionKey).to.equal(k2);
    expect(identity.recordNonce).to.equal(0n);
  });

  it("requires an identity to upload", async () => {
    const { monadb, alice } = await deploy();
    await expect(monadb.connect(alice).openChunk(chunkArgs(data(10)), ethers.ZeroAddress, { value: 10n ** 18n })).to.be.revertedWithCustomError(
      monadb,
      "NotRegistered",
    );
  });

  it("sends the accrued protocol share to the treasury", async () => {
    const { monadb, alice, treasury } = await deploy();
    await expect(monadb.withdrawProtocolFees()).to.be.revertedWithCustomError(monadb, "NothingToClaim");
    await registered(monadb, alice);
    await openChunk(monadb, alice, data(1000));
    const fees = await monadb.protocolFees();
    expect(fees).to.be.greaterThan(0n);
    await expect(monadb.withdrawProtocolFees()).to.changeEtherBalance(treasury, fees);
    expect(await monadb.protocolFees()).to.equal(0n);
  });
});

describe("MonaDB: chunks", () => {
  it("splits the fee between the protocol and the escrow and returns extra value", async () => {
    const { monadb, params, alice } = await deploy();
    await registered(monadb, alice);
    const bytes = data(5000);
    const fee = quote(params, 5000n, 3n);
    expect(await monadb.quoteChunk(5000, 3)).to.equal(fee);
    const args = chunkArgs(bytes, { replicas: 3 });
    const tx = monadb.connect(alice).openChunk(args, ethers.ZeroAddress, { value: fee + 12345n });
    await expect(tx).to.changeEtherBalances([alice, monadb], [-fee, fee]);
    const id = await monadb.chunkId(alice.address, args.contentHash);
    const chunk = await monadb.getChunk(id);
    const protocol = (fee * 1000n) / 10_000n;
    const reward = (fee - protocol) / 3n;
    expect(chunk.rewardPerReplica).to.equal(reward);
    expect(await monadb.protocolFees()).to.equal(fee - reward * 3n);
    expect(chunk.owner).to.equal(alice.address);
    expect(chunk.writer).to.equal(alice.address);
  });

  it("validates its arguments", async () => {
    const { monadb, params, alice } = await deploy();
    await registered(monadb, alice);
    const big = 10n ** 18n;
    const open = (args: any) => monadb.connect(alice).openChunk(args, ethers.ZeroAddress, { value: big });
    const base = chunkArgs(data(100));
    await expect(open({ ...base, size: 0 })).to.be.revertedWithCustomError(monadb, "InvalidSize");
    await expect(open({ ...base, size: 16 * 1024 * 1024 + 1 })).to.be.revertedWithCustomError(monadb, "InvalidSize");
    await expect(open({ ...base, size: 4 * 1024 * 1024 + 1, segmentSize: 1024 })).to.be.revertedWithCustomError(monadb, "InvalidSize");
    await expect(open({ ...base, segmentSize: 31 })).to.be.revertedWithCustomError(monadb, "InvalidSegmentSize");
    await expect(open({ ...base, segmentSize: 96 * 1024 + 1 })).to.be.revertedWithCustomError(monadb, "InvalidSegmentSize");
    await expect(open({ ...base, size: 4096 * 32 + 1, segmentSize: 32 })).to.be.revertedWithCustomError(monadb, "TooManySegments");
    await expect(open({ ...base, replicas: 0 })).to.be.revertedWithCustomError(monadb, "InvalidReplicas");
    await expect(open({ ...base, replicas: 17 })).to.be.revertedWithCustomError(monadb, "InvalidReplicas");
    const fee = quote(params, 100n, 2n);
    await expect(open({ ...base, maxFee: fee - 1n }))
      .to.be.revertedWithCustomError(monadb, "FeeAboveMax")
      .withArgs(fee, fee - 1n);
    await expect(monadb.connect(alice).openChunk(base, ethers.ZeroAddress, { value: fee - 1n }))
      .to.be.revertedWithCustomError(monadb, "InsufficientPayment")
      .withArgs(fee, fee - 1n);
    await open(base);
    await expect(open(base)).to.be.revertedWithCustomError(monadb, "ChunkExists");
  });

  it("prices storage per MiB, pro rata to the byte", async () => {
    const { monadb, params } = await deploy();
    expect(await monadb.quoteChunk(MIB, 1)).to.equal(params.baseFeePerReplica + params.pricePerMib);
    expect(await monadb.quoteChunk(MIB / 2n, 2)).to.equal(2n * (params.baseFeePerReplica + params.pricePerMib / 2n));
    expect(await monadb.quoteChunk(1, 1)).to.equal(params.baseFeePerReplica + (params.pricePerMib + MIB - 1n) / MIB);
  });

  it("turns a ledger chunk Hot once every segment is in the logs", async () => {
    const { monadb, alice, bob } = await deploy();
    await registered(monadb, alice);
    const bytes = data(2500);
    const id = await openChunk(monadb, alice, bytes, { segmentSize: 1000 });
    let chunk = await monadb.getChunk(id);
    expect(chunk.state).to.equal(Pending);
    expect(chunk.segmentsTotal).to.equal(3n);
    expect(await monadb.pendingChunkCount()).to.equal(0n);

    await expect(monadb.connect(bob).writeSegment(id, 0, bytes.subarray(0, 1000))).to.be.revertedWithCustomError(monadb, "NotWriter");
    await expect(monadb.connect(alice).writeSegment(id, 3, bytes.subarray(0, 1000))).to.be.revertedWithCustomError(monadb, "InvalidSegmentIndex");
    await expect(monadb.connect(alice).writeSegment(id, 2, bytes.subarray(2000, 2400))).to.be.revertedWithCustomError(monadb, "InvalidSegmentLength");
    await expect(monadb.connect(alice).writeSegment(id, 1, bytes.subarray(1000, 2000)))
      .to.emit(monadb, "SegmentWritten")
      .withArgs(id, 1, hexlify(bytes.subarray(1000, 2000)));
    await expect(monadb.connect(alice).writeSegment(id, 1, bytes.subarray(1000, 2000))).to.be.revertedWithCustomError(monadb, "SegmentAlreadyWritten");
    expect(await monadb.isSegmentWritten(id, 1)).to.equal(true);
    expect(await monadb.isSegmentWritten(id, 0)).to.equal(false);
    await monadb.connect(alice).writeSegment(id, 0, bytes.subarray(0, 1000));
    await expect(monadb.connect(alice).writeSegment(id, 2, bytes.subarray(2000))).to.emit(monadb, "ChunkCompleted").withArgs(id, alice.address, 2500);

    chunk = await monadb.getChunk(id);
    expect(chunk.state).to.equal(Hot);
    expect(chunk.needsReplicas).to.equal(true);
    expect(chunk.completedBlock).to.be.greaterThan(chunk.openedBlock);
    expect(await monadb.pendingChunks(0, 10)).to.deep.equal([id]);
    await expect(monadb.connect(alice).writeSegment(id, 0, bytes.subarray(0, 1000))).to.be.revertedWithCustomError(monadb, "ChunkNotPending");
  });

  it("lets a session key write the segments", async () => {
    const { monadb, alice, bob } = await deploy();
    await registered(monadb, alice);
    const bytes = data(300);
    const id = await openChunk(monadb, alice, bytes, { segmentSize: 100, writer: bob.address });
    await expect(monadb.connect(alice).writeSegment(id, 0, bytes.subarray(0, 100))).to.be.revertedWithCustomError(monadb, "NotWriter");
    await writeAll(monadb, bob, id, bytes, 100);
    expect((await monadb.getChunk(id)).state).to.equal(Hot);
  });

  it("has no short segment when the size divides evenly", async () => {
    const { monadb, alice } = await deploy();
    await registered(monadb, alice);
    const bytes = data(4096);
    const id = await openChunk(monadb, alice, bytes, { segmentSize: 1024 });
    expect((await monadb.getChunk(id)).segmentsTotal).to.equal(4n);
    await writeAll(monadb, alice, id, bytes, 1024);
    expect((await monadb.getChunk(id)).state).to.equal(Hot);
  });

  it("pays replicators on confirmation, cools the chunk and closes it at the last replica", async () => {
    const { monadb, admin, alice, replicators: [r1, r2, r3] } = await deploy();
    await registered(monadb, alice);
    await withReplicators(monadb, admin, [r1, r2, r3]);
    const id = await openChunk(monadb, alice, data(1000), { replicas: 3 });
    const reward = (await monadb.getChunk(id)).rewardPerReplica;
    expect(await monadb.pendingChunks(0, 10)).to.deep.equal([id]);

    await expect(monadb.connect(r1).confirmReplication(id)).to.changeEtherBalances([r1, monadb], [reward, -reward]);
    await expect(monadb.connect(r1).confirmReplication(id)).to.be.revertedWithCustomError(monadb, "AlreadyReplicated");
    // ⌊3 × 60 / 100⌋ = 1 confirmation turns it Cool; it stays in the queue until full
    const chunk = await monadb.getChunk(id);
    expect(chunk.state).to.equal(Cool);
    expect(chunk.needsReplicas).to.equal(true);
    expect(chunk.confirmedReplicas).to.equal(1n);
    expect(chunk.replicators).to.deep.equal([r1.address]);

    await expect(monadb.connect(r2).confirmReplication(id)).to.emit(monadb, "ReplicationConfirmed").withArgs(id, r2.address, reward, 2, 3);
    await expect(monadb.connect(r3).confirmReplication(id))
      .to.emit(monadb, "ChunkClosed")
      .withArgs(id, alice.address, 0);
    expect((await monadb.getChunk(id)).state).to.equal(None);
    expect(await monadb.pendingChunkCount()).to.equal(0n);
    expect(await monadb.chunkCountOf(alice.address)).to.equal(0n);
    const info = await monadb.getReplicator(r1.address);
    expect(info.confirmations).to.equal(1n);
    expect(info.earned).to.equal(reward);
  });

  it("cools at the threshold: a majority for larger replica counts", async () => {
    const { monadb, admin, alice, replicators } = await deploy();
    await registered(monadb, alice);
    await withReplicators(monadb, admin, replicators);
    const id = await openChunk(monadb, alice, data(1000), { replicas: 5 });
    // 5 × 60 % = 3 confirmations
    await monadb.connect(replicators[0]).confirmReplication(id);
    await monadb.connect(replicators[1]).confirmReplication(id);
    expect((await monadb.getChunk(id)).state).to.equal(Hot);
    await expect(monadb.connect(replicators[2]).confirmReplication(id)).to.emit(monadb, "ChunkCooled").withArgs(id, 3);
    expect((await monadb.getChunk(id)).state).to.equal(Cool);
    expect((await monadb.getChunk(id)).needsReplicas).to.equal(true);
  });

  it("cools a two-replica chunk at the first confirmation", async () => {
    const { monadb, admin, alice, replicators: [r1] } = await deploy();
    await registered(monadb, alice);
    await withReplicators(monadb, admin, [r1]);
    const id = await openChunk(monadb, alice, data(10), { replicas: 2 });
    await expect(monadb.connect(r1).confirmReplication(id)).to.emit(monadb, "ChunkCooled");
  });

  it("only takes confirmations from active registered replicators", async () => {
    const { monadb, admin, alice, bob, replicators: [r1] } = await deploy();
    await registered(monadb, alice);
    await withReplicators(monadb, admin, [r1]);
    const id = await openChunk(monadb, alice, data(10));
    await expect(monadb.connect(bob).confirmReplication(id)).to.be.revertedWithCustomError(monadb, "ReplicatorInactive");
    await monadb.connect(admin).setReplicatorActive(r1.address, false);
    await expect(monadb.connect(r1).confirmReplication(id)).to.be.revertedWithCustomError(monadb, "ReplicatorInactive");
    await monadb.connect(admin).setReplicatorActive(r1.address, true);
    await monadb.connect(r1).confirmReplication(id);
  });

  it("does not take confirmations for incomplete ledger chunks", async () => {
    const { monadb, admin, alice, replicators: [r1] } = await deploy();
    await registered(monadb, alice);
    await withReplicators(monadb, admin, [r1]);
    const id = await openChunk(monadb, alice, data(100), { segmentSize: 50 });
    await expect(monadb.connect(r1).confirmReplication(id)).to.be.revertedWithCustomError(monadb, "ChunkIncomplete");
    await expect(monadb.connect(r1).confirmReplication(ethers.ZeroHash)).to.be.revertedWithCustomError(monadb, "ChunkNotFound");
  });

  it("confirms batches, skipping chunks it cannot take", async () => {
    const { monadb, admin, alice, replicators: [r1, r2] } = await deploy();
    await registered(monadb, alice);
    await withReplicators(monadb, admin, [r1, r2]);
    const a = await openChunk(monadb, alice, data(10, 1), { replicas: 1 });
    const b = await openChunk(monadb, alice, data(10, 2), { replicas: 2 });
    const pending = await openChunk(monadb, alice, data(100, 3), { segmentSize: 50 });
    await monadb.connect(r2).confirmReplication(a); // filled by someone else
    const reward = (await monadb.getChunk(b)).rewardPerReplica;
    const ids = [a, b, pending, ethers.ZeroHash, b];
    expect(await monadb.connect(r1).confirmReplications.staticCall(ids)).to.equal(1n);
    await expect(monadb.connect(r1).confirmReplications(ids)).to.changeEtherBalance(r1, reward);
    expect((await monadb.getChunk(b)).confirmedReplicas).to.equal(1n);
  });

  it("lets a replicator confirm its own upload", async () => {
    const { monadb, admin, replicators: [r1] } = await deploy();
    await registered(monadb, r1);
    await withReplicators(monadb, admin, [r1]);
    const id = await openChunk(monadb, r1, data(10), { replicas: 1 });
    await monadb.connect(r1).confirmReplication(id);
    expect((await monadb.getChunk(id)).state).to.equal(None);
  });

  it("returns the rewards of unfilled slots after the replication window", async () => {
    const { monadb, admin, alice, bob, replicators: [r1, r2] } = await deploy();
    await registered(monadb, alice);
    await withReplicators(monadb, admin, [r1, r2]);
    const id = await openChunk(monadb, alice, data(10), { replicas: 3 });
    await monadb.connect(r1).confirmReplication(id);
    const reward = (await monadb.getChunk(id)).rewardPerReplica;
    await expect(monadb.connect(alice).reclaimUnreplicated(id)).to.be.revertedWithCustomError(monadb, "ReplicationWindowOpen");
    await time.increase(7 * DAY);
    await expect(monadb.connect(bob).reclaimUnreplicated(id)).to.be.revertedWithCustomError(monadb, "NotOwner");
    await expect(monadb.connect(alice).reclaimUnreplicated(id)).to.changeEtherBalance(alice, reward * 2n);
    await expect(monadb.connect(alice).reclaimUnreplicated(id)).to.be.revertedWithCustomError(monadb, "ReplicationClosed");
    await expect(monadb.connect(r2).confirmReplication(id)).to.be.revertedWithCustomError(monadb, "ReplicationClosed");
    expect(await monadb.pendingChunkCount()).to.equal(0n);
    // close after reclaiming: nothing left to refund
    await expect(monadb.connect(alice).closeChunk(id)).to.emit(monadb, "ChunkClosed").withArgs(id, alice.address, 0);
  });

  it("closes a chunk with its unspent escrow when settled", async () => {
    const { monadb, admin, alice, replicators: [r1] } = await deploy();
    await registered(monadb, alice);
    await withReplicators(monadb, admin, [r1]);
    // a pending ledger upload can be aborted at any time
    const pending = await openChunk(monadb, alice, data(100, 1), { segmentSize: 50, replicas: 2 });
    const reward = (await monadb.getChunk(pending)).rewardPerReplica;
    await expect(monadb.connect(alice).closeChunk(pending)).to.changeEtherBalance(alice, reward * 2n);
    expect(await monadb.isChunkClosable(pending)).to.equal(false);

    // a Hot chunk inside its window cannot
    const hot = await openChunk(monadb, alice, data(100, 2), { segmentSize: 50, replicas: 2 });
    await writeAll(monadb, alice, hot, data(100, 2), 50);
    await monadb.connect(r1).confirmReplication(hot);
    await expect(monadb.connect(alice).closeChunk(hot)).to.be.revertedWithCustomError(monadb, "ChunkNotSettled");
    await time.increase(7 * DAY);
    expect(await monadb.isChunkClosable(hot)).to.equal(true);
    await expect(monadb.connect(alice).closeChunk(hot)).to.changeEtherBalance(alice, reward);
  });

  it("puts direct chunks in the work queue right away, up to 16 MiB", async () => {
    const { monadb, alice } = await deploy();
    await registered(monadb, alice);
    const id = await openChunk(monadb, alice, data(10), { segmentSize: 0 });
    const chunk = await monadb.getChunk(id);
    expect(chunk.state).to.equal(Hot);
    expect(chunk.segmentsTotal).to.equal(0n);
    expect(await monadb.pendingChunks(0, 10)).to.deep.equal([id]);
    await expect(monadb.connect(alice).writeSegment(id, 0, "0x00")).to.be.revertedWithCustomError(monadb, "ChunkNotPending");

    const args = { ...chunkArgs(data(10, 9)), size: 16 * 1024 * 1024 };
    const fee = await monadb.quoteChunk(args.size, 2);
    await monadb.connect(alice).openChunk(args, ethers.ZeroAddress, { value: fee });
  });

  it("lets an unconfirmed direct chunk be closed after the abort delay", async () => {
    const { monadb, alice } = await deploy();
    await registered(monadb, alice);
    const id = await openChunk(monadb, alice, data(10), { replicas: 2 });
    const reward = (await monadb.getChunk(id)).rewardPerReplica;
    await expect(monadb.connect(alice).closeChunk(id)).to.be.revertedWithCustomError(monadb, "ChunkNotSettled");
    await time.increase(600);
    await expect(monadb.connect(alice).closeChunk(id)).to.changeEtherBalance(alice, reward * 2n);
    expect(await monadb.pendingChunkCount()).to.equal(0n);
    // the same content can be uploaded again
    await openChunk(monadb, alice, data(10), { replicas: 2 });
  });

  it("lists the open chunks of an owner", async () => {
    const { monadb, alice } = await deploy();
    await registered(monadb, alice);
    const a = await openChunk(monadb, alice, data(10, 1));
    const b = await openChunk(monadb, alice, data(10, 2));
    expect(await monadb.chunksOf(alice.address, 0, 10)).to.deep.equal([a, b]);
    expect(await monadb.chunksOf(alice.address, 1, 1)).to.deep.equal([b]);
    expect(await monadb.getChunks([a, ethers.ZeroHash])).to.have.length(2);
  });

  it("measures gas the way Monad charges it", async () => {
    const { monadb, alice } = await deploy();
    await registered(monadb, alice);
    const bytes = data(48 * 1024);
    const id = await openChunk(monadb, alice, bytes, { segmentSize: 48 * 1024 });
    const tx = await monadb.connect(alice).writeSegment(id, 0, bytes);
    const receipt = await tx.wait();
    // calldata dominates: ~16–40 gas per byte depending on the fork's calldata floor
    expect(receipt.gasUsed).to.be.greaterThan(48n * 1024n * 10n);
    expect(await gasCost(tx)).to.be.greaterThan(0n);
    expect(sha(bytes)).to.equal((await monadb.getChunk(id)).contentHash);
  });
});

describe("MonaDB: defaults", () => {
  it("rejects a zero treasury at deployment", async () => {
    const [admin] = await ethers.getSigners();
    await expect(ethers.deployContract("MonaDB", [defaultParams(ethers.ZeroAddress)])).to.be.reverted;
    expect(admin.address).to.not.equal(ethers.ZeroAddress);
  });
});
