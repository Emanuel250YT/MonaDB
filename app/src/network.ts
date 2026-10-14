import {
  type ConfigAccount,
  createMonadProvider,
  decodeConfig,
  DEPLOYMENTS,
  isHex32,
  MONADB_ABI,
  type MonadJsonRpcProvider,
  type MonaDBDeployment,
} from '@monadb/sdk';
import { Contract, getAddress, isAddress } from 'ethers';

// ── Networks ────────────────────────────────────────────────────────────────

export const NETWORKS = {
  testnet: {
    name: 'Monad Testnet',
    chainId: 10143,
    rpcUrl: 'https://testnet-rpc.monad.xyz',
    explorer: 'https://testnet.monadvision.com',
    faucet: 'https://faucet.monad.xyz',
    testOnly: true,
  },
  mainnet: {
    name: 'Monad',
    chainId: 143,
    rpcUrl: 'https://rpc.monad.xyz',
    explorer: 'https://monadvision.com',
    faucet: undefined,
    testOnly: false,
  },
  // Local development against `npm run localnet` (hardhat node, chain 31337)
  localnet: {
    name: 'Monad Localnet',
    chainId: 31337,
    rpcUrl: 'http://127.0.0.1:8545',
    explorer: undefined,
    faucet: undefined,
    testOnly: true,
  },
} as const;

export type NetworkName = keyof typeof NETWORKS;

/** The VITE_* variables the app reads (see .env.example) */
export interface NetworkEnv {
  VITE_MONADB_NETWORK?: string;
  VITE_MONADB_DEPLOYMENT?: string;
  VITE_MONADB_CONTRACT?: string;
  VITE_MONADB_RPC_URL?: string;
  VITE_MONADB_CHAIN_ID?: string;
  VITE_MONADB_NODE_URLS?: string;
}

export interface Network {
  network: NetworkName;
  /** Human name, e.g. "Monad Testnet" */
  name: string;
  chainId: number;
  rpcUrl: string;
  /** Block explorer (MonadVision); undefined on localnet */
  explorer?: string;
  /** Where to get test MON */
  faucet?: string;
  /** Undefined when MonaDB has no deployment on this network */
  deployment?: MonaDBDeployment;
  /** Replicator endpoints tried first */
  nodeUrls: string[];
  /** The burner wallet and its "Fund" button are offered (localnet only) */
  burner: boolean;
  testOnly: boolean;
  /** Configuration mistake to show instead of a working app */
  problem?: string;
}

function isNetworkName(value: string): value is NetworkName {
  return Object.hasOwn(NETWORKS, value);
}

function parseDeployment(json: string): Partial<MonaDBDeployment> {
  let value: Partial<MonaDBDeployment>;
  try {
    value = JSON.parse(json) as Partial<MonaDBDeployment>;
  } catch {
    throw new Error('VITE_MONADB_DEPLOYMENT is not valid JSON (inline the whole deployments/monad-<network>.json on one line).');
  }
  if (!value || typeof value.contract !== 'string' || !isAddress(value.contract)) {
    throw new Error('VITE_MONADB_DEPLOYMENT needs a "contract" with a valid 0x address.');
  }
  return value;
}

