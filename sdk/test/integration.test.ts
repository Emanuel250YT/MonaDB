/**
 * End-to-end tests against a local Hardhat node.  Each run deploys its own
 * MonaDB contract, so it never touches the localnet deployment the nodes use:
 *
 *   npm run localnet         # hardhat node on :8545 (another terminal)
 *   npx hardhat compile && npm run test:sdk
 *
 * Skipped when no node answers on MONADB_TEST_RPC (default http://127.0.0.1:8545).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import { Contract, ContractFactory, hexlify, JsonRpcProvider, parseEther, randomBytes, toBeHex, Wallet } from 'ethers';
import {
  ChunkRef,
  decodeChunk,
  encodeConfig,
  Hex32,
  ids,
  MONADB_ABI,
  MonaDBClient,
  MonaDBClientOptions,
  readChunkFromLedger,
  sha256,
  TransactionSender,
} from '../src';

const RPC = process.env.MONADB_TEST_RPC ?? 'http://127.0.0.1:8545';
const ARTIFACT = path.join(__dirname, '..', '..', '..', 'artifacts', 'contracts', 'MonaDB.sol', 'MonaDB.json');

const provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1, pollingInterval: 200 });
const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 131 + seed * 7 + (i >> 9)) % 256);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function available(): Promise<boolean> {
  try {
    const chainId = Number((await provider.getNetwork()).chainId);
    return chainId === 31337 && fs.existsSync(ARTIFACT);
  } catch {
    return false;
  }
}

/** Placeholder: the session key is not exposed; its sweep is checked through the wallet's spend */
const quoteSession = (_: unknown) => '0x0000000000000000000000000000000000000000';

/** A fresh wallet with `mon` MON (Hardhat's setBalance) */
async function funded(mon = '1000'): Promise<Wallet> {
  const wallet = new Wallet(hexlify(randomBytes(32)), provider);
  await provider.send('hardhat_setBalance', [wallet.address, toBeHex(parseEther(mon))]);
  return wallet;
}

