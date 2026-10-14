import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Provider, Wallet } from 'ethers';

/** A secp256k1 private key: 32 bytes as hex, with or without 0x */
export function parsePrivateKey(raw: string): string {
  const value = raw.trim();
  const hex = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('Replicator private key must be 32 bytes of hex (0x + 64 hex characters)');
  }
  if (/^0+$/.test(hex)) throw new Error('Replicator private key must not be zero');
  return `0x${hex.toLowerCase()}`;
}

function expandHome(file: string): string {
  return file.startsWith('~/') || file === '~' ? path.join(os.homedir(), file.slice(1)) : file;
}

/**
 * Load the replicator wallet.  REPLICATOR_PRIVATE_KEY (inline) wins over
 * REPLICATOR_KEY_FILE (a file holding the key); one is required.
 */
export function loadReplicatorWallet(options: { privateKey?: string; keyFile?: string }, provider?: Provider): Wallet {
  if (options.privateKey?.trim()) return new Wallet(parsePrivateKey(options.privateKey), provider ?? null);
  if (options.keyFile?.trim()) {
    const file = path.resolve(expandHome(options.keyFile.trim()));
    if (!fs.existsSync(file)) throw new Error(`REPLICATOR_KEY_FILE ${file} does not exist`);
    return new Wallet(parsePrivateKey(fs.readFileSync(file, 'utf8')), provider ?? null);
  }
  throw new Error('Set REPLICATOR_PRIVATE_KEY (0x private key) or REPLICATOR_KEY_FILE (a file holding it)');
}
