import { hexlify, parseEther, type Provider, toQuantity, Wallet, type JsonRpcProvider } from 'ethers';

/**
 * Burner wallet for the localnet: a key generated once and kept in this
 * browser's storage, so the app works without a wallet extension.  The
 * secret sits in localStorage in plain text — test only, never real funds.
 */

const STORAGE_KEY = 'monadb:burner:v1';

/** The subset of Web Storage the burner needs (injectable for tests) */
export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Burner {
  wallet: Wallet;
  /** false when storage is unavailable: the key lasts for this visit only */
  persisted: boolean;
}

/** localStorage, or undefined where it is blocked (private mode, sandboxed frames) */
export function browserStorage(): KeyStore | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

const isKey = (value: string) => /^0x[0-9a-f]{64}$/i.test(value);

let ephemeralKey: string | undefined;

/** Load the burner key, creating (and storing) it on first use */
export function loadBurner(provider: Provider, store: KeyStore | undefined = browserStorage()): Burner {
  let key: string | undefined;
  try {
    const stored = store?.getItem(STORAGE_KEY) ?? '';
    if (isKey(stored)) key = stored;
  } catch {
    /* storage blocked: fall through to a fresh key */
  }
  let persisted = Boolean(key);
  if (!key) {
    key = ephemeralKey ?? hexlify(crypto.getRandomValues(new Uint8Array(32)));
    try {
      if (store) {
        store.setItem(STORAGE_KEY, key);
        persisted = true;
      }
    } catch {
      /* private mode: keep the key in memory for this visit */
    }
    if (!persisted) ephemeralKey = key;
  }
  return { wallet: new Wallet(key, provider), persisted };
}

/** Delete the stored burner key (its MON is lost unless sent elsewhere first) */
export function forgetBurner(store: KeyStore | undefined = browserStorage()): void {
  ephemeralKey = undefined;
  try {
    store?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing stored */
  }
}

/**
 * Give `recipient` a balance of `mon` test MON on the local Hardhat node
 * (`hardhat_setBalance` sets it, it does not add).  Localnet only.
 */
export async function fundOnLocalnet(provider: JsonRpcProvider, recipient: string, mon: string): Promise<void> {
  try {
    await provider.send('hardhat_setBalance', [recipient, toQuantity(parseEther(mon))]);
  } catch (err) {
    throw new Error(`The local node refused to fund the burner (${(err as Error).message}). Is it a Hardhat node (npm run localnet)?`);
  }
}
