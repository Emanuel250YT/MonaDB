/**
 * Blob end-to-end tests against a local Hardhat node, with in-process
 * "nodes" that do what monadb-node does over HTTP: accept shard pushes,
 * check them against the on-chain root, confirmShard, serve roots and
 * fragments with proofs, and answer storage challenges.  Each run deploys
 * its own contract (short epochs, no challenge cooldown).
 *
 * Skipped when no node answers on MONADB_TEST_RPC (default http://127.0.0.1:8545).
 */
import assert from 'node:assert/strict';
import { randomBytes as nodeRandom } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Contract, ContractFactory, hexlify, JsonRpcProvider, parseEther, randomBytes, toBeHex, Wallet } from 'ethers';
import {
  BlobAccount,
  blobProof,
  blobRoot,
  ConfigAccount,
  decodeBlob,
  decodeConfig,
  encodeConfig,
  fragmentProof,
  Hex32,
  MONADB_ABI,
  MonaDBClient,
  monadbInterface,
  rewardBetween,
  segmentProof,
  shardLeafHashes,
  shardRoot,
  toHex,
  TransactionSender,
} from '../src';

const RPC = process.env.MONADB_TEST_RPC ?? 'http://127.0.0.1:8545';
const ARTIFACT = path.join(__dirname, '..', '..', '..', 'artifacts', 'contracts', 'MonaDB.sol', 'MonaDB.json');

const provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1, pollingInterval: 200 });
const sender = new TransactionSender(provider);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const random = (n: number) => new Uint8Array(nodeRandom(n));
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

async function available(): Promise<boolean> {
  try {
    return Number((await provider.getNetwork()).chainId) === 31337 && fs.existsSync(ARTIFACT);
  } catch {
    return false;
  }
}

async function funded(mon = '1000'): Promise<Wallet> {
  const wallet = new Wallet(hexlify(randomBytes(32)), provider);
  await provider.send('hardhat_setBalance', [wallet.address, toBeHex(parseEther(mon))]);
  return wallet;
}

async function readBody(req: http.IncomingMessage): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  return new Uint8Array(Buffer.concat(parts));
}

let contract = '';
const call = (signer: Wallet, method: string, args: unknown[], label = method) =>
  sender.send({ signer, to: contract, data: monadbInterface.encodeFunctionData(method, args), label });

async function blobEntry(id: Hex32): Promise<BlobAccount> {
  const monadb = new Contract(contract, MONADB_ABI, provider);
  return decodeBlob(await monadb.getBlob(id), id)!;
}

/** A minimal replicator node: the blob HTTP API backed by memory */
class FakeNode {
  server!: http.Server;
  url = '';
  readonly shards = new Map<string, { data: Uint8Array; roots: Uint8Array[]; fragmentSize: number; index: number }>();
  private readonly incoming = new Map<string, { parts: Uint8Array[]; length: number; roots: Uint8Array[]; fragmentSize: number }>();

