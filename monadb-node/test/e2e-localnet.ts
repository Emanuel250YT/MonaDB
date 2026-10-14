/**
 * End-to-end check of the replicator node against a local Hardhat node with
 * MonaDB deployed (npm run localnet + npm run deploy:localnet, from the repo
 * root):
 *
 *   npm run build:sdk && (cd monadb-node && npm run build)
 *   npx tsx monadb-node/test/e2e-localnet.ts          # from the repo root
 *
 * It registers a fresh replicator, starts the built node (dist/main.js) with
 * the fs + file stores, uploads a ~300 KB file to the logs (ledger mode) with
 * 1 replica, waits for the node to confirm every chunk (rewards paid, chunks
 * closed by the last confirmation), downloads the file through the node
 * only, checks the HTTP API, then restarts the node on the same data
 * directory and checks it still serves the chunks.  Then a direct upload
 * (compressed, chunks pushed to the node over HTTP, nothing on-chain): the
 * node confirms every chunk in batched transactions and the file downloads
 * through the node.  Last, the PUT /chunk/:id/data contract on chunks opened
 * by hand.
 *
 * The node only replicates the test uploader's chunks (REPLICATE_OWNERS), so
 * it never interferes with other tests sharing the chain.
 *
 * Env: MONADB_TEST_RPC (default: the deployment's rpcUrl), MONADB_DEPLOYMENT
 *      (default deployments/monad-localnet.json), MONADB_TEST_ADMIN_KEY (default
 *      Hardhat account #0, the localnet deployer), E2E_NODE_PORT (3100),
 *      E2E_KEEP_DATA=1 to keep the temp directory.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Contract, getAddress, HDNodeWallet, hexlify, JsonRpcProvider, parseEther, toBeHex, Wallet } from 'ethers';
import {
  decodeChunk,
  decodeReplicator,
  MAX_DIRECT_CHUNK_SIZE,
  MONADB_ABI,
  MonaDBClient,
  MonaDBDeployment,
  monadbInterface,
  TransactionSender,
} from '@monadb/sdk';

const NODE_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(NODE_DIR, '..');
const DEPLOYMENT_FILE = path.resolve(process.env.MONADB_DEPLOYMENT ?? path.join(ROOT, 'deployments', 'monad-localnet.json'));
const DEPLOYMENT = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8')) as MonaDBDeployment;
const RPC = process.env.MONADB_TEST_RPC ?? DEPLOYMENT.rpcUrl;
const PORT = Number(process.env.E2E_NODE_PORT ?? 3100);
const NODE_URL = `http://127.0.0.1:${PORT}`;
const FILE_SIZE = 300_000;
// Ledger upload: 128 KiB chunks in 48 KiB segments (3 chunks)
const LEDGER_CHUNK_SIZE = 128 * 1024;
// Direct upload: ~890 KB of CSV, ~325 KB gzipped, in 128 KiB chunks (3 pushes)
const CSV_ROWS = 25_000;
const DIRECT_CHUNK_SIZE = 128 * 1024;

const provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1, pollingInterval: 250 });
const sender = new TransactionSender(provider);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const REPLICATION_CONFIRMED = monadbInterface.getEvent('ReplicationConfirmed')!.topicHash;

// ── Reporting ────────────────────────────────────────────────────────────────

const results: { name: string; ok: boolean; detail: string }[] = [];
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

function log(message: string): void {
  console.log(`[e2e ${elapsed()}] ${message}`);
}

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`[e2e ${elapsed()}] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A fresh wallet with `mon` MON (Hardhat's setBalance) */
async function funded(mon: string): Promise<Wallet> {
  const wallet = new Wallet(hexlify(randomBytes(32)), provider);
  await provider.send('hardhat_setBalance', [wallet.address, toBeHex(parseEther(mon))]);
  return wallet;
}

/** Expense-sheet CSV with random amounts: compresses ~2.7×, not more */
function csvFile(rows: number): Uint8Array {
  const concepts = ['hosting', 'cafe', 'libros', 'taxi', 'luz', 'agua', 'renta', 'sueldo'];
  const lines = ['fecha,monto,concepto,cuenta'];
  for (let i = 0; i < rows; i++) {
    const date = `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + randomInt(28)).padStart(2, '0')}`;
    lines.push(`${date},${(randomInt(10_000_000) / 100).toFixed(2)},${concepts[randomInt(8)]},${randomInt(1e9)}`);
  }
  return new TextEncoder().encode(lines.join('\n') + '\n');
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body };
}

