/**
 * Run the local replicator nodes of a localnet deployment, one per
 * registered replicator that is a Hardhat development account (deploy.ts
 * registers accounts #1–#4 at http://localhost:3000–3003), each on the port of
 * its registered endpoint, with the fs + file stores in
 * monadb-node/data/localnet-<port>.  Ctrl+C stops them all.
 *
 *   npm run build:sdk && (cd monadb-node && npm run build)
 *   npx tsx monadb-node/test/local-nodes.ts                       # from the repo root
 *   MONADB_DEPLOYMENT=path/to/monad-localnet.json npx tsx monadb-node/test/local-nodes.ts
 *
 * Env: MONADB_DEPLOYMENT (default deployments/monad-localnet.json),
 *      LOCAL_NODES (how many, default all), BLOB_POLL_INTERVAL_MS (5000),
 *      LOG_LEVEL (log).  Never use these keys outside a local Hardhat chain.
 */
import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HDNodeWallet } from 'ethers';

const NODE_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(NODE_DIR, '..');
const DEPLOYMENT_FILE = path.resolve(process.env.MONADB_DEPLOYMENT ?? path.join(ROOT, 'deployments', 'monad-localnet.json'));
const MNEMONIC = 'test test test test test test test test test test test junk';

interface Deployment {
  chainId: number;
  rpcUrl: string;
  contract: string;
  replicators?: { address: string; endpoint: string }[];
}

const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8')) as Deployment;
if (deployment.chainId !== 31337) throw new Error(`${DEPLOYMENT_FILE} is chain ${deployment.chainId}: development keys only run on a local Hardhat chain (31337)`);
const main = path.join(NODE_DIR, 'dist', 'main.js');
if (!fs.existsSync(main)) throw new Error(`${main} not found: run "npm run build" in monadb-node first`);

// Hardhat development accounts #1–#9 by address
const devKeys = new Map<string, string>();
for (let i = 1; i < 10; i++) {
  const wallet = HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);
  devKeys.set(wallet.address.toLowerCase(), wallet.privateKey);
}

const nodes = (deployment.replicators ?? []).filter((r) => devKeys.has(r.address.toLowerCase()));
const limit = Number(process.env.LOCAL_NODES ?? nodes.length);
if (nodes.length === 0) throw new Error(`No replicator of ${DEPLOYMENT_FILE} is a Hardhat development account (run npm run init:localnet)`);

const children: ChildProcess[] = [];
for (const replicator of nodes.slice(0, limit)) {
  const url = new URL(replicator.endpoint);
  const port = url.port || '80';
  const child = spawn(process.execPath, [main], {
    cwd: NODE_DIR,
    env: {
      ...process.env,
      PORT: port,
      MONADB_DEPLOYMENT: DEPLOYMENT_FILE,
      REPLICATOR_PRIVATE_KEY: devKeys.get(replicator.address.toLowerCase()),
      NODE_ENDPOINT: replicator.endpoint,
      CHUNK_STORE: 'fs',
      METADATA_STORE: 'file',
      BLOB_STORE: 'fs',
      DATA_DIR: path.join(NODE_DIR, 'data', `localnet-${port}`),
      POLL_INTERVAL_MS: process.env.POLL_INTERVAL_MS ?? '2000',
      BLOB_POLL_INTERVAL_MS: process.env.BLOB_POLL_INTERVAL_MS ?? '5000',
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'log',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const echo = (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      // eslint-disable-next-line no-control-regex
      if (line.trim()) console.log(`[${port}] ${line.replace(/\x1b\[[0-9;]*m/g, '')}`);
    }
  };
  child.stdout!.on('data', echo);
  child.stderr!.on('data', echo);
  child.on('exit', (code) => console.log(`[${port}] exited (${code})`));
  children.push(child);
  console.log(`node ${replicator.address} → ${replicator.endpoint}`);
}

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
