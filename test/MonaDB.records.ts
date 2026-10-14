import { expect } from "chai";
import { ethers } from "hardhat";
import { hexlify, solidityPackedKeccak256 } from "ethers";
import { chunkArgs, data, deploy, quote, quoteBlob, registered, sha } from "./helpers";

const content = (n = 200, seed = 1) => hexlify(data(n, seed));

describe("MonaDB: records and grants", () => {
  it("addresses records by owner and nonce", async () => {
    const { monadb, alice } = await deploy();
    await registered(monadb, alice);
    const id0 = await monadb.recordId(alice.address, 0);
    expect(id0).to.equal(solidityPackedKeccak256(["string", "address", "uint64"], ["record", alice.address, 0]));
    await expect(monadb.connect(alice).createRecord("monadb.file.v3", content()))
      .to.emit(monadb, "RecordCreated")
      .withArgs(id0, alice.address, "monadb.file.v3");
    await monadb.connect(alice).createRecord("monadb.file.v3", content(10, 2));
    const id1 = await monadb.recordId(alice.address, 1);
    const record = await monadb.getRecord(id1);
    expect(record.owner).to.equal(alice.address);
    expect(record.nonce).to.equal(1n);
    expect(record.content).to.equal(content(10, 2));
    expect((await monadb.getIdentity(alice.address)).recordNonce).to.equal(2n);
    expect(await monadb.recordsOf(alice.address, 0, 10)).to.deep.equal([id0, id1]);
    expect(await monadb.recordsOf(alice.address, 1, 1)).to.deep.equal([id1]);
    expect(await monadb.recordsOf(alice.address, 5, 1)).to.deep.equal([]);
  });

  it("bounds the content and requires an identity", async () => {
    const { monadb, alice, bob } = await deploy();
    await expect(monadb.connect(bob).createRecord("s", content())).to.be.revertedWithCustomError(monadb, "NotRegistered");
    await registered(monadb, alice);
    await expect(monadb.connect(alice).createRecord("s", "0x")).to.be.revertedWithCustomError(monadb, "InvalidContent");
    await expect(monadb.connect(alice).createRecord("s", content(2049))).to.be.revertedWithCustomError(monadb, "InvalidContent");
    await expect(monadb.connect(alice).createRecord("x".repeat(33), content())).to.be.revertedWithCustomError(monadb, "InvalidSchema");
    await monadb.connect(alice).createRecord("x".repeat(32), content(2048));
  });

  it("lets only the owner update a record", async () => {
    const { monadb, alice, bob } = await deploy();
    await registered(monadb, alice, bob);
    await monadb.connect(alice).createRecord("s", content(100));
    const id = await monadb.recordId(alice.address, 0);
    await expect(monadb.connect(bob).updateRecord(id, content(5))).to.be.revertedWithCustomError(monadb, "NotOwner");
    await expect(monadb.connect(alice).updateRecord(ethers.ZeroHash, content(5))).to.be.revertedWithCustomError(monadb, "RecordNotFound");
    await monadb.connect(alice).updateRecord(id, content(1500, 3));
    expect((await monadb.getRecord(id)).content).to.equal(content(1500, 3));
    await monadb.connect(alice).updateRecord(id, content(5, 4));
    expect((await monadb.getRecord(id)).content).to.equal(content(5, 4));
  });

  it("gives each viewer its own sealed copy", async () => {
    const { monadb, alice, bob, carol } = await deploy();
    await registered(monadb, alice, bob);
    await monadb.connect(alice).createRecord("s", content());
    const id = await monadb.recordId(alice.address, 0);
    await expect(monadb.connect(alice).grantAccess(id, carol.address, content(50))).to.be.revertedWithCustomError(monadb, "NotRegistered");
    await expect(monadb.connect(alice).grantAccess(id, alice.address, content(50))).to.be.revertedWithCustomError(monadb, "CannotGrantSelf");
    await expect(monadb.connect(bob).grantAccess(id, bob.address, content(50))).to.be.revertedWithCustomError(monadb, "NotOwner");
    await expect(monadb.connect(alice).grantAccess(id, bob.address, content(50, 9)))
      .to.emit(monadb, "AccessGranted")
      .withArgs(id, alice.address, bob.address);
    const grant = await monadb.getGrant(id, bob.address);
    expect(grant.content).to.equal(content(50, 9));
    expect(await monadb.viewersOf(id)).to.deep.equal([bob.address]);
    expect(await monadb.grantsTo(bob.address, 0, 10)).to.deep.equal([id]);

    // granting again replaces the copy
    await monadb.connect(alice).grantAccess(id, bob.address, content(60, 8));
    expect((await monadb.getGrant(id, bob.address)).content).to.equal(content(60, 8));
    expect((await monadb.getGrant(id, bob.address)).grantedAt).to.equal(grant.grantedAt);
    expect(await monadb.grantCountTo(bob.address)).to.equal(1n);

    await expect(monadb.connect(alice).revokeAccess(id, carol.address)).to.be.revertedWithCustomError(monadb, "GrantNotFound");
    await expect(monadb.connect(alice).revokeAccess(id, bob.address)).to.emit(monadb, "AccessRevoked").withArgs(id, alice.address, bob.address);
    expect(await monadb.viewersOf(id)).to.deep.equal([]);
    expect(await monadb.grantsTo(bob.address, 0, 10)).to.deep.equal([]);
    expect((await monadb.getGrant(id, bob.address)).grantedAt).to.equal(0n);
  });

  it("revokes every grant when the record is deleted", async () => {
    const { monadb, alice, bob, carol } = await deploy();
    await registered(monadb, alice, bob, carol);
    await monadb.connect(alice).createRecord("s", content());
    const id = await monadb.recordId(alice.address, 0);
    await monadb.connect(alice).grantAccess(id, bob.address, content(40));
    await monadb.connect(alice).grantAccess(id, carol.address, content(40));
    await expect(monadb.connect(bob).deleteRecord(id)).to.be.revertedWithCustomError(monadb, "NotOwner");
    await expect(monadb.connect(alice).deleteRecord(id)).to.emit(monadb, "RecordDeleted").withArgs(id, alice.address);
    expect((await monadb.getRecord(id)).owner).to.equal(ethers.ZeroAddress);
    expect(await monadb.grantsTo(bob.address, 0, 10)).to.deep.equal([]);
    expect(await monadb.grantsTo(carol.address, 0, 10)).to.deep.equal([]);
    expect(await monadb.recordsOf(alice.address, 0, 10)).to.deep.equal([]);
  });
});

