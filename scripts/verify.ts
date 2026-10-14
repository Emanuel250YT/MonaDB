/**
 * Verify MonaDB's source on MonadVision (Sourcify) and, with ETHERSCAN_API_KEY,
 * on Monadscan.
 *
 *   npm run verify:testnet       (hardhat run --network monadTestnet)
 */
import fs from 'node:fs';
import path from 'node:path';
import hre from 'hardhat';
import { encodeConfig } from '../sdk/src/contract';

async function main() {
  const network = hre.network.name === 'monadMainnet' ? 'mainnet' : 'testnet';
  const file = path.join(__dirname, '..', 'deployments', `monad-${network}.json`);
  const deployment = JSON.parse(fs.readFileSync(file, 'utf8'));
  // constructor arguments = the deploy transaction's data after the creation bytecode
  // (the config may have changed since, so read them from the transaction, not the chain)
  const tx = await hre.ethers.provider.getTransaction(deployment.deployTx);
  const factory = await hre.ethers.getContractFactory('MonaDB');
  const encoded = '0x' + tx!.data.slice(factory.bytecode.length);
  const [params] = hre.ethers.AbiCoder.defaultAbiCoder().decode(factory.interface.deploy.inputs, encoded);
  await hre.run('verify:verify', { address: deployment.contract, constructorArguments: [encodeConfig(params.toObject())] });
  console.log(`Verified ${deployment.contract}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
