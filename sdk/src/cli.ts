#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { formatEther, Wallet } from 'ethers';
import { MonaDBClient, MonaDBDeployment, UploadMode } from './client';
import { DEPLOYMENTS } from './deployments';
import { toHex } from './manifest';
import { createMonadProvider } from './provider';

const HELP = `monadb — encrypted, replicated files on Monad

Usage: monadb <command> [args]

  whoami                          Address, balance, identity and encryption key
  register                        Publish this wallet's encryption key
  quote <file> [--mode M] [--epochs E] [--replicas N]
                                  Cost of uploading a file
  upload <file> [--mode M] [--epochs E] [--redundancy R] [--no-compress] [--wait]
                                  Compress, encrypt, upload and register a file
                                  --mode blob (erasure-coded shards on the
                                  nodes, prepaid E epochs: the default when a
                                  node answers), ledger (Monad event logs),
                                  direct (whole chunks on the nodes) or auto
  upload-many <name> <files…> [--epochs E]
                                  Many small files as one bundle (one blob)
  download <recordId> [-o PATH] [--entry NAME]
                                  Download and decrypt a file (--entry: one
                                  file of a bundle)
  bundle <recordId> [-d DIR]      Download every file of a bundle into DIR
  extend <recordId> <epochs>      Prepay more storage epochs for a blob file
  share <recordId> <address>      Give a registered wallet read access
  revoke <recordId> <address>     Remove read access
  status <recordId>               Replication state of every chunk / blob
  reclaim [recordId]              Close settled chunks / expired blobs and
                                  recover their escrow (no recordId: all yours)
  rm <recordId>                   Delete the record (and its grants), close chunks
  ls                              Files you own or that were shared with you
  nodes                           Registered replicators

Environment:
  MONADB_PRIVATE_KEY  wallet private key (0x…)
  MONADB_NETWORK      testnet (default), mainnet or localnet
  MONADB_DEPLOYMENT   path to a deployments/monad-<network>.json (overrides MONADB_NETWORK)
  MONAD_RPC_URL       RPC endpoint (defaults to the deployment's)
  MONADB_NODE_URLS    comma-separated replicator URLs tried first
  MONADB_MODE         default upload mode: auto, blob, direct or ledger
  MONADB_EPOCHS       default blob storage epochs (12)
`;

const mon = (wei: bigint) => `${Number(formatEther(wei)).toFixed(6)} MON`;

function loadDeployment(): MonaDBDeployment {
  const file = process.env.MONADB_DEPLOYMENT;
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8')) as MonaDBDeployment;
  const network = process.env.MONADB_NETWORK ?? 'testnet';
  const deployment = DEPLOYMENTS[network];
  if (!deployment) throw new Error(`No MonaDB deployment known for "${network}"; set MONADB_DEPLOYMENT`);
  return deployment;
}