  constructor(readonly signer: Wallet) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (process.env.DEBUG_FAKE_NODES) console.log(`  fake node ${this.url}: ${String(err).slice(0, 300)} ${JSON.stringify((err as { cause?: unknown }).cause ?? err, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 1500)}`);
        res.writeHead(500).end(String(err));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections?.();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/status') return json(200, { registered: true, active: true, contract });
    if (parts[0] !== 'blob') return json(404, {});
    const blob = parts[1] as Hex32;
    if (req.method === 'PUT' && parts[2] === 'shard') {
      const index = Number(parts[3]);
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const body = await readBody(req);
      const entry = await blobEntry(blob).catch(() => null);
      if (!entry) return json(404, { error: 'no blob yet' });
      const key = `${blob}/${index}`;
      if (offset === 0) {
        const roots = String(req.headers['x-monadb-shard-roots']).split(',').map(fromHex);
        if (toHex(blobRoot(roots)) !== toHex(entry.root)) return json(400, { error: 'roots' });
        this.incoming.set(key, { parts: [], length: 0, roots, fragmentSize: Number(req.headers['x-monadb-fragment-size']) });
      }
      const state = this.incoming.get(key)!;
      state.parts.push(body);
      state.length += body.length;
      if (state.length < Number(entry.shardSize)) return json(202, { received: state.length });
      const data = new Uint8Array(state.length);
      let at = 0;
      for (const p of state.parts) {
        data.set(p, at);
        at += p.length;
      }
      this.incoming.delete(key);
      if (toHex(shardRoot(data)) !== toHex(state.roots[index])) return json(400, { error: 'shard root' });
      this.shards.set(key, { data, roots: state.roots, fragmentSize: state.fragmentSize, index });
      const confirmed = await call(this.signer, 'confirmShard', [blob, index]);
      // taking the slot opened a possession challenge: answer it like a node's maintenance loop
      await this.prove(blob);
      return json(201, { stored: true, confirmed: true, transaction: confirmed.hash });
    }
    const held = [...this.shards.entries()].find(([k]) => k.startsWith(`${blob}/`));
    if (!held) return json(404, {});
    if (req.method === 'GET' && parts[2] === 'roots') return json(200, held[1].roots.map(toHex));
    if (req.method === 'GET' && parts[2] === 'shard' && parts[4] === 'fragment') {
      const shard = this.shards.get(`${blob}/${Number(parts[3])}`);
      if (!shard) return json(404, {});
      const stripe = Number(parts[5]);
      const F = shard.fragmentSize;
      const proof = fragmentProof(shardLeafHashes(shard.data), F / 1024, stripe).map(toHex).join(',');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-monadb-proof': proof });
      res.end(Buffer.from(shard.data.subarray(stripe * F, (stripe + 1) * F)));
      return undefined;
    }
    return json(404, {});
  }

  /** Answer the open challenge on our slot of `blob` */
  async prove(blob: Hex32): Promise<string> {
    const monadb = new Contract(contract, MONADB_ABI, provider);
    const entry = await blobEntry(blob);
    const index = entry.slots.findIndex((s) => s.holder === this.signer.address);
    // the view can read the challenge block's hash once a later block exists
    let segment: number | undefined;
    for (let i = 0; i < 100 && segment === undefined; i++) {
      try {
        segment = Number(await monadb.challengeSegment(blob, index));
      } catch {
        await sleep(300);
      }
    }
    assert.ok(segment !== undefined, 'the challenge block was produced');
    const shard = this.shards.get(`${blob}/${index}`)!;
    const leaves = shardLeafHashes(shard.data);
    const result = await call(this.signer, 'proveShard', [
      blob,
      index,
      shard.data.subarray(segment! * 1024, (segment! + 1) * 1024),
      segmentProof(leaves, segment!).map((h) => hexlify(h)),
      blobProof(shard.roots, index).map((h) => hexlify(h)),
    ]);
    return result.hash;
  }
}