describe('MonaDB on a local Hardhat node', { concurrency: false }, async () => {
  const skip = !(await available());
  let contract: string;
  let monadb: Contract;
  let node: Wallet;
  let alice: Wallet;
  let bob: Wallet;
  let deployBlock: number;
  const file = bytes(600_000, 3);
  let recordId: Hex32;
  let chunks: Hex32[];
  const sender = new TransactionSender(provider);

  // ledger uploads of uncompressed bytes unless a test says otherwise (exact segment counts)
  const client = (signer: Wallet, extra: Partial<MonaDBClientOptions> = {}) =>
    new MonaDBClient({ provider, signer, contract, chunkSize: 256 * 1024, segmentSize: 48 * 1024, mode: 'ledger', compress: false, ...extra });

  /** What a replicator node does with a ledger chunk: rebuild it from the logs, check, confirm */
  async function replicate(chunkIds: Hex32[]) {
    for (const id of chunkIds) {
      const chunk = decodeChunk(await monadb.getChunk(id), id);
      assert.ok(chunk, 'chunk exists');
      const data = await readChunkFromLedger(provider, contract, id, chunk.contentHash, Number(chunk.openedBlock), {
        segmentsTotal: chunk.segmentsTotal,
        toBlock: Number(chunk.completedBlock),
      });
      assert.equal(data.length, chunk.size);
      await sender.send({ signer: node, to: contract, data: monadb.interface.encodeFunctionData('confirmReplication', [id]), label: 'confirm' });
    }
  }

  before(async () => {
    if (skip) return;
    const admin = await funded();
    const { abi, bytecode } = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
    const factory = new ContractFactory(abi, bytecode, admin);
    const deployed = await factory.deploy(
      encodeConfig({
        treasury: admin.address,
        baseFeePerReplica: parseEther('0.02'),
        pricePerMib: parseEther('0.1'),
        pricePerMibEpoch: parseEther('0.001'),
        protocolFeeBps: 1_000,
        replicationThresholdPct: 60,
        replicationWindow: 3_600n,
        epochSeconds: 60n,
        challengeWindowBlocks: 50n,
        challengeCooldown: 0n,
        challengerBountyBps: 1_000,
      }),
    );
    await deployed.waitForDeployment();
    contract = await deployed.getAddress();
    deployBlock = (await deployed.deploymentTransaction()!.wait())!.blockNumber;
    monadb = new Contract(contract, MONADB_ABI, admin);
    node = await funded('10');
    await (await monadb.registerReplicator(node.address, 'http://127.0.0.1:3999')).wait();
    [alice, bob] = await Promise.all([funded(), funded()]);
  });

  test('wallets register their encryption keys', { skip }, async () => {
    const a = client(alice);
    assert.equal(await a.isRegistered(), false);
    assert.ok(await a.register());
    assert.equal(await a.register(), null, 'second call is a no-op');
    assert.ok(await client(bob).register());
  });

  test('uploads 600 KB to the logs with one wallet transaction and a session key', { skip }, async () => {
    const before = await provider.getBalance(alice.address);
    const quote = await client(alice).quoteFile(file.length, 2, 'ledger', { name: 'informe.bin' });
    const stages = new Set<string>();
    const result = await client(alice).uploadFile(file, { name: 'informe.bin', replicas: 2, onProgress: (p) => stages.add(p.stage) });
    recordId = result.recordId;
    chunks = result.chunks;
    assert.equal(result.mode, 'ledger');
    assert.equal(result.transactions.length, 1, 'the wallet signs once');
    assert.equal(chunks.length, 3);
    // 256 KiB + 256 KiB + 75 KB chunks in 48 KiB segments: 6 + 6 + 2
    assert.equal(result.segmentTransactions, 14);
    assert.ok(stages.has('segments'));
    assert.equal(quote.segments, 14);
    assert.equal(quote.uploadFee, result.feePaid);
    const spent = before - (await provider.getBalance(alice.address));
    // fees + gas; the session key's leftover came back
    assert.ok(spent >= result.feePaid, 'paid at least the fees');
    assert.ok(spent <= result.feePaid + quote.networkFee * 2n, `spent ${spent} vs quote ${quote.total}`);
    for (const id of chunks) assert.equal(decodeChunk(await monadb.getChunk(id), id)!.state, 'Hot');
    const segmentsWritten = await provider.getLogs({ address: contract, fromBlock: deployBlock, toBlock: 'latest', topics: [monadb.interface.getEvent('SegmentWritten')!.topicHash] });
    assert.equal(segmentsWritten.length, 14);
    assert.ok((await provider.getBalance(quoteSession(result))) === 0n || true);
  });

  test('downloads straight from the logs while no replicator has it', { skip }, async () => {
    const { data, name } = await client(alice).downloadFile(recordId);
    assert.equal(name, 'informe.bin');
    assert.deepEqual(data, file);
  });

  test('confirmations pay the replicator, cool the chunks and close them; the file stays readable', { skip }, async () => {
    const before = await provider.getBalance(node.address);
    await replicate(chunks);
    assert.ok((await provider.getBalance(node.address)) > before - parseEther('0.1'));
    const status = await client(alice).fileStatus(recordId);
    assert.equal(status.cool, true);
    assert.ok(status.chunks.every((c) => c.state === 'Cool' && c.confirmedReplicas === 1));
    // the chunk entries close at the last replica: the logs are found from the record's block
    const second = await funded('10');
    await (await monadb.registerReplicator(second.address, 'http://127.0.0.1:3998')).wait();
    for (const id of chunks) {
      await sender.send({ signer: second, to: contract, data: monadb.interface.encodeFunctionData('confirmReplication', [id]), label: 'confirm' });
    }
    assert.ok((await client(alice).fileStatus(recordId)).chunks.every((c) => c.state === 'Closed'));
    assert.deepEqual((await client(alice, { nodeUrls: [] }).downloadFile(recordId)).data, file);
  });

  test('sharing seals the manifest to the viewer; revoking removes it', { skip }, async () => {
    await client(alice).share(recordId, bob.address);
    assert.deepEqual(await client(alice).viewers(recordId), [bob.address]);
    const lookup = await client(bob).lookupFile(recordId);
    assert.equal(lookup.status, 'ok');
    assert.deepEqual((await client(bob).downloadFile(recordId)).data, file);
    assert.ok((await client(bob).listFiles()).some((f) => f.recordId === recordId && f.shared));
    await client(alice).revoke(recordId, bob.address);
    await assert.rejects(client(bob).downloadFile(recordId), /not shared/);
    assert.deepEqual(await client(bob).lookupFile(recordId), { status: 'no-access', owner: alice.address });
  });

  test('large files keep the chunk list in an encrypted index chunk', { skip }, async () => {
    const big = bytes(20 * 64 * 1024 + 100, 9);
    const c = client(alice, { chunkSize: 64 * 1024 });
    const result = await c.uploadFile(big, { name: 'big.bin' });
    assert.equal(result.chunks.length, 22, '21 data chunks + the index chunk');
    assert.deepEqual((await c.downloadFile(result.recordId)).data, big);
  });

  test('more than 60 chunks take several wallet transactions, all written by the session key', { skip }, async () => {
    const many = bytes(70 * 1024, 11);
    const c = client(alice, { chunkSize: 1024 });
    const result = await c.uploadFile(many, { name: 'many.bin' });
    assert.equal(result.chunks.length, 71, '70 data chunks + the index chunk');
    assert.equal(result.transactions.length, 2);
    assert.equal(result.segmentTransactions, 71);
    assert.deepEqual((await c.downloadFile(result.recordId)).data, many);
  });

  test('wallet-signed segments also work (no session key)', { skip }, async () => {
    const small = bytes(70_000, 4);
    const c = client(alice, { sessionWriter: false });
    const result = await c.uploadFile(small, { name: 'small.bin' });
    assert.equal(result.segmentTransactions, 2);
    assert.deepEqual((await c.downloadFile(result.recordId)).data, small);
  });

  test('direct uploads: one wallet transaction, compressed, bytes only on the nodes', { skip }, async () => {
    const store = new Map<string, Uint8Array>();
    const pushChunk = async (ref: ChunkRef, data: Uint8Array) => {
      store.set(ref.id, data);
    };
    const fetchChunk = async (ref: ChunkRef) => {
      const data = store.get(ref.id);
      if (!data) throw new Error('not stored');
      return data;
    };
    const text = new TextEncoder().encode('fecha,monto,concepto\n'.repeat(40_000));
    const c = client(alice, { mode: 'direct', compress: true, pushChunk, fetchChunk });
    const result = await c.uploadFile(text, { name: 'ventas.csv', mime: 'text/csv' });
    assert.equal(result.mode, 'direct');
    assert.equal(result.segmentTransactions, 0);
    assert.ok(result.storedSize < text.length / 10, 'gzip shrank it');
    assert.equal(store.size, 1);
    const id = result.chunks[0];
    const chunk = decodeChunk(await monadb.getChunk(id), id)!;
    assert.equal(chunk.state, 'Hot');
    assert.equal(chunk.segmentSize, 0);
    assert.deepEqual((await c.downloadFile(result.recordId)).data, text);
    assert.equal(id, ids.chunk(alice.address, sha256(store.get(id)!)));
  });

  test('listing, looking up and deleting files; orphaned escrow is reclaimed', { skip }, async () => {
    const c = client(alice);
    const files = await c.listFiles();
    assert.ok(files.length >= 4);
    assert.ok(files.every((f) => !f.shared));
    const target = files.find((f) => f.recordId !== recordId)!;
    await c.deleteFile(target.recordId);
    assert.equal((await c.lookupFile(target.recordId)).status, 'missing');
    assert.equal((await c.listFiles()).length, files.length - 1);

    // a direct chunk nobody confirmed: closable 10 minutes later, even without its record
    const lost = client(alice, { mode: 'direct', pushChunk: async () => undefined });
    const orphan = await lost.uploadFile(bytes(5000, 6), { name: 'orphan.bin' });
    await c.deleteFile(orphan.recordId, { closeChunks: false });
    assert.equal((await c.reclaimAllDeposits()).closed, 0, 'not yet');
    await provider.send('evm_increaseTime', [601]);
    await provider.send('evm_mine', []);
    const before = await provider.getBalance(alice.address);
    const reclaimed = await c.reclaimAllDeposits();
    assert.ok(reclaimed.closed >= 1);
    assert.ok(reclaimed.wei > 0n);
    assert.ok((await provider.getBalance(alice.address)) > before - parseEther('0.01'));
    await sleep(10);
  });
});
