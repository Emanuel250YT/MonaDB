/**
 * Top up the registered replicators so they can pay for their
 * confirmations and storage proofs.
 *
 *   npm run fund-replicator:testnet          # FUND_REPLICATOR_MON (default 1) each
 *
 * Monad keeps a 10 MON reserve per account: below it, a transfer only goes
 * through as the sender's first transaction in 3 blocks, so the SDK sender
 * waits for that window between transfers.
 */
import { parseEther } from 'ethers';
import { TransactionSender } from '../sdk/src/transactions';
import { deployer, networkArg, readDeployment } from './lib/common';

async function main() {
  const network = networkArg();
  const deployment = readDeployment(network);
  const wallet = deployer(network);
  const provider = wallet.provider!;
  const sender = new TransactionSender(provider);
  const target = parseEther(process.env.FUND_REPLICATOR_MON ?? '1');
  const replicators = (process.env.REPLICATOR_ADDRESSES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const addresses = replicators.length > 0 ? replicators : deployment.replicators.map((r) => r.address);
  if (addresses.length === 0) throw new Error('No replicators registered yet: run init first');

  for (const address of addresses) {
    const balance = await provider.getBalance(address);
    if (balance >= target) {
      console.log(`${address}: ${balance} wei, nothing to do`);
      continue;
    }
    const result = await sender.send({ signer: wallet, to: address, data: '0x', value: target - balance, gasLimit: 21_000n, label: `fund ${address}` });
    console.log(`${address}: +${target - balance} wei (${result.hash})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
