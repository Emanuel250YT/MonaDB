/**
 * Gas and cost of MonaDB operations, measured on a local Hardhat node with a
 * fresh deployment (default pricing from .env / scripts/lib/common.ts), and
 * priced at Monad's minimum base fee (100 gwei) and MON ≈ USD 0.02:
 *
 *   npm run localnet           # another terminal
 *   npm run measure-costs      # → deployments/costs-localnet.json + markdown tables
 *
 * Env: MONAD_GAS_PRICE_GWEI (default 100), MON_USD (default 0.02).
 * Hardhat prices storage with Ethereum's gas schedule; Monad's differs
 * (17 100 gas per new storage slot instead of 22 100, 10 100 for a cold
 * account instead of 2 600), so treat the gas figures as close estimates.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Contract, ContractFactory, formatEther, hexlify, parseEther, parseUnits, randomBytes, toBeHex, Wallet } from 'ethers';
import { chooseLayout, MONADB_ABI, MonaDBClient, sha256 } from '../sdk/src';
import { encodeConfig } from '../sdk/src/contract';
import { artifact, configFromEnv, NETWORKS, provider as providerFor, ROOT } from './lib/common';

const GAS_PRICE = parseUnits(process.env.MONAD_GAS_PRICE_GWEI ?? '100', 'gwei');
const MON_USD = Number(process.env.MON_USD ?? '0.02');
const KiB = 1024;
const MiB = 1024 * KiB;

const mon = (wei: bigint) => Number(formatEther(wei));
const usd = (wei: bigint) => mon(wei) * MON_USD;
const fmt = (wei: bigint) => `${mon(wei).toFixed(4)} MON (USD ${usd(wei).toFixed(4)})`;

async function main() {
  const provider = providerFor('localnet');
  if (Number((await provider.getNetwork()).chainId) !== NETWORKS.localnet.chainId) throw new Error('Run it against the local Hardhat node');
  const admin = new Wallet(hexlify(randomBytes(32)), provider);
  await provider.send('hardhat_setBalance', [admin.address, toBeHex(parseEther('1000000'))]);
  const { abi, bytecode } = artifact();
  const config = configFromEnv(admin.address);
  const deployed = await new ContractFactory(abi as never, bytecode, admin).deploy(encodeConfig(config));
  await deployed.waitForDeployment();
  const contract = await deployed.getAddress();
  const monadb = new Contract(contract, MONADB_ABI, admin);
  const user = new Wallet(hexlify(randomBytes(32)), provider);
  await provider.send('hardhat_setBalance', [user.address, toBeHex(parseEther('1000000'))]);

  const gasOf = async (tx: Promise<{ wait(): Promise<{ gasUsed: bigint } | null> }>) => (await (await tx).wait())!.gasUsed;
  const ops: Record<string, string> = {};
  const registration = await new MonaDBClient({ provider, signer: user, contract }).register();
  ops.registerIdentity = (await provider.getTransactionReceipt(registration!))!.gasUsed.toString();

  // chunk files: gas of every transaction (wallet + session), at Monad prices
  const rows: Record<string, unknown>[] = [];
  for (const size of [100 * KiB, MiB, 10 * MiB]) {
    for (const mode of ['direct', 'ledger'] as const) {
      const data = randomBytes(size);
      const client = new MonaDBClient({
        provider,
        signer: user,
        contract,
        mode,
        compress: false,
        replicas: 2,
        sessionWriter: false,
        pushChunk: async () => undefined,
        segmentSize: 48 * KiB,
      });
      const before = await provider.getBalance(user.address);
      const started = Date.now();
      const result = await client.uploadFile(data, { name: `file-${size}.bin` });
      const seconds = (Date.now() - started) / 1000;
      const gasWei = before - (await provider.getBalance(user.address)) - result.feePaid;
      const gasPriceLocal = (await provider.getFeeData()).gasPrice ?? 1n;
      const gas = gasWei / gasPriceLocal;
      const atMonad = gas * GAS_PRICE;
      rows.push({
        file: `${size / KiB} KiB`,
        mode,
        chunks: result.chunks.length,
        segmentTxs: result.segmentTransactions,
        uploadFee: result.feePaid.toString(),
        gas: gas.toString(),
        gasAtMonadPrice: atMonad.toString(),
        totalAtMonadPrice: (result.feePaid + atMonad).toString(),
        seconds,
      });
      console.log(`${(size / KiB).toString().padStart(6)} KiB ${mode.padEnd(6)} chunks ${result.chunks.length}, segments ${result.segmentTransactions}, fee ${fmt(result.feePaid)}, gas ${gas} → ${fmt(atMonad)}, ${seconds.toFixed(1)} s`);
    }
  }

  // blobs: the upload transaction only (shards go to the nodes over HTTP)
  const blobRows: Record<string, unknown>[] = [];
  for (const [label, payload] of [['1 MiB', MiB], ['100 MiB', 100 * MiB], ['1 GiB', 1024 * MiB]] as const) {
    for (const [k, m] of [[2, 1], [10, 4]] as const) {
      // the SDK's layout: fragment size picked to waste little, blobs of ≤ 1024 stripes
      const layout = chooseLayout({ payloadSize: payload, nodes: k + m, k, m });
      const shardSize = BigInt(layout.shardSize);
      const epochs = 12;
      const fee = (await monadb.quoteBlob(shardSize, k + m, epochs)) * BigInt(layout.blobCount);
      const perBlob = fee / BigInt(layout.blobCount);
      const args = Array.from({ length: layout.blobCount }, () => ({ root: hexlify(sha256(randomBytes(32))), dataShards: k, totalShards: k + m, shardSize, payloadSize: BigInt(payload), epochs, maxFee: perBlob }));
      const record = hexlify(randomBytes(96 + 40 + 36 + 61));
      const gas = await gasOf((monadb.connect(user) as Contract).upload([], args, user.address, 'monadb.file.v3', record, { value: fee }));
      const stored = layout.storedBytes / MiB;
      blobRows.push({ file: label, code: `${k}+${m}`, fragmentKiB: layout.fragmentSize / KiB, blobs: layout.blobCount, storedMiB: stored, storageFee: fee.toString(), gas: gas.toString(), gasAtMonadPrice: (gas * GAS_PRICE).toString() });
      console.log(`blob ${label.padStart(7)} ${k}+${m}: ${layout.blobCount} blob(s), stored ${stored.toFixed(1)} MiB, storage fee (12 epochs) ${fmt(fee)}, gas ${gas} → ${fmt(gas * GAS_PRICE)}`);
    }
  }

  const out = path.join(ROOT, 'deployments', 'costs-localnet.json');
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        gasPriceGwei: Number(GAS_PRICE / 10n ** 9n),
        monUsd: MON_USD,
        config: Object.fromEntries(Object.entries(config).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])),
        operations: ops,
        files: rows,
        blobs: blobRows,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`\n→ ${path.relative(process.cwd(), out)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
