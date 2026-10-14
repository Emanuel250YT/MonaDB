/**
 * Deploy MonaDB, then configure it (init.ts).
 *
 *   npx hardhat compile
 *   npm run deploy:localnet      # needs `npm run localnet` in another terminal
 *   npm run deploy:testnet       # DEPLOYER_PRIVATE_KEY in .env, funded with testnet MON
 *
 * Writes deployments/monad-<network>.json.  An existing deployment is kept
 * (pass --force to deploy a new contract).
 */
import fs from 'node:fs';
import { ContractFactory } from 'ethers';
import { encodeConfig } from '../sdk/src/contract';
import { artifact, configFromEnv, deployer, deploymentPath, NETWORKS, networkArg, writeDeployment } from './lib/common';
import { init } from './init';

async function main() {
  const network = networkArg();
  const force = process.argv.includes('--force');
  const wallet = deployer(network);
  const provider = wallet.provider!;

  if (fs.existsSync(deploymentPath(network)) && !force) {
    const existing = JSON.parse(fs.readFileSync(deploymentPath(network), 'utf8'));
    const code = await provider.getCode(existing.contract);
    if (code !== '0x') {
      console.log(`MonaDB already deployed on ${network} at ${existing.contract} (use --force for a new one); configuring it`);
      await init(network);
      return;
    }
    console.log(`The contract in ${deploymentPath(network)} is gone (fresh chain?): deploying again`);
  }

  const balance = await provider.getBalance(wallet.address);
  console.log(`Deployer ${wallet.address} on ${network} (chain ${NETWORKS[network].chainId}), balance ${balance} wei`);
  const config = configFromEnv(wallet.address);
  const { abi, bytecode } = artifact();
  const factory = new ContractFactory(abi as never, bytecode, wallet);
  const tx = await factory.getDeployTransaction(encodeConfig(config));
  // Monad charges the gas limit: estimate it, plus 10 %
  const gasLimit = ((await provider.estimateGas({ ...tx, from: wallet.address })) * 110n) / 100n;
  const sent = await wallet.sendTransaction({ ...tx, gasLimit });
  const receipt = await sent.wait();
  if (!receipt?.contractAddress) throw new Error(`Deployment failed (${sent.hash})`);
  console.log(`MonaDB deployed at ${receipt.contractAddress} (block ${receipt.blockNumber}, gas ${receipt.gasUsed}/${gasLimit})`);

  writeDeployment(network, {
    network,
    chainId: NETWORKS[network].chainId,
    rpcUrl: NETWORKS[network].rpcUrl,
    contract: receipt.contractAddress,
    deployBlock: receipt.blockNumber,
    deployTx: sent.hash,
    admin: wallet.address,
    treasury: config.treasury,
    replicators: [],
    nodes: [],
    deployedAt: new Date().toISOString(),
  });
  await init(network);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
