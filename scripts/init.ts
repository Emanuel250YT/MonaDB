/**
 * Configure a deployed MonaDB (idempotent): apply the pricing from .env when
 * it differs, register the replicators and refresh the deployments file.
 *
 *   npm run init:localnet        # 4 local nodes: dev accounts #1–#4 on ports 3000–3003
 *   REPLICATOR_ADDRESSES=0x… REPLICATOR_ENDPOINTS=https://… npm run init:testnet
 *
 * Only the admin (the deployer) can change the config or register nodes.
 */
import path from 'node:path';
import { Contract } from 'ethers';
import { ConfigParams, decodeConfig, encodeConfig, MONADB_ABI } from '../sdk/src/contract';
import { configFromEnv, deployer, deploymentPath, NetworkName, readDeployment, replicatorsFromEnv, writeDeployment } from './lib/common';

async function send(contract: Contract, method: string, args: unknown[]) {
  // Monad charges the gas limit: estimate it, plus max(10 %, 75 000) like the SDK
  const estimate: bigint = await contract[method].estimateGas(...args);
  const gasLimit = estimate + (estimate / 10n > 75_000n ? estimate / 10n : 75_000n);
  const tx = await contract[method](...args, { gasLimit });
  await tx.wait();
  return tx.hash as string;
}

const same = (a: ConfigParams, b: ConfigParams) =>
  (Object.keys(a) as (keyof ConfigParams)[]).every((k) => String(a[k]).toLowerCase() === String(b[k]).toLowerCase());

export async function init(network: NetworkName): Promise<void> {
  const deployment = readDeployment(network);
  const admin = deployer(network);
  const monadb = new Contract(deployment.contract, MONADB_ABI, admin);

  const current = decodeConfig(await monadb.getConfig(), await monadb.admin());
  if (current.admin.toLowerCase() !== admin.address.toLowerCase()) {
    throw new Error(`The admin is ${current.admin}, not ${admin.address}`);
  }
  const wanted = configFromEnv(deployment.treasury ?? admin.address);
  const { admin: _admin, ...currentParams } = current;
  if (!same(currentParams, wanted)) {
    console.log(`config updated (${await send(monadb, 'updateConfig', [encodeConfig(wanted)])})`);
  } else {
    console.log('config unchanged');
  }

  for (const r of replicatorsFromEnv(network)) {
    const info = await monadb.getReplicator(r.address);
    if (!info.registered) {
      console.log(`replicator ${r.address} → ${r.endpoint} registered (${await send(monadb, 'registerReplicator', [r.address, r.endpoint])})`);
    } else if (!info.active) {
      console.log(`replicator ${r.address} reactivated (${await send(monadb, 'setReplicatorActive', [r.address, true])})`);
    } else {
      console.log(`replicator ${r.address} already registered (${info.endpoint})`);
    }
  }

  const count = Number(await monadb.replicatorCount());
  const [authorities, list] = count > 0 ? await monadb.getReplicators(0, count) : [[], []];
  const registered = (authorities as string[]).map((address, i) => ({ address, endpoint: list[i].endpoint as string, active: list[i].active as boolean }));
  const nodeUrls = (process.env.MONADB_NODE_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  writeDeployment(network, {
    ...deployment,
    treasury: wanted.treasury,
    replicators: registered.map(({ address, endpoint }) => ({ address, endpoint })),
    nodes: nodeUrls.length > 0 ? nodeUrls : registered.filter((r) => r.active).map((r) => r.endpoint),
    config: Object.fromEntries(Object.entries(wanted).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])),
  });
  console.log(`${path.relative(process.cwd(), deploymentPath(network))} updated (${registered.length} replicator(s))`);
}

if (require.main === module) {
  const network = (process.argv[2] ?? 'localnet') as NetworkName;
  init(network).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
