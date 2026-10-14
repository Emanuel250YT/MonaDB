import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { HDNodeWallet, parseEther, Wallet } from 'ethers';
import { createMonadProvider, MonadJsonRpcProvider } from '../../sdk/src/provider';
import type { ConfigParams } from '../../sdk/src/contract';

dotenv.config();

export type NetworkName = 'localnet' | 'testnet' | 'mainnet';

export const ROOT = path.resolve(__dirname, '..', '..');

export const NETWORKS: Record<NetworkName, { chainId: number; rpcUrl: string; explorer?: string }> = {
  localnet: { chainId: 31337, rpcUrl: process.env.LOCALNET_RPC_URL ?? 'http://127.0.0.1:8545' },
  testnet: { chainId: 10143, rpcUrl: process.env.TESTNET_RPC_URL ?? 'https://testnet-rpc.monad.xyz', explorer: 'https://testnet.monadvision.com' },
  mainnet: { chainId: 143, rpcUrl: process.env.MAINNET_RPC_URL ?? 'https://rpc.monad.xyz', explorer: 'https://monadvision.com' },
};

export function networkArg(): NetworkName {
  const name = (process.argv[2] ?? 'localnet') as NetworkName;
  if (!NETWORKS[name]) throw new Error(`Unknown network "${name}" (localnet, testnet, mainnet)`);
  return name;
}

export function provider(network: NetworkName): MonadJsonRpcProvider {
  return createMonadProvider(NETWORKS[network].rpcUrl, NETWORKS[network].chainId);
}

/** The Hardhat node's well-known development accounts (never use them elsewhere) */
export const DEV_MNEMONIC = 'test test test test test test test test test test test junk';
export function devAccount(index: number): HDNodeWallet {
  return HDNodeWallet.fromPhrase(DEV_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
}

/** Localnet roles: #0 admin + treasury, #1–#4 replicators (ports 3000–3003), #5–#9 users */
export const LOCAL_REPLICATORS = [1, 2, 3, 4];
export const localEndpoint = (i: number) => `http://localhost:${3000 + i}`;

export function deployer(network: NetworkName): Wallet | HDNodeWallet {
  const p = provider(network);
  if (network === 'localnet' && !process.env.DEPLOYER_PRIVATE_KEY) return devAccount(0).connect(p);
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error('Set DEPLOYER_PRIVATE_KEY in .env');
  return new Wallet(key, p);
}

/** deployments/monad-<network>.json, or DEPLOYMENT_FILE (e.g. a second localnet on another port) */
export const deploymentPath = (network: NetworkName) =>
  process.env.DEPLOYMENT_FILE ? path.resolve(process.env.DEPLOYMENT_FILE) : path.join(ROOT, 'deployments', `monad-${network}.json`);

export interface DeploymentFile {
  network: NetworkName;
  chainId: number;
  rpcUrl: string;
  contract: string;
  deployBlock: number;
  deployTx: string;
  admin: string;
  treasury: string;
  replicators: { address: string; endpoint: string }[];
  nodes: string[];
  deployedAt: string;
  config?: Record<string, string | number>;
}

export function readDeployment(network: NetworkName): DeploymentFile {
  const file = deploymentPath(network);
  if (!fs.existsSync(file)) throw new Error(`${path.relative(ROOT, file)} not found: run npm run deploy:${network} first`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as DeploymentFile;
}

export function writeDeployment(network: NetworkName, deployment: DeploymentFile): void {
  fs.mkdirSync(path.join(ROOT, 'deployments'), { recursive: true });
  fs.writeFileSync(deploymentPath(network), JSON.stringify(deployment, null, 2) + '\n');
}

const env = (name: string, fallback: string) => process.env[name] || fallback;

/**
 * Pricing and protocol settings from the environment.  Defaults put MonaDB
 * at about the USD prices of SolaDB with MON ≈ USD 0.02 (Aug 2026):
 * 0.02 MON per replica (covers the node's confirmation gas), 0.1 MON per MiB
 * per replica, 0.001 MON per MiB of shard per 30-day epoch.
 */
export function configFromEnv(treasury: string): ConfigParams {
  return {
    treasury: env('TREASURY_ADDRESS', treasury),
    baseFeePerReplica: BigInt(env('UPLOAD_BASE_FEE_PER_REPLICA', parseEther('0.02').toString())),
    pricePerMib: BigInt(env('UPLOAD_PRICE_PER_MIB', parseEther('0.1').toString())),
    pricePerMibEpoch: BigInt(env('PRICE_PER_MIB_EPOCH', parseEther('0.001').toString())),
    protocolFeeBps: Number(env('PROTOCOL_FEE_BPS', '1000')),
    replicationThresholdPct: Number(env('REPLICATION_THRESHOLD_PCT', '60')),
    replicationWindow: BigInt(env('REPLICATION_WINDOW_SECONDS', '604800')),
    epochSeconds: BigInt(env('EPOCH_SECONDS', '2592000')),
    challengeWindowBlocks: BigInt(env('CHALLENGE_WINDOW_BLOCKS', '200')),
    challengeCooldown: BigInt(env('CHALLENGE_COOLDOWN_SECONDS', '3600')),
    challengerBountyBps: Number(env('CHALLENGER_BOUNTY_BPS', '1000')),
  };
}

/** Replicators to register: REPLICATOR_ADDRESSES + REPLICATOR_ENDPOINTS, or the 4 local nodes */
export function replicatorsFromEnv(network: NetworkName): { address: string; endpoint: string }[] {
  const addresses = (process.env.REPLICATOR_ADDRESSES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const endpoints = (process.env.REPLICATOR_ENDPOINTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (addresses.length > 0) {
    if (endpoints.length !== addresses.length) throw new Error('REPLICATOR_ENDPOINTS must list one endpoint per REPLICATOR_ADDRESSES entry');
    return addresses.map((address, i) => ({ address, endpoint: endpoints[i] }));
  }
  if (network === 'localnet') return LOCAL_REPLICATORS.map((i) => ({ address: devAccount(i).address, endpoint: localEndpoint(i - 1) }));
  return [];
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function artifact(): { abi: unknown[]; bytecode: string } {
  const file = path.join(ROOT, 'artifacts/contracts/MonaDB.sol/MonaDB.json');
  if (!fs.existsSync(file)) throw new Error('Compile first: npx hardhat compile');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