/** PUT /chunk/:id/data, as the SDK pushes a direct chunk */
function putChunk(chunk: string, data: Uint8Array): Promise<{ status: number; body: any }> {
  return getJson(`${NODE_URL}/chunk/${chunk}/data`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: data as BodyInit,
  });
}

/** Start dist/main.js; its log lines are echoed with a [node] prefix */
function startNode(env: Record<string, string>, logFile: string): ChildProcess {
  const main = path.join(NODE_DIR, 'dist', 'main.js');
  if (!fs.existsSync(main)) throw new Error(`${main} not found: run "npm run build" in monadb-node first`);
  const child = spawn(process.execPath, [main], {
    cwd: NODE_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  const echo = (chunk: Buffer) => {
    out.write(chunk);
    for (const line of chunk.toString().split(/\r?\n/)) {
      // eslint-disable-next-line no-control-regex
      if (line.trim()) console.log(`  [node] ${line.replace(/\x1b\[[0-9;]*m/g, '')}`);
    }
  };
  child.stdout!.on('data', echo);
  child.stderr!.on('data', echo);
  return child;
}

async function stopNode(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(10_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function waitForNode(child: ChildProcess, timeoutMs = 60_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`node exited with code ${child.exitCode}`);
    try {
      const { status, body } = await getJson(`${NODE_URL}/status`);
      if (status === 200) return body;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error(`node did not answer ${NODE_URL}/status within ${timeoutMs} ms`);
}

/** Poll /status until `predicate` holds */
async function waitForStatus(predicate: (status: any) => boolean, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    last = (await getJson(`${NODE_URL}/status`)).body;
    if (predicate(last)) return last;
    await sleep(1_000);
  }
  return last;
}

/** The node's metadata for each chunk (GET /chunk/:id/meta) */
async function nodeMetas(chunks: string[]): Promise<any[]> {
  return Promise.all(chunks.map(async (c) => (await getJson(`${NODE_URL}/chunk/${c}/meta`)).body));
}

/** Gas a set of transactions cost their sender (Hardhat charges the gas used) */
async function gasPaid(hashes: Iterable<string>): Promise<bigint> {
  let total = 0n;
  for (const hash of new Set(hashes)) {
    const receipt = await provider.getTransactionReceipt(hash);
    total += receipt!.gasUsed * receipt!.gasPrice;
  }
  return total;
}

/** Transactions in which `replicator` confirmed chunks, since `fromBlock` */
async function confirmationTxs(contract: string, replicator: string, fromBlock: number): Promise<string[]> {
  const logs = await provider.getLogs({
    address: contract,
    topics: [REPLICATION_CONFIRMED, null, '0x' + replicator.slice(2).toLowerCase().padStart(64, '0')],
    fromBlock,
    toBlock: 'latest',
  });
  return [...new Set(logs.map((l) => l.transactionHash))];
}

/** Balance once it stops moving */
async function settledBalance(address: string, expected: bigint, from: bigint): Promise<bigint> {
  let value = await provider.getBalance(address);
  for (let i = 0; i < 10 && value - from !== expected; i++) {
    await sleep(500);
    value = await provider.getBalance(address);
  }
  return value;
}

// ── Test ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'monadb-node-e2e-'));
  const dataDir = path.join(tmp, 'data');
  const logFile = path.join(tmp, 'node.log');
  let node: ChildProcess | null = null;

  try {
    // 1. Chain, contract, admin
    const chainId = Number((await provider.getNetwork()).chainId);
    const contractAddress = getAddress(DEPLOYMENT.contract);
    if ((await provider.getCode(contractAddress)) === '0x') throw new Error(`No MonaDB contract at ${contractAddress} on ${RPC}`);
    log(`chain ${chainId} at ${RPC}, MonaDB ${contractAddress} (${path.relative(ROOT, DEPLOYMENT_FILE)})`);
    const admin = process.env.MONADB_TEST_ADMIN_KEY
      ? new Wallet(process.env.MONADB_TEST_ADMIN_KEY, provider)
      : HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, "m/44'/60'/0'/0/0").connect(provider);
    const monadb = new Contract(contractAddress, MONADB_ABI, provider);
    if ((await monadb.admin()).toLowerCase() !== admin.address.toLowerCase()) throw new Error(`${admin.address} is not the MonaDB admin`);

    // 2. Fresh replicator: key file, MON for gas, registered by the admin
    const nodeWallet = await funded('100');
    const nodeKeyFile = path.join(tmp, 'replicator.key');
    fs.writeFileSync(nodeKeyFile, `${nodeWallet.privateKey}\n`);
    await sender.send({
      signer: admin,
      to: contractAddress,
      data: monadbInterface.encodeFunctionData('registerReplicator', [nodeWallet.address, NODE_URL]),
      label: 'registerReplicator',
    });
    log(`replicator ${nodeWallet.address} registered with endpoint ${NODE_URL}`);

    // 3. Uploader with a published encryption key; ledger uploads of uncompressed bytes first
    const uploader = await funded('10000');
    const client = new MonaDBClient({
      provider,
      signer: uploader,
      contract: contractAddress,
      mode: 'ledger',
      chunkSize: LEDGER_CHUNK_SIZE,
      compress: false,
      ledgerFallback: false,
      nodeUrls: [NODE_URL],
    });
    await client.register();
    log(`uploader ${uploader.address} registered`);

    // 4. Start the node (fs + file stores)
    const nodeEnv = {
      PORT: String(PORT),
      MONADB_DEPLOYMENT: DEPLOYMENT_FILE,
      MONAD_RPC_URL: RPC,
      MONAD_CHAIN_ID: String(chainId),
      REPLICATOR_KEY_FILE: nodeKeyFile,
      NODE_ENDPOINT: NODE_URL,
      CHUNK_STORE: 'fs',
      METADATA_STORE: 'file',
      BLOBS_ENABLED: 'false',
      DATA_DIR: dataDir,
      POLL_INTERVAL_MS: '1000',
      REPLICATE_OWNERS: uploader.address,
      LOG_LEVEL: 'log',
    };
    node = startNode(nodeEnv, logFile);
    await waitForNode(node);
    const status0 = await waitForStatus((s) => s.registered === true, 30_000);
    check('node boots and serves /status', status0.registered === true && status0.active === true &&
      String(status0.contract).toLowerCase() === contractAddress.toLowerCase() && status0.chainId === chainId,
      `registered=${status0.registered} active=${status0.active} endpoint=${status0.endpoint} contract=${status0.contract}`);
    const swagger = await fetch(`${NODE_URL}/docs`);
    check('Swagger UI at /docs', swagger.status === 200);

    const fromBlock = await provider.getBlockNumber();
    const balanceBefore = await provider.getBalance(nodeWallet.address);

    // 5. Upload ~300 KB with 1 replica
    const file = Uint8Array.from({ length: FILE_SIZE }, (_, i) => (i * 131 + (i >> 9) * 7) % 256);
    const upload = await client.uploadFile(file, { name: 'e2e-node.bin', mime: 'application/octet-stream', replicas: 1 });
    log(`uploaded ${FILE_SIZE} bytes: record ${upload.recordId}, ${upload.chunks.length} chunks, ` +
      `${upload.segmentTransactions} segment txs, fee ${upload.feePaid} wei`);

    // 6. The node rebuilds + confirms every chunk; with 1 replica its confirmation closes the chunk
    const coolStart = Date.now();
    await client.waitUntilCool(upload.chunks, { timeoutMs: 120_000, pollMs: 1_000 });
    check('every chunk is replicated through the node', true, `${((Date.now() - coolStart) / 1000).toFixed(1)}s after upload`);
    // The chain can show the chunk closed before the node's own sender saw its confirmation
    await waitForStatus((s) => s.scan.totals.confirmed >= upload.chunks.length, 30_000);

    const chunksNow = (await monadb.getChunks(upload.chunks)).map((r: unknown, i: number) => decodeChunk(r, upload.chunks[i]));
    const metas = await nodeMetas(upload.chunks);
    const byNode = chunksNow.every((c: unknown) => c === null) && metas.every((m) => m.source === 'local' && m.state === 'Closed' &&
      m.confirmedReplicas === 1 && m.replicators.length === 1 && m.replicators[0] === nodeWallet.address && m.block !== null);
    check('the confirmation closes every chunk; the node records itself as the replicator', byNode,
      metas.map((m, i) => `${chunksNow[i] ? 'open' : 'closed'} ${m.state} ${m.confirmedReplicas}/${m.requiredReplicas} block ${m.block}`).join(', '));

    const rewards = metas.reduce((sum, m) => sum + BigInt(m.rewardPerReplica ?? 0), 0n);
    const confirmTxs = await confirmationTxs(contractAddress, nodeWallet.address, fromBlock);
    const expected = rewards - (await gasPaid(confirmTxs));
    const balanceAfter = await settledBalance(nodeWallet.address, expected, balanceBefore);
    check('node balance grew by the rewards minus the gas of its confirmations', balanceAfter - balanceBefore === expected,
      `${balanceAfter - balanceBefore} wei (rewards ${rewards} - gas of ${confirmTxs.length} confirm tx, ${upload.chunks.length} chunks)`);

    const registration = decodeReplicator(await monadb.getReplicator(nodeWallet.address), nodeWallet.address);
    check('the registration counts the confirmations and the earnings',
      registration?.confirmations === BigInt(upload.chunks.length) && registration?.earned === rewards,
      `confirmations=${registration?.confirmations} earned=${registration?.earned}`);

    // 7. Download through the node only (ledgerFallback: false)
    const download = await client.downloadFile(upload.recordId);
    check('file downloads through the node only', Buffer.from(download.data).equals(Buffer.from(file)),
      `${download.data.length} bytes, sha256 ${sha256(download.data).slice(0, 16)}…`);

    // 8. HTTP API
    let rawOk = true;
    for (const meta of metas) {
      const response = await fetch(`${NODE_URL}/chunk/${meta.chunkId}/data`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      rawOk &&= response.status === 200 &&
        response.headers.get('content-type') === 'application/octet-stream' &&
        response.headers.get('x-chunk-id') === meta.chunkId &&
        sha256(bytes) === meta.contentHash;
    }
    const upper = await fetch(`${NODE_URL}/chunk/0x${upload.chunks[0].slice(2).toUpperCase()}/data`);
    check('GET /chunk/:id/data serves sha256-valid bytes with headers (ids in any case)', rawOk && upper.status === 200);

    const meta = metas[0];
    check('GET /chunk/:id/meta returns local metadata', meta.source === 'local' &&
      meta.state === 'Closed' && meta.confirmedReplicas === 1 && typeof meta.confirmSignature === 'string',
      `state=${meta.state} confirmed=${meta.confirmedReplicas} block=${meta.block} tx=${String(meta.confirmSignature).slice(0, 12)}…`);

    const query = await getJson(`${NODE_URL}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filter: { owner: uploader.address.toLowerCase(), state: 'Closed' }, orderBy: 'size', order: 'desc' }),
    });
    check('POST /query filters by owner (any case) + state', query.status === 200 && query.body.count === upload.chunks.length &&
      query.body.data[0].size >= query.body.data[query.body.count - 1].size, `count=${query.body.count}`);

    const badQuery = await getJson(`${NODE_URL}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filter: { state: 'Warm' } }),
    });
    const badId = await fetch(`${NODE_URL}/chunk/not-a-chunk-id/data`);
    const unknown = await fetch(`${NODE_URL}/chunk/${hexlify(randomBytes(32))}/data`);
    check('invalid input → 400, unknown chunk → 404',
      badQuery.status === 400 && badId.status === 400 && unknown.status === 404,
      `query=${badQuery.status} id=${badId.status} unknown=${unknown.status}`);

    // 9. Another confirmation is rejected by the contract: the chunk is gone
    //    (what the node treats as "nothing to do")
    try {
      await sender.estimate({
        signer: nodeWallet,
        to: contractAddress,
        data: monadbInterface.encodeFunctionData('confirmReplication', [upload.chunks[0]]),
        label: 'confirmReplication',
      });
      check('a confirmation after the last one is rejected', false, 'it would succeed');
    } catch (err) {
      const name = (err as { errorName?: string }).errorName;
      check('a confirmation after the last one is rejected', name === 'ChunkNotFound', `${name}`);
    }

    const status1 = (await getJson(`${NODE_URL}/status`)).body;
    check('/status reports the scan stats', status1.scan.totals.confirmed >= upload.chunks.length &&
      status1.scan.totals.stored >= upload.chunks.length && status1.storage.chunks >= upload.chunks.length,
      `scans=${status1.scan.scans} stored=${status1.scan.totals.stored} confirmed=${status1.scan.totals.confirmed} ` +
      `txs=${status1.scan.totals.transactions} errors=${status1.scan.totals.errors} earned=${status1.weiEarned} ` +
      `balance=${status1.balanceWei}`);

    // 10. Restart on the same data directory: chunks still served, nothing re-downloaded
    await stopNode(node);
    log('node stopped; restarting on the same data directory');
    node = startNode(nodeEnv, logFile);
    await waitForNode(node);
    const status2 = await waitForStatus((s) => s.scan.scans >= 2, 15_000);
    const again = await fetch(`${NODE_URL}/chunk/${upload.chunks[1]}/data`);
    const againBytes = new Uint8Array(await again.arrayBuffer());
    check('after a restart the node still serves its chunks', again.status === 200 &&
      sha256(againBytes) === metas[1].contentHash && status2.storage.chunks >= upload.chunks.length &&
      status2.scan.totals.stored === 0 && status2.scan.totals.confirmed === 0,
      `stored chunks=${status2.storage.chunks}, re-downloaded=${status2.scan.totals.stored}, re-confirmed=${status2.scan.totals.confirmed}`);

    const download2 = await new MonaDBClient({ provider, signer: uploader, contract: contractAddress, ledgerFallback: false, nodeUrls: [NODE_URL] })
      .downloadFile(upload.recordId);
    check('file downloads through the restarted node', Buffer.from(download2.data).equals(Buffer.from(file)));

    // 11. Direct upload: compressed, chunks pushed to the node over HTTP, nothing on-chain
    const directClient = new MonaDBClient({
      provider,
      signer: uploader,
      contract: contractAddress,
      mode: 'direct',
      compress: true,
      directChunkSize: DIRECT_CHUNK_SIZE,
      ledgerFallback: false,
      nodeUrls: [NODE_URL],
    });
    const csv = csvFile(CSV_ROWS);
    const statusBefore = (await getJson(`${NODE_URL}/status`)).body;
    const directFrom = await provider.getBlockNumber();
    const nodeBefore = await provider.getBalance(nodeWallet.address);
    const uploaderBefore = await provider.getBalance(uploader.address);
    const direct = await directClient.uploadFile(csv, { name: 'e2e-gastos.csv', mime: 'text/csv', replicas: 1 });
    log(`direct upload: ${csv.length} bytes → ${direct.storedSize} gzipped, ${direct.chunks.length} chunks ` +
      `pushed to ${direct.nodes.join(', ')}, ${direct.transactions.length} wallet tx, fee ${direct.feePaid} wei`);
    check('direct upload is compressed and pushed to the node, with no segment writes',
      direct.mode === 'direct' && direct.segmentTransactions === 0 && direct.storedSize < csv.length &&
      direct.chunks.length > 1 && direct.nodes.length === 1 && direct.nodes[0] === NODE_URL && direct.transactions.length === 1,
      `mode=${direct.mode} segments=${direct.segmentTransactions} chunks=${direct.chunks.length} nodes=${direct.nodes.join(',')}`);

    const directStart = Date.now();
    await directClient.waitUntilCool(direct.chunks, { timeoutMs: 60_000, pollMs: 1_000 });
    const directNow = (await monadb.getChunks(direct.chunks)).map((r: unknown, i: number) => decodeChunk(r, direct.chunks[i]));
    check('every direct chunk is confirmed and closed', directNow.every((c: unknown) => c === null),
      `${((Date.now() - directStart) / 1000).toFixed(1)}s after the upload returned`);

    // The uploader paid the upload fee and the gas of its one transaction, nothing else
    const uploaderSpent = uploaderBefore - (await provider.getBalance(uploader.address));
    const walletGas = await gasPaid(direct.transactions);
    check('the uploader paid the fee + the gas of one transaction',
      uploaderSpent === direct.feePaid + walletGas,
      `spent ${uploaderSpent} = fee ${direct.feePaid} + gas ${walletGas} (SDK reports ${direct.networkFee} at the gas limit)`);

    const statusAfter = await waitForStatus(
      (s) => s.scan.totals.confirmed >= statusBefore.scan.totals.confirmed + direct.chunks.length, 30_000);
    const directMetas = await nodeMetas(direct.chunks);
    const directRewards = directMetas.reduce((sum, m) => sum + BigInt(m.rewardPerReplica ?? 0), 0n);
    const directTxs = await confirmationTxs(contractAddress, nodeWallet.address, directFrom);
    const directExpected = directRewards - (await gasPaid(directTxs));
    const nodeEarned = (await settledBalance(nodeWallet.address, directExpected, nodeBefore)) - nodeBefore;
    check('node stored the pushes and earned their rewards, minus the gas of its confirmation transactions',
      nodeEarned === directExpected && statusAfter.scan.pushes.accepted >= direct.chunks.length &&
      directMetas.every((m) => m.source === 'local' && m.state === 'Closed' && m.block === null),
      `${nodeEarned} wei = rewards ${directRewards} - gas of ${directTxs.length} tx(s) for ` +
      `${direct.chunks.length} chunks; pushes ${JSON.stringify(statusAfter.scan.pushes)}`);

    const directDownload = await new MonaDBClient({ provider, signer: uploader, contract: contractAddress, ledgerFallback: false, nodeUrls: [NODE_URL] })
      .downloadFile(direct.recordId);
    check('direct file downloads through the node only', Buffer.from(directDownload.data).equals(Buffer.from(csv)),
      `${directDownload.data.length} bytes, sha256 ${sha256(directDownload.data).slice(0, 16)}…`);

    // 12. PUT /chunk/:id/data contract, on chunks opened by hand
    const openChunk = async (data: Uint8Array, segmentSize: number): Promise<string> => {
      const contentHash = '0x' + createHash('sha256').update(data).digest('hex');
      const fee: bigint = await monadb.quoteChunk(data.length, 1);
      await sender.send({
        signer: uploader,
        to: contractAddress,
        data: monadbInterface.encodeFunctionData('openChunk', [
          { contentHash, size: data.length, segmentSize, replicas: 1, maxFee: fee },
          uploader.address,
        ]),
        value: fee,
        label: 'openChunk',
      });
      return (await monadb.chunkId(uploader.address, contentHash)) as string;
    };
    const pushed = new Uint8Array(randomBytes(2_048));
    const directChunk = await openChunk(pushed, 0);
    const ledgerChunk = await openChunk(new Uint8Array(randomBytes(2_048)), 1_000);
    const flipped = Uint8Array.from(pushed);
    flipped[0] ^= 1;

    const badHash = await putChunk(directChunk, flipped);
    const badSize = await putChunk(directChunk, pushed.subarray(1));
    const notDirect = await putChunk(ledgerChunk, pushed);
    const notChunk = await putChunk(hexlify(randomBytes(32)), pushed);
    const badPushId = await putChunk(uploader.address, pushed);
    const tooLarge = await putChunk(directChunk, new Uint8Array(MAX_DIRECT_CHUNK_SIZE + 1));
    check('push rejects: hash 400, size 400, ledger chunk 409, unknown chunk 404, bad id 400, > 16 MiB 413',
      badHash.status === 400 && badSize.status === 400 && notDirect.status === 409 && notChunk.status === 404 &&
      badPushId.status === 400 && tooLarge.status === 413,
      `hash=${badHash.status} size=${badSize.status} ledger=${notDirect.status} unknown=${notChunk.status} ` +
      `id=${badPushId.status} large=${tooLarge.status}`);

    const accepted = await putChunk(directChunk, pushed);
    const repeated = await putChunk(directChunk, pushed);
    const closed = decodeChunk(await monadb.getChunk(directChunk), directChunk) === null;
    check('push accepted → 201 stored + confirmed (chunk closed), repeated → 200',
      accepted.status === 201 && accepted.body.stored === true && accepted.body.confirmed === true &&
      typeof accepted.body.signature === 'string' && closed &&
      repeated.status === 200 && repeated.body.confirmed === true,
      `201 ${JSON.stringify(accepted.body)}; then ${repeated.status} ${JSON.stringify(repeated.body)}; closed=${closed}`);

    const preflight = await fetch(`${NODE_URL}/chunk/${directChunk}/data`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' },
    });
    const allowed = preflight.headers.get('access-control-allow-methods') ?? '';
    check('CORS preflight allows browser pushes (PUT)', preflight.status < 300 && /PUT/.test(allowed), `${preflight.status} ${allowed}`);

    // the hand-opened ledger chunk was never written: close it (escrow back)
    await sender.send({
      signer: uploader,
      to: contractAddress,
      data: monadbInterface.encodeFunctionData('closeChunk', [ledgerChunk]),
      label: 'closeChunk',
    });
  } catch (err) {
    check('e2e run', false, (err as Error).stack ?? String(err));
  } finally {
    if (node) await stopNode(node);
    if (process.env.E2E_KEEP_DATA === '1') log(`kept ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} checks passed in ${elapsed()}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
