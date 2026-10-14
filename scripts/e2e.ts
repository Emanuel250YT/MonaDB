/**
 * End-to-end check against a running monadb-node:
 *
 *   1. Ledger chunk: open (paying the fee) → write its segments to the logs →
 *      the node rebuilds it, confirms on-chain and gets paid → the
 *      confirmation closes the chunk → GET /chunk/:id/data returns the bytes
 *   2. SDK file, direct mode: encrypted multi-chunk upload sent straight to
 *      the node (one wallet transaction, no segment writes) → the node checks
 *      and confirms → download through the node only
 *   3. Sharing: a second wallet registers, gets access and decrypts the file
 *
 * Usage (node running against the same deployment):
 *   npm run e2e:localnet        (or e2e:testnet)
 *
 * Env: UPLOADER_PRIVATE_KEY (default: dev account #5 on localnet, else the
 * deployer), NODE_URL (default http://localhost:3000), E2E_CHUNK_BYTES
 * (default 20000), E2E_TIMEOUT_MS (default 180000).
 * Results are written to deployments/e2e-monad-<network>.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Contract, formatEther, hexlify, parseEther, Wallet } from 'ethers';
import { decodeChunk, ids, MONADB_ABI, MonaDBClient, monadbInterface, quoteChunk, sha256, TransactionSender } from '../sdk/src';
import { decodeConfig } from '../sdk/src/contract';
import { deployer, devAccount, NETWORKS, networkArg, provider as providerFor, readDeployment, ROOT, sleep } from './lib/common';

const NODE_URL = (process.env.NODE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const CHUNK_BYTES = Number(process.env.E2E_CHUNK_BYTES ?? '20000');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? '180000');
const mon = (wei: bigint) => `${formatEther(wei)} MON`;

const main = async () => {
  const network = networkArg();
  const deployment = readDeployment(network);
  const provider = providerFor(network);
  const sender = new TransactionSender(provider);
  const uploader = process.env.UPLOADER_PRIVATE_KEY
    ? new Wallet(process.env.UPLOADER_PRIVATE_KEY, provider)
    : network === 'localnet'
      ? devAccount(5).connect(provider)
      : deployer(network);
  // deterministic second wallet so reruns reuse its identity
  const viewer = new Wallet(hexlify(sha256(new TextEncoder().encode(`monadb-e2e-viewer:${uploader.address}`))), provider);
  const sdkDeployment = { ...deployment, nodes: [NODE_URL] };
  const owner = new MonaDBClient({ provider, signer: uploader, deployment: sdkDeployment, mode: 'direct', directChunkSize: 16 * 1024, ledgerFallback: false });
  const reader = new MonaDBClient({ provider, signer: viewer, deployment: sdkDeployment, ledgerFallback: false });
  const monadb = new Contract(deployment.contract, MONADB_ABI, provider);

  const started = Date.now();
  const deadline = started + TIMEOUT_MS;
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const results: Record<string, unknown> = { network, contract: deployment.contract, startedAt: new Date().toISOString() };

  const status = await fetch(`${NODE_URL}/status`).then((r) => r.json());
  console.log(`Node ${NODE_URL}: replicator ${status.replicator}, registered=${status.registered}`);
  if (status.contract && status.contract.toLowerCase() !== deployment.contract.toLowerCase()) {
    throw new Error(`Node watches contract ${status.contract}, deployment is ${deployment.contract}`);
  }
  console.log(`Uploader ${uploader.address}: ${mon(await provider.getBalance(uploader.address))}`);

  // ── 1. Identity ────────────────────────────────────────────────────────────
  const registered = await owner.register();
  if (registered) console.log(`[${elapsed()}] Registered encryption key (${registered})`);

  // ── 2. Ledger chunk: open → segments → node confirms (closes it) → GET bytes
  const data = new Uint8Array(randomBytes(CHUNK_BYTES));
  const contentHash = sha256(data);
  const chunkId = ids.chunk(uploader.address, contentHash);
  const config = decodeConfig(await monadb.getConfig(), await monadb.admin());
  const fee = quoteChunk(config, data.length, 1);
  const segmentSize = 8 * 1024;
  const open = await sender.send({
    signer: uploader,
    to: deployment.contract,
    data: monadbInterface.encodeFunctionData('openChunk', [
      { contentHash: hexlify(contentHash), size: data.length, segmentSize, replicas: 1, maxFee: fee },
      uploader.address,
    ]),
    value: fee,
    label: 'openChunk',
  });
  const writes = [];
  for (let i = 0; i * segmentSize < data.length; i++) {
    writes.push({
      signer: uploader,
      to: deployment.contract,
      data: monadbInterface.encodeFunctionData('writeSegment', [chunkId, i, data.subarray(i * segmentSize, (i + 1) * segmentSize)]),
      label: `segment ${i}`,
    });
  }
  // the last segment completes the chunk: send it after the others so its gas estimate includes that
  await sender.sendAll(writes.slice(0, -1));
  await sender.send(writes[writes.length - 1]);
  const uploadedAt = Date.now();
  console.log(`[${elapsed()}] Uploaded ${CHUNK_BYTES} bytes in ${writes.length} segments → chunk ${chunkId}`);
  console.log(`         fee ${mon(fee)}, open ${open.hash}`);

  let chunk = decodeChunk(await monadb.getChunk(chunkId), chunkId);
  while (chunk && chunk.state !== 'Cool') {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the node to confirm (state ${chunk.state})`);
    await sleep(500);
    chunk = decodeChunk(await monadb.getChunk(chunkId), chunkId);
  }
  const secondsToCool = (Date.now() - uploadedAt) / 1000;
  console.log(`[${elapsed()}] Chunk is Cool${chunk ? '' : ' and closed by its last confirmation'} (${secondsToCool.toFixed(1)} s after upload)`);

  const response = await fetch(`${NODE_URL}/chunk/${chunkId}/data`);
  if (!response.ok) throw new Error(`GET /chunk/${chunkId}/data → HTTP ${response.status}`);
  const served = new Uint8Array(await response.arrayBuffer());
  const identical = Buffer.compare(Buffer.from(served), Buffer.from(data)) === 0;
  console.log(`[${elapsed()}] GET /chunk/:id/data → ${served.length} bytes, identical=${identical}`);
  if (!identical) throw new Error('E2E FAILED at the raw chunk step');
  results.rawChunk = { chunk: chunkId, bytes: CHUNK_BYTES, segments: writes.length, feeWei: fee.toString(), openTx: open.hash, secondsToCool };

  // ── 3. SDK file, direct: chunks go straight to the node → Cool ────────────
  const file = new Uint8Array(randomBytes(40_000));
  const balanceBefore = await provider.getBalance(uploader.address);
  const upload = await owner.uploadFile(file, {
    name: 'e2e-report.bin',
    onProgress: (p) => console.log(`         [${p.done}/${p.total}] ${p.stage}`),
  });
  console.log(
    `[${elapsed()}] SDK upload (${upload.mode}): record ${upload.recordId}, ${upload.chunks.length} chunks, ` +
      `${upload.transactions.length} wallet tx, accepted by ${upload.nodes.join(', ')}`,
  );
  await owner.waitUntilCool(upload.chunks, { timeoutMs: Math.max(deadline - Date.now(), 1000) });
  const closed = (await owner.chunkStatus(upload.chunks)).filter((c) => c.state === 'Closed').length;
  const spent = balanceBefore - (await provider.getBalance(uploader.address));
  console.log(`[${elapsed()}] All file chunks are Cool; ${closed}/${upload.chunks.length} closed — spent ${mon(spent)} = fee ${mon(upload.feePaid)} + gas ${mon(upload.networkFee)}`);
  const fileOk = async (client: MonaDBClient) => {
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        return Buffer.compare(Buffer.from((await client.downloadFile(upload.recordId)).data), Buffer.from(file)) === 0;
      } catch (err) {
        if ((err as Error).message !== lastError) console.log(`         download not ready: ${(err as Error).message}`);
        lastError = (err as Error).message;
        await sleep(1000);
      }
    }
    return false;
  };
  const ownerOk = await fileOk(owner);
  console.log(`[${elapsed()}] Owner download through the node only, decrypted and verified: ${ownerOk}`);

  // ── 4. Sharing with a second wallet ────────────────────────────────────────
  if ((await provider.getBalance(viewer.address)) < parseEther('0.05')) {
    await sender.send({ signer: uploader, to: viewer.address, data: '0x', value: parseEther('0.1'), gasLimit: 21_000n, label: 'fund viewer' });
    console.log(`[${elapsed()}] Funded viewer ${viewer.address} with 0.1 MON`);
  }
  await reader.register();
  const shareTx = await owner.share(upload.recordId, viewer.address);
  const viewerOk = await fileOk(reader);
  console.log(`[${elapsed()}] Shared with ${viewer.address} (${shareTx}); viewer decrypted it: ${viewerOk}`);

  results.sdkFile = {
    recordId: upload.recordId,
    mode: upload.mode,
    bytes: file.length,
    chunks: upload.chunks.length,
    chunksClosed: closed,
    feeWei: upload.feePaid.toString(),
    gasWei: upload.networkFee.toString(),
    spentWei: spent.toString(),
    walletTransactions: upload.transactions,
    ownerDownloadOk: ownerOk,
    viewer: viewer.address,
    shareTx,
    viewerDownloadOk: viewerOk,
  };
  results.finishedAt = new Date().toISOString();
  results.passed = ownerOk && viewerOk && closed === upload.chunks.length;

  const out = path.join(ROOT, 'deployments', `e2e-monad-${network}.json`);
  fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  const explorer = NETWORKS[network].explorer;
  if (explorer) console.log(`\nShare tx: ${explorer}/tx/${shareTx}`);
  console.log(`Results: ${path.relative(process.cwd(), out)}`);
  if (!results.passed) throw new Error('E2E FAILED at the SDK / sharing step');
  console.log('\nE2E PASSED: ledger chunk → node confirmation (paid, chunk closed) → GET /chunk/:id/data returned the same bytes;');
  console.log('            direct file → node checked + confirmed → downloaded through the node by its owner');
  console.log('            and by the wallet it was shared with');
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