describe('Blobs on a local Hardhat node', { concurrency: false }, async () => {
  const skip = !(await available());
  let alice: Wallet;
  let config: ConfigAccount;
  const nodes: FakeNode[] = [];
  let client: MonaDBClient;
  const file = random(300_000);
  let recordId: Hex32;
  let blobs: Hex32[];

  before(async () => {
    if (skip) return;
    const admin = await funded();
    const { abi, bytecode } = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
    const deployed = await new ContractFactory(abi, bytecode, admin).deploy(
      encodeConfig({
        treasury: admin.address,
        baseFeePerReplica: parseEther('0.02'),
        pricePerMib: parseEther('0.1'),
        pricePerMibEpoch: parseEther('0.001'),
        protocolFeeBps: 1_000,
        replicationThresholdPct: 60,
        replicationWindow: 3_600n,
        epochSeconds: 60n,
        challengeWindowBlocks: 100n,
        challengeCooldown: 0n,
        challengerBountyBps: 1_000,
      }),
    );
    await deployed.waitForDeployment();
    contract = await deployed.getAddress();
    const monadb = new Contract(contract, MONADB_ABI, admin);
    config = decodeConfig(await monadb.getConfig(), admin.address);
    for (let i = 0; i < 3; i++) {
      const node = new FakeNode(await funded('10'));
      await node.start();
      await (await monadb.registerReplicator(node.signer.address, node.url)).wait();
      nodes.push(node);
    }
    alice = await funded();
    client = new MonaDBClient({ provider, signer: alice, contract, nodeUrls: nodes.map((n) => n.url), mode: 'blob', epochs: 3, compress: false });
    await client.register();
  });

  after(async () => {
    for (const node of nodes) await node.stop().catch(() => undefined);
  });

  test('a blob upload is one wallet transaction, one shard per node, any 2 of 3 rebuild the file', { skip }, async () => {
    const quote = await client.quoteFile(file.length, 1, 'blob');
    assert.deepEqual(quote.layout, { k: 2, m: 1 });
    const result = await client.uploadFile(file, { name: 'video.bin' });
    recordId = result.recordId;
    blobs = result.blobs!;
    assert.equal(result.mode, 'blob');
    assert.equal(result.transactions.length, 1, 'one wallet transaction');
    assert.equal(blobs.length, 1, 'one entry for the whole file');
    assert.deepEqual(result.layout && [result.layout.k, result.layout.m], [2, 1]);
    assert.equal(result.feePaid, quote.uploadFee);
    assert.equal(nodes.filter((n) => n.shards.size === 1).length, 3, 'each node holds one shard');

    const blob = await blobEntry(blobs[0]);
    assert.equal(blob.state, 'Cool');
    assert.equal(blob.held, 3);
    assert.equal(blob.needsHolders, false);
    assert.equal(blob.expiresAt - blob.openedAt, 3n * config.epochSeconds);
    // stored bytes = 1.5 × the payload (2+1), not 2–3 full copies
    const stored = nodes.reduce((sum, n) => sum + [...n.shards.values()][0].data.length, 0);
    assert.ok(stored < file.length * 1.6, `${stored} bytes stored for ${file.length}`);
    console.log(`  300 KB → ${stored} bytes on 3 nodes (2+1), fee ${result.feePaid} wei, gas ${result.networkFee} wei`);

    assert.deepEqual((await client.downloadFile(recordId)).data, file);
    const status = await client.fileStatus(recordId);
    assert.ok(status.cool);
    assert.equal(status.blobs![0].held, 3);
  });

  test('the file survives a lost node', { skip }, async () => {
    const lost = nodes[1];
    await lost.stop();
    const reader = new MonaDBClient({ provider, signer: alice, contract, nodeUrls: nodes.filter((n) => n !== lost).map((n) => n.url), nodeTimeoutMs: 3_000 });
    assert.deepEqual((await reader.downloadFile(recordId)).data, file, 'rebuilt from the other two shards');
    await lost.start();
    // publish its new port so later tests can reach it
    await call(lost.signer, 'updateReplicatorEndpoint', [lost.url]);
  });

  test('storage proofs: a challenge is answered with a 1 KiB segment, then rewards are claimed', { skip }, async () => {
    const node = nodes[0];
    const blob = blobs[0];
    await sleep(3_000); // let some reward accrue
    await call(alice, 'createChallenge', [blob, findSlot(await blobEntry(blob), node)]);
    const hash = await node.prove(blob);
    assert.ok(hash);
    const entry = await blobEntry(blob);
    const slot = entry.slots[findSlot(entry, node)];
    assert.equal(slot.challengeBlock, 0n, 'challenge answered');
    assert.ok(slot.provenAt > slot.claimedUntil);

    const expected = rewardBetween(entry, config.epochSeconds, slot.claimedUntil, slot.provenAt);
    const before = await provider.getBalance(node.signer.address);
    const claim = await call(node.signer, 'claimShardRewards', [blob, findSlot(entry, node)]);
    const after = await provider.getBalance(node.signer.address);
    const gas = claim.receipt.gasUsed * (claim.receipt.gasPrice ?? 0n);
    assert.equal(after - before, expected - gas);
    console.log(`  proof ${hash.slice(0, 18)}…, claimed ${expected} wei`);
  });

  test('many small files fit one bundle: one blob, one record', { skip }, async () => {
    const files = Array.from({ length: 40 }, (_, i) => ({
      name: `factura-${i}.json`,
      mime: 'application/json',
      data: new TextEncoder().encode(JSON.stringify({ id: i, total: i * 100, items: Array(i).fill('servicio') })),
    }));
    const compressing = new MonaDBClient({ provider, signer: alice, contract, nodeUrls: nodes.map((n) => n.url), mode: 'blob', epochs: 2 });
    const result = await compressing.uploadFiles(files, { name: 'facturas-octubre' });
    assert.equal(result.blobs!.length, 1);
    assert.equal(result.transactions.length, 1);
    assert.equal(result.entries.length, 40);
    const entries = await compressing.downloadBundle(result.recordId);
    assert.equal(entries.length, 40);
    assert.deepEqual(entries[7].data, files[7].data);
    const one = await compressing.downloadFile(result.recordId, { entry: 'factura-39.json' });
    assert.deepEqual(one.data, files[39].data);
    assert.ok((await compressing.listFiles()).some((f) => f.recordId === result.recordId));
  });

  test('extending a blob prepays more epochs in one transaction', { skip }, async () => {
    const before = await blobEntry(blobs[0]);
    await client.extendFile(recordId, 2);
    const after = await blobEntry(blobs[0]);
    assert.equal(after.epochs, before.epochs + 2);
    assert.equal(after.expiresAt, before.expiresAt + 2n * config.epochSeconds);
  });
});

function findSlot(blob: BlobAccount, node: FakeNode): number {
  return blob.slots.findIndex((s) => s.holder === node.signer.address);
}