function makeClient(): MonaDBClient {
  const deployment = loadDeployment();
  const key = process.env.MONADB_PRIVATE_KEY;
  if (!key) throw new Error('Set MONADB_PRIVATE_KEY to the wallet private key');
  const provider = createMonadProvider(process.env.MONAD_RPC_URL ?? deployment.rpcUrl, deployment.chainId);
  const nodeUrls = (process.env.MONADB_NODE_URLS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  return new MonaDBClient({
    signer: new Wallet(key, provider),
    provider,
    deployment,
    nodeUrls: nodeUrls.length ? nodeUrls : deployment.nodes,
    mode: uploadMode(process.env.MONADB_MODE ?? 'auto'),
    epochs: Number(process.env.MONADB_EPOCHS ?? '12'),
    // a CLI key signs without prompts: no session key needed
    sessionWriter: false,
  });
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

function uploadMode(value: string): UploadMode {
  if (value !== 'auto' && value !== 'blob' && value !== 'direct' && value !== 'ledger') {
    throw new Error(`Unknown mode "${value}" (auto, blob, direct or ledger)`);
  }
  return value;
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what}. Run "monadb help".`);
  return value;
}

const MIME: Record<string, string> = {
  '.txt': 'text/plain', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.csv': 'text/csv', '.md': 'text/markdown',
};

async function main(argv: string[]) {
  const [command = 'help', ...args] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  const client = makeClient();

  switch (command) {
    case 'whoami': {
      const address = await client.address();
      const balance = await client.provider.getBalance(address);
      const { publicKey } = await client.keys();
      const identity = await client.identity();
      console.log(`address     ${address}`);
      console.log(`balance     ${mon(balance)}`);
      console.log(`registered  ${identity !== null}${identity && toHex(identity.encryptionKey) !== toHex(publicKey) ? ' (different key, run register)' : ''}`);
      console.log(`public key  ${toHex(publicKey)}`);
      return;
    }
    case 'register': {
      const hash = await client.register();
      console.log(hash ? `Encryption key published (${hash})` : 'Already registered with this key');
      return;
    }
    case 'quote': {
      const replicas = Number(option(args, '--replicas') ?? '1');
      const mode = uploadMode(option(args, '--mode') ?? process.env.MONADB_MODE ?? 'auto');
      const epochs = option(args, '--epochs');
      const file = need(args[0], '<file>');
      const q = await client.quoteFile(fs.statSync(file).size, replicas, mode, { name: path.basename(file), ...(epochs ? { epochs: Number(epochs) } : {}) });
      if (q.mode === 'blob') {
        const days = Number(q.storageSeconds ?? 0n) / 86_400;
        console.log(`${path.basename(file)}, blob: ${q.layout!.k}+${q.layout!.m} shards (any ${q.layout!.k} rebuild it), ${q.chunks} blob(s), ${q.epochs} epoch(s) ≈ ${days.toFixed(1)} days`);
        console.log(`  storage fee   ${mon(q.uploadFee)}  (prepaid, protocol + shard holders)`);
      } else {
        console.log(`${path.basename(file)} with ${replicas} replica(s), ${q.mode}: ${q.chunks} chunk(s), ${q.segments} segment transaction(s)`);
        console.log(`  upload fee    ${mon(q.uploadFee)}  (protocol + replicators)`);
      }
      console.log(`  gas           ${q.gas} × ${Number(q.gasPrice) / 1e9} gwei = ${mon(q.networkFee)}  (Monad charges the gas limit)`);
      console.log(`  total         ${mon(q.total)}  (at most; compression lowers it)`);
      return;
    }
    case 'upload': {
      const replicas = Number(option(args, '--replicas') ?? '1');
      const modeOption = option(args, '--mode');
      const mode = modeOption ? uploadMode(modeOption) : undefined;
      const compress = !flag(args, '--no-compress');
      const epochs = option(args, '--epochs');
      const redundancy = option(args, '--redundancy');
      const wait = flag(args, '--wait');
      const file = need(args[0], '<file>');
      const data = new Uint8Array(fs.readFileSync(file));
      if (!(await client.isRegistered())) {
        console.log('Registering encryption key…');
        await client.register();
      }
      const result = await client.uploadFile(data, {
        name: path.basename(file),
        mime: MIME[path.extname(file).toLowerCase()],
        replicas,
        mode,
        compress,
        ...(epochs ? { epochs: Number(epochs) } : {}),
        ...(redundancy ? { redundancy: Number(redundancy) } : {}),
        onProgress: (p) => {
          if (p.stage !== 'segments' || p.done === p.total || p.done % 25 === 0) console.log(`  [${p.done}/${p.total}] ${p.stage}`);
        },
      });
      console.log(`recordId      ${result.recordId}`);
      console.log(`mode          ${result.mode}${result.nodes.length ? ` (${result.nodes.join(', ')})` : ''}`);
      console.log(`stored        ${result.storedSize} of ${data.length} bytes${result.storedSize < data.length ? ' (gzip)' : ''}`);
      if (result.layout) {
        console.log(`erasure code  ${result.layout.k}+${result.layout.m} (any ${result.layout.k} shards rebuild it)`);
        console.log(`blobs         ${result.blobs!.join(', ')}`);
        console.log(`paid until    ${new Date(Number(result.expiresAt ?? 0n) * 1000).toISOString()}`);
      } else {
        console.log(`chunks        ${result.chunks.length}`);
      }
      console.log(`fees paid     ${mon(result.feePaid)}`);
      console.log(`gas paid      ${mon(result.networkFee)}`);
      console.log(`segment txs   ${result.segmentTransactions}`);
      if (wait) {
        console.log('Waiting for replication…');
        await client.waitUntilCool(result.chunks);
        console.log('All chunks are Cool (replicated)');
      }
      return;
    }
    case 'upload-many': {
      const epochs = option(args, '--epochs');
      const name = need(args[0], '<name>');
      const paths = args.slice(1);
      if (paths.length === 0) throw new Error('Missing <files…>. Run "monadb help".');
      if (!(await client.isRegistered())) await client.register();
      const files = paths.map((p) => ({ name: path.basename(p), mime: MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream', data: new Uint8Array(fs.readFileSync(p)) }));
      const result = await client.uploadFiles(files, { name, ...(epochs ? { epochs: Number(epochs) } : {}) });
      console.log(`recordId      ${result.recordId}`);
      console.log(`files         ${result.entries.length} in one blob (${result.layout!.k}+${result.layout!.m})`);
      console.log(`stored        ${result.storedSize} bytes${result.storedSize < result.size ? ' (gzip)' : ''}`);
      console.log(`fees paid     ${mon(result.feePaid)}`);
      return;
    }
    case 'bundle': {
      const dir = option(args, '-d') ?? process.cwd();
      const entries = await client.downloadBundle(need(args[0], '<recordId>'));
      fs.mkdirSync(dir, { recursive: true });
      for (const entry of entries) {
        const safeName = path.basename(entry.name.replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '');
        if (!safeName || safeName === '.' || safeName === '..') throw new Error(`Unsafe file name in the bundle: ${JSON.stringify(entry.name)}`);
        fs.writeFileSync(path.join(dir, safeName), entry.data, { flag: 'wx' });
      }
      console.log(`Saved ${entries.length} files to ${dir} (sha256 verified)`);
      return;
    }
    case 'extend': {
      const hash = await client.extendFile(need(args[0], '<recordId>'), Number(need(args[1], '<epochs>')));
      console.log(`Extended (${hash})`);
      return;
    }
    case 'download': {
      const out = option(args, '-o');
      const entry = option(args, '--entry');
      const recordId = need(args[0], '<recordId>');
      const file = await client.downloadFile(recordId, entry ? { entry } : {});
      // The manifest name is chosen by whoever shared the file: never let it pick the path
      const safeName = path.basename(file.name.replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '');
      if (!out && (!safeName || safeName === '.' || safeName === '..')) {
        throw new Error('The file name in this record is unsafe; pass -o <path> to choose one');
      }
      const target = out ?? path.join(process.cwd(), safeName);
      // An explicit -o may overwrite; a name from the manifest never does
      fs.writeFileSync(target, file.data, { flag: out ? 'w' : 'wx' });
      console.log(`Saved ${file.data.length} bytes to ${target} (sha256 verified)`);
      return;
    }
    case 'share': {
      const hash = await client.share(need(args[0], '<recordId>'), need(args[1], '<address>'));
      console.log(`Shared (${hash})`);
      return;
    }
    case 'revoke': {
      const hash = await client.revoke(need(args[0], '<recordId>'), need(args[1], '<address>'));
      console.log(`Revoked (${hash})`);
      return;
    }
    case 'status': {
      const { manifest, chunks, cool, blobs } = await client.fileStatus(need(args[0], '<recordId>'));
      if (blobs) {
        console.log(`${manifest.name} — ${manifest.size} bytes, ${blobs.length} blob(s), ${cool ? 'Cool' : 'Hot'}`);
        for (const b of blobs) {
          const until = b.expiresAt ? new Date(Number(b.expiresAt) * 1000).toISOString() : 'closed';
          console.log(`  ${b.id}  ${b.state}  ${b.held}/${b.totalShards} shards (any ${b.dataShards} rebuild it), paid until ${until}`);
        }
        return;
      }
      console.log(`${manifest.name} — ${manifest.size} bytes, ${chunks.length} chunk(s), ${cool ? 'Cool' : 'Hot'}`);
      for (const c of chunks) {
        console.log(`  ${c.id}  ${c.state}  ${c.confirmedReplicas}/${c.requiredReplicas} replicas`);
      }
      return;
    }
    case 'reclaim': {
      if (!args[0]) {
        const { closed, wei } = await client.reclaimAllDeposits();
        console.log(closed ? `Closed ${closed} chunk(s) / blob(s); ${mon(wei)} returned` : 'Nothing settled to close yet');
        return;
      }
      const { closed } = await client.reclaimDeposits(args[0]);
      console.log(closed ? `Closed ${closed} chunk(s) / blob(s); escrow returned` : 'Nothing settled to close yet');
      return;
    }
    case 'rm': {
      await client.deleteFile(need(args[0], '<recordId>'));
      console.log('Deleted');
      return;
    }
    case 'ls': {
      const files = await client.listFiles();
      if (files.length === 0) console.log('No files');
      for (const f of files) {
        const when = new Date(f.createdAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
        console.log(`${f.recordId}  ${f.shared ? `shared by ${f.owner}` : 'owned'}  (${when})`);
      }
      return;
    }
    case 'nodes': {
      const nodes = await client.replicators();
      if (nodes.length === 0) console.log('No replicators registered');
      for (const n of nodes) console.log(`${n.authority}  ${n.active ? 'active  ' : 'inactive'}  ${n.endpoint}  (${n.confirmations} confirmations)`);
      return;
    }
    default:
      throw new Error(`Unknown command "${command}". Run "monadb help".`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exitCode = 1;
});
