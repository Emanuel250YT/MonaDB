import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Wallet } from 'ethers';
import { loadReplicatorWallet, parsePrivateKey } from './wallet';

describe('replicator wallet', () => {
  let dir: string;

  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monadb-key-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('parses 32-byte hex keys and rejects anything else', () => {
    const key = Wallet.createRandom().privateKey;
    expect(parsePrivateKey(key)).toBe(key.toLowerCase());
    expect(parsePrivateKey(key.slice(2).toUpperCase())).toBe(key.toLowerCase());
    expect(parsePrivateKey(`  ${key}\n`)).toBe(key.toLowerCase());
    expect(() => parsePrivateKey('not a key')).toThrow('32 bytes');
    expect(() => parsePrivateKey('0x1234')).toThrow('32 bytes');
    expect(() => parsePrivateKey(`0x${'0'.repeat(64)}`)).toThrow('zero');
  });

  it('loads REPLICATOR_KEY_FILE and REPLICATOR_PRIVATE_KEY (which wins)', () => {
    const fileKey = Wallet.createRandom();
    const inlineKey = Wallet.createRandom();
    const file = path.join(dir, 'replicator.key');
    fs.writeFileSync(file, `${fileKey.privateKey}\n`);

    expect(loadReplicatorWallet({ keyFile: file }).address).toBe(fileKey.address);
    expect(loadReplicatorWallet({ privateKey: inlineKey.privateKey, keyFile: file }).address).toBe(inlineKey.address);
  });

  it('fails clearly without a key or with a missing file', () => {
    expect(() => loadReplicatorWallet({})).toThrow('REPLICATOR_PRIVATE_KEY');
    expect(() => loadReplicatorWallet({ keyFile: path.join(dir, 'nope.key') })).toThrow('does not exist');
  });
});
