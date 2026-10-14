/**
 * End-to-end check of erasure-coded blobs (docs/blob-protocol.md) with real
 * nodes against a local Hardhat node with MonaDB deployed (npm run localnet +
 * npm run deploy:localnet, from the repo root):
 *
 *   npm run build:sdk && (cd monadb-node && npm run build)
 *   npx tsx monadb-node/test/e2e-blobs.ts          # from the repo root
 *
 * It starts three nodes, uploads a file as a 2+1 blob (one shard per node,
 * one wallet transaction), downloads it, stops one node and downloads it
 * from the other two, lets the nodes prove their shards and claim, takes the
 * stopped node's slot away with an unanswered challenge, starts a fourth
 * node that rebuilds the shard from the other two, and stores a bundle of
 * small files.  For the run the config uses 60-second epochs and short
 * challenge windows so the whole cycle fits in a few minutes; the original
 * config is restored at the end.
 *
 * Env: MONADB_TEST_RPC (default: the deployment's rpcUrl), MONADB_DEPLOYMENT
 *      (default deployments/monad-localnet.json), MONADB_TEST_ADMIN_KEY (default
 *      Hardhat account #0), E2E_BASE_PORT (3201), E2E_KEEP_DATA=1 to keep the
 *      temp directory.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Contract, getAddress, HDNodeWallet, hexlify, JsonRpcProvider, parseEther, toBeHex, Wallet } from 'ethers';
import {
  BlobAccount,
  decodeBlob,
  decodeConfig,
  decodeReplicator,
  encodeConfig,
  MONADB_ABI,
  MonaDBClient,
  MonaDBDeployment,
  monadbInterface,
  TransactionSender,
  VACANT,
} from '@monadb/sdk';

const NODE_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(NODE_DIR, '..');
const DEPLOYMENT_FILE = path.resolve(process.env.MONADB_DEPLOYMENT ?? path.join(ROOT, 'deployments', 'monad-localnet.json'));
const DEPLOYMENT = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8')) as MonaDBDeployment;
const RPC = process.env.MONADB_TEST_RPC ?? DEPLOYMENT.rpcUrl;
const BASE_PORT = Number(process.env.E2E_BASE_PORT ?? 3201);
const CHALLENGE_WINDOW_BLOCKS = 30n;

const provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1, pollingInterval: 250 });
const sender = new TransactionSender(provider);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { name: string; ok: boolean; detail: string }[] = [];
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const log = (message: string) => console.log(`[e2e ${elapsed()}] ${message}`);
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`[e2e ${elapsed()}] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A fresh wallet with `mon` MON (Hardhat's setBalance) */
async function funded(mon: string): Promise<Wallet> {
  const wallet = new Wallet(hexlify(randomBytes(32)), provider);
  await provider.send('hardhat_setBalance', [wallet.address, toBeHex(parseEther(mon))]);
  return wallet;
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

interface Node {
  name: string;
  url: string;
  wallet: Wallet;
  keyFile: string;
  dataDir: string;
  child: ChildProcess | null;
}

function startNode(node: Node, owner: string, chainId: number, logFile: string): void {
  const main = path.join(NODE_DIR, 'dist', 'main.js');
  if (!fs.existsSync(main)) throw new Error(`${main} not found: run "npm run build" in monadb-node first`);
  const port = new URL(node.url).port;
  const child = spawn(process.execPath, [main], {
    cwd: NODE_DIR,
    env: {
      ...process.env,
      PORT: port,
      MONADB_DEPLOYMENT: DEPLOYMENT_FILE,
      MONAD_RPC_URL: RPC,
      MONAD_CHAIN_ID: String(chainId),
      REPLICATOR_KEY_FILE: node.keyFile,
      NODE_ENDPOINT: node.url,
      CHUNK_STORE: 'fs',
      METADATA_STORE: 'file',
      BLOB_STORE: 'fs',
      DATA_DIR: node.dataDir,
      POLL_INTERVAL_MS: '2000',
      BLOB_POLL_INTERVAL_MS: '2000',
      BLOB_CLAIM_MIN_WEI: '1',
      BLOB_CHALLENGE_OTHERS: 'false',
      REPLICATE_OWNERS: owner,
      LOG_LEVEL: 'log',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  const echo = (chunk: Buffer) => {
    out.write(chunk);
    for (const line of chunk.toString().split(/\r?\n/)) {
      // eslint-disable-next-line no-control-regex
      const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
      if (/Blob|blob|shard|Error|error|WARN/.test(clean)) console.log(`  [${node.name}] ${clean.slice(0, 220)}`);
    }
  };
  child.stdout!.on('data', echo);
  child.stderr!.on('data', echo);
  node.child = child;
}

async function stopNode(node: Node): Promise<void> {
  const child = node.child;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(10_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  node.child = null;
}

async function waitForNode(node: Node, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (node.child?.exitCode !== null && node.child?.exitCode !== undefined) throw new Error(`${node.name} exited`);
    try {
      if ((await getJson(`${node.url}/status`)).status === 200) return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error(`${node.name} did not start`);
}

async function waitFor<T>(what: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await what();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(1_000);
    last = await what();
  }
  return last;
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'monadb-blobs-e2e-'));
  const nodes: Node[] = [];
  const contractAddress = getAddress(DEPLOYMENT.contract);
  const monadb = new Contract(contractAddress, MONADB_ABI, provider);
  const admin = process.env.MONADB_TEST_ADMIN_KEY
    ? new Wallet(process.env.MONADB_TEST_ADMIN_KEY, provider)
    : HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, "m/44'/60'/0'/0/0").connect(provider);
  const call = (signer: Wallet | HDNodeWallet, method: string, args: unknown[], value?: bigint) =>
    sender.send({ signer, to: contractAddress, data: monadbInterface.encodeFunctionData(method, args), value, label: method });
  const blobOf = async (blob: string): Promise<BlobAccount> => decodeBlob(await monadb.getBlob(blob), blob)!;
  let original: ReturnType<typeof decodeConfig> | null = null;

  try {
    const chainId = Number((await provider.getNetwork()).chainId);
    if ((await provider.getCode(contractAddress)) === '0x') throw new Error(`No MonaDB contract at ${contractAddress} on ${RPC}`);
    if ((await monadb.admin()).toLowerCase() !== admin.address.toLowerCase()) throw new Error(`${admin.address} is not the MonaDB admin`);

    // Test-friendly blob parameters: 60 s epochs, short challenge windows, no cooldown
    original = decodeConfig(await monadb.getConfig(), await monadb.admin());
    const { admin: _admin, ...params } = original;
    await call(admin, 'updateConfig', [
      encodeConfig({ ...params, epochSeconds: 60n, challengeWindowBlocks: CHALLENGE_WINDOW_BLOCKS, challengeCooldown: 0n, challengerBountyBps: 1_000 }),
    ]);
    log(`config: 60 s epochs, ${CHALLENGE_WINDOW_BLOCKS}-block challenge windows, no cooldown (restored at the end)`);

    const uploader = await funded('10000');
    for (let i = 0; i < 4; i++) {
      const wallet = await funded('100');
      const keyFile = path.join(tmp, `node${i + 1}.key`);
      fs.writeFileSync(keyFile, `${wallet.privateKey}\n`);
      const url = `http://127.0.0.1:${BASE_PORT + i}`;
      await call(admin, 'registerReplicator', [wallet.address, url]);
      nodes.push({ name: `node${i + 1}`, url, wallet, keyFile, dataDir: path.join(tmp, `data${i + 1}`), child: null });
    }
    const logFile = (n: Node) => path.join(tmp, `${n.name}.log`);
    for (const n of nodes.slice(0, 3)) startNode(n, uploader.address, chainId, logFile(n));
    for (const n of nodes.slice(0, 3)) await waitForNode(n);
    log(`3 nodes up: ${nodes.slice(0, 3).map((n) => n.url).join(', ')}`);

    // 1. Upload: 2+1 blob, one shard per node, one wallet transaction
    const clientFor = (urls: string[], extra: Partial<ConstructorParameters<typeof MonaDBClient>[0]> = {}) =>
      new MonaDBClient({ provider, signer: uploader, contract: contractAddress, nodeUrls: urls, nodeTimeoutMs: 5_000, ...extra });
    const client = clientFor(nodes.slice(0, 3).map((n) => n.url), { mode: 'blob', epochs: 5 });
    await client.register();
    const file = new Uint8Array(randomBytes(600_000));
    const t0 = Date.now();
    const upload = await client.uploadFile(file, { name: 'dataset.bin' });
    const blob = upload.blobs![0];
    const account = await blobOf(blob);
    check(
      'a 600 KB file is one 2+1 blob: one wallet transaction, one shard per node, Cool right away',
      upload.transactions.length === 1 && upload.blobs!.length === 1 && account.dataShards === 2 && account.totalShards === 3 && account.held === 3 && account.state === 'Cool',
      `${((Date.now() - t0) / 1000).toFixed(1)}s, layout ${upload.layout!.k}+${upload.layout!.m}, held ${account.held}/3, fee ${upload.feePaid} wei`,
    );
    const holders = account.slots.map((s) => nodes.find((n) => n.wallet.address === s.holder)?.name ?? s.holder);
    check('each node holds a different shard', new Set(holders).size === 3 && holders.every((h) => h.startsWith('node')), holders.join(', '));

    const roots = await getJson(`${nodes[0].url}/blob/${blob}/roots`);
    check('GET /blob/:blob/roots serves the 3 shard roots', roots.status === 200 && roots.body.length === 3);

    // 2. Download, then with one node down
    const ok = async (c: MonaDBClient) => Buffer.compare(Buffer.from((await c.downloadFile(upload.recordId)).data), Buffer.from(file)) === 0;
    check('the file downloads from the nodes, every fragment verified', await ok(client));
    const lost = nodes[1];
    await stopNode(lost);
    const reader = clientFor(nodes.filter((n) => n !== lost && n.child).map((n) => n.url), { nodeTimeoutMs: 3_000 });
    check(`with ${lost.name} down the file is rebuilt from the other two shards`, await ok(reader));

    // 3. Storage proofs: live nodes answer challenges (their confirmation opened one, then they challenge themselves) and claim
    const live = nodes.filter((n) => n.child);
    const earned = await waitFor(
      async () => Promise.all(live.map(async (n) => decodeReplicator(await monadb.getReplicator(n.wallet.address), n.wallet.address)!.earned)),
      (v) => v.every((x) => x > 0n),
      120_000,
    );
    const status = await waitFor(async () => (await getJson(`${live[0].url}/blob/status`)).body, (st) => st.totals.claims >= 1, 30_000);
    check(
      'live nodes prove their shards (challenge + 1 KiB answer) and claim rewards',
      earned.every((x) => x > 0n) && status.totals.proofs >= 1 && status.totals.claims >= 1,
      `earned ${earned.join(' / ')} wei; ${live[0].name}: ${status.totals.proofs} proofs, ${status.totals.claims} claims`,
    );

    // 4. The stopped node never answers: its slot is reported and reopens
    const lostIndex = (await blobOf(blob)).slots.findIndex((s) => s.holder === lost.wallet.address);
    // it may not even have answered the possession challenge its confirmation opened
    if ((await blobOf(blob)).slots[lostIndex].challengeBlock === 0n) await call(uploader, 'createChallenge', [blob, lostIndex]);
    const deadline = (await blobOf(blob)).slots[lostIndex].challengeDeadline;
    while (BigInt(await provider.getBlockNumber()) <= deadline) await sleep(1_000);
    const before = await provider.getBalance(uploader.address);
    const failed = await call(uploader, 'failChallenge', [blob, lostIndex]);
    const gas = failed.receipt.gasUsed * failed.receipt.gasPrice;
    const reopened = await blobOf(blob);
    check(
      `${lost.name} let its challenge expire: the slot reopens and the reporter gets a bounty`,
      reopened.slots[lostIndex].holder === VACANT && reopened.held === 2 && reopened.needsHolders,
      `held ${reopened.held}/3, bounty ${(await provider.getBalance(uploader.address)) - before + gas} wei`,
    );

    // 5. A fourth node rebuilds the missing shard from the other two
    const fresh = nodes[3];
    startNode(fresh, uploader.address, chainId, logFile(fresh));
    await waitForNode(fresh);
    const repaired = await waitFor(() => blobOf(blob), (b) => b.slots[lostIndex].holder === fresh.wallet.address, 90_000);
    const freshStatus = (await getJson(`${fresh.url}/blob/status`)).body;
    check(
      `${fresh.name} rebuilds shard ${lostIndex} from 2 fragments per stripe and takes the slot`,
      repaired.slots[lostIndex].holder === fresh.wallet.address && repaired.held === 3 && freshStatus.totals.rebuilt === 1,
      `held ${repaired.held}/3, rebuilt ${freshStatus.totals.rebuilt}`,
    );
    check(`the file downloads again with ${fresh.name} in the set`, await ok(clientFor([fresh.url])));

    // 6. Many small files in one bundle
    const files = Array.from({ length: 30 }, (_, i) => ({ name: `nota-${i}.txt`, mime: 'text/plain', data: new TextEncoder().encode(`Nota ${i}: `.repeat(50 + i)) }));
    const bundleClient = clientFor(nodes.filter((n) => n.child).map((n) => n.url), { mode: 'blob', epochs: 2 });
    const bundle = await bundleClient.uploadFiles(files, { name: 'notas' });
    const entries = await bundleClient.downloadBundle(bundle.recordId);
    check(
      '30 small files go in one bundle: one blob, one record, gzip',
      bundle.blobs!.length === 1 && entries.length === 30 && Buffer.compare(Buffer.from(entries[12].data), Buffer.from(files[12].data)) === 0,
      `${bundle.size} bytes → ${bundle.storedSize} stored`,
    );

    // 7. Push validation
    const taken = (await blobOf(blob)).slots.findIndex((s) => s.holder !== nodes[0].wallet.address);
    const wrongRoots = await getJson(`${nodes[0].url}/blob/${blob}/shard/${taken}?offset=0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-monadb-shard-roots': ['00'.repeat(32), '11'.repeat(32), '22'.repeat(32)].join(','), 'x-monadb-fragment-size': '1024' },
      body: new Uint8Array(1024) as BodyInit,
    });
    const unknown = await getJson(`${nodes[0].url}/blob/${hexlify(randomBytes(32))}/shard/0?offset=0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(1024) as BodyInit,
    });
    const badId = await getJson(`${nodes[0].url}/blob/${uploader.address}/shard/0?offset=0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(1024) as BodyInit,
    });
    check('pushes are checked: a taken slot → 409, unknown blob → 404, bad id → 400',
      wrongRoots.status === 409 && unknown.status === 404 && badId.status === 400,
      `taken=${wrongRoots.status} unknown=${unknown.status} id=${badId.status}`);
  } catch (err) {
    check('run completed', false, (err as Error).stack ?? String(err));
  } finally {
    for (const n of nodes) await stopNode(n);
    if (original) {
      const { admin: _admin, ...params } = original;
      await call(admin, 'updateConfig', [encodeConfig(params)]).then(
        () => log('config restored'),
        (err) => log(`could not restore the config: ${(err as Error).message}`),
      );
    }
    if (process.env.E2E_KEEP_DATA === '1') log(`kept ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} checks passed in ${elapsed()}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