function splitUrls(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((u) => u.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/**
 * Work out which network, RPC and contract the app uses.  Precedence:
 * VITE_MONADB_DEPLOYMENT, then VITE_MONADB_CONTRACT (+ RPC / chain id), then
 * the SDK's DEPLOYMENTS[network].
 */
export function resolveNetwork(env: NetworkEnv, deployments: Record<string, MonaDBDeployment> = DEPLOYMENTS): Network {
  let inline: Partial<MonaDBDeployment> | undefined;
  let problem: string | undefined;
  try {
    inline = env.VITE_MONADB_DEPLOYMENT?.trim() ? parseDeployment(env.VITE_MONADB_DEPLOYMENT) : undefined;
  } catch (err) {
    problem = (err as Error).message;
  }

  // An explicit network wins; otherwise the inlined deployment says which one it is
  const wanted = (env.VITE_MONADB_NETWORK?.trim() || inline?.network || 'testnet').toLowerCase();
  let network: NetworkName = 'testnet';
  if (isNetworkName(wanted)) network = wanted;
  else problem ??= `Unknown network "${wanted}". Set VITE_MONADB_NETWORK to testnet, mainnet or localnet.`;
  const info = NETWORKS[network];

  if (inline?.network && env.VITE_MONADB_NETWORK?.trim() && inline.network.toLowerCase() !== network) {
    problem ??= `VITE_MONADB_DEPLOYMENT is for ${inline.network} but VITE_MONADB_NETWORK is ${network}.`;
  }

  const chainId = Number(env.VITE_MONADB_CHAIN_ID?.trim() || inline?.chainId || info.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) problem ??= 'VITE_MONADB_CHAIN_ID must be a positive integer.';
  const rpcUrl = env.VITE_MONADB_RPC_URL?.trim() || inline?.rpcUrl || deployments[network]?.rpcUrl || info.rpcUrl;

  let deployment: MonaDBDeployment | undefined;
  const contract = env.VITE_MONADB_CONTRACT?.trim();
  if (contract && !isAddress(contract)) problem ??= 'VITE_MONADB_CONTRACT is not a valid 0x address.';
  if (inline?.contract) {
    deployment = {
      network,
      chainId,
      rpcUrl,
      contract: getAddress(inline.contract),
      ...(inline.deployBlock !== undefined ? { deployBlock: Number(inline.deployBlock) } : {}),
      nodes: Array.isArray(inline.nodes) ? inline.nodes.map(String) : [],
    };
  } else if (contract && isAddress(contract)) {
    deployment = { network, chainId, rpcUrl, contract: getAddress(contract), nodes: [] };
  } else if (deployments[network]) {
    deployment = { ...deployments[network], chainId, rpcUrl };
  }

  const envNodes = splitUrls(env.VITE_MONADB_NODE_URLS);
  return {
    network,
    name: info.name,
    chainId,
    rpcUrl,
    explorer: info.explorer,
    faucet: info.faucet,
    deployment,
    nodeUrls: envNodes.length ? envNodes : (deployment?.nodes ?? []).map((u) => u.replace(/\/$/, '')),
    burner: network === 'localnet',
    testOnly: info.testOnly,
    problem,
  };
}

// ── Explorers ───────────────────────────────────────────────────────────────

/** MonadVision link for an address or a transaction (none on localnet) */
export function explorerUrl(network: Pick<Network, 'explorer'>, kind: 'address' | 'tx', value: string): string | undefined {
  if (!network.explorer) return undefined;
  if (kind === 'address' && !isAddress(value)) return undefined;
  if (kind === 'tx' && !isHex32(value)) return undefined;
  return `${network.explorer}/${kind}/${value}`;
}

// ── Read-only checks (no wallet needed) ─────────────────────────────────────

export function createProvider(network: Pick<Network, 'rpcUrl' | 'chainId'>): MonadJsonRpcProvider {
  return createMonadProvider(network.rpcUrl, network.chainId);
}

/** Why the network cannot be used: the RPC does not answer, is another chain, or has no contract */
export class NetworkProblem extends Error {
  constructor(
    message: string,
    readonly kind: 'rpc' | 'missing' | 'chain',
  ) {
    super(message);
    this.name = 'NetworkProblem';
  }
}

/**
 * Check the RPC is on the expected chain and the MonaDB contract exists
 * (eth_getCode), then read its configuration.  Throws a NetworkProblem.
 */
export async function probeContract(network: Network, provider: MonadJsonRpcProvider): Promise<ConfigAccount> {
  const contract = network.deployment?.contract;
  if (!contract) throw new NetworkProblem(`MonaDB is not deployed on ${network.name} yet.`, 'missing');
  let code: string;
  let chainId: bigint;
  try {
    [chainId, code] = await Promise.all([
      provider.send('eth_chainId', []).then((v: string) => BigInt(v)),
      provider.getCode(contract),
    ]);
  } catch (err) {
    throw new NetworkProblem(`Cannot read from the ${network.name} RPC at ${network.rpcUrl} (${(err as Error).message}).`, 'rpc');
  }
  if (Number(chainId) !== network.chainId) {
    throw new NetworkProblem(`The RPC at ${network.rpcUrl} is chain ${chainId}, not ${network.name} (${network.chainId}).`, 'chain');
  }
  if (code === '0x') {
    throw new NetworkProblem(`No MonaDB contract at ${contract} on ${network.name}: deploy it, or point the app at the right address.`, 'missing');
  }
  const monadb = new Contract(contract, MONADB_ABI, provider);
  try {
    const [raw, admin] = await Promise.all([monadb.getConfig(), monadb.admin()]);
    return decodeConfig(raw, admin);
  } catch (err) {
    throw new NetworkProblem(`The contract at ${contract} does not answer like MonaDB (${(err as Error).message}).`, 'missing');
  }
}