describe("MonaDB: upload (one wallet transaction)", () => {
  it("opens chunks and blobs, creates the record and funds the session writer", async () => {
    const { monadb, params, alice, bob } = await deploy();
    await registered(monadb, alice);
    const a = data(1000, 1);
    const b = data(3000, 2);
    const chunks = [chunkArgs(a, { segmentSize: 500, replicas: 2 }), chunkArgs(b, { segmentSize: 1000, replicas: 2 })];
    const blob = {
      root: sha(data(32, 5)),
      dataShards: 2,
      totalShards: 3,
      shardSize: 4096,
      payloadSize: 8000,
      epochs: 12,
      maxFee: ethers.MaxUint256,
    };
    const fees = quote(params, 1000n, 2n) + quote(params, 3000n, 2n) + quoteBlob(params, 4096n, 3n, 12n);
    const funding = ethers.parseEther("0.5");
    const tx = monadb.connect(alice).upload(chunks, [blob], bob.address, "monadb.file.v2", content(120));
    await expect(monadb.connect(alice).upload(chunks, [blob], bob.address, "monadb.file.v2", content(120), { value: fees - 1n }))
      .to.be.revertedWithCustomError(monadb, "InsufficientPayment");
    await expect(monadb.connect(alice).upload(chunks, [blob], bob.address, "monadb.file.v2", content(120), { value: fees + funding }))
      .to.changeEtherBalances([alice, bob, monadb], [-(fees + funding), funding, fees]);
    void tx;

    const record = await monadb.recordId(alice.address, 0);
    expect((await monadb.getRecord(record)).schema).to.equal("monadb.file.v2");
    const id = await monadb.chunkId(alice.address, sha(a));
    expect((await monadb.getChunk(id)).writer).to.equal(bob.address);
    await monadb.connect(bob).writeSegment(id, 0, a.subarray(0, 500));
    const blobId = await monadb.blobId(alice.address, blob.root);
    expect((await monadb.getBlob(blobId)).totalShards).to.equal(3n);
    expect(await monadb.blobsOf(alice.address, 0, 10)).to.deep.equal([blobId]);
  });

  it("returns extra value to the caller without a session writer and can skip the record", async () => {
    const { monadb, params, alice } = await deploy();
    await registered(monadb, alice);
    const chunks = [chunkArgs(data(10))];
    const fee = quote(params, 10n, 2n);
    await expect(monadb.connect(alice).upload(chunks, [], ethers.ZeroAddress, "", "0x", { value: fee + 999n })).to.changeEtherBalance(alice, -fee);
    expect((await monadb.getIdentity(alice.address)).recordNonce).to.equal(0n);
  });
});
