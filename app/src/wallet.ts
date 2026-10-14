import { BrowserProvider, getAddress, isAddress, type Signer, toQuantity, type Wallet } from 'ethers';
import type { Network } from './network';

/**
 * Wallet layer: injected EVM wallets found with EIP-6963 (MetaMask, Rabby,
 * Phantom, Backpack, OKX…) or `window.ethereum`, and the burner wallet, both
 * turned into what MonaDBClient needs: an ethers Signer.  The SDK derives the
 * encryption key with the signer's own `personal_sign`.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
}

/** An injected wallet (EIP-6963 announcement, or the legacy window.ethereum) */
export interface InjectedWallet {
  /** Stable id for this page view (EIP-6963 uuid, or "window") */
  id: string;
  /** Reported by the extension: untrusted, render as text */
  name: string;
  /** data: URI reported by the extension (checked by safeIcon) */
  icon: string;
  rdns?: string;
  provider: Eip1193Provider;
}

export interface WalletSession {
  kind: 'injected' | 'burner';
  /** Wallet name as the wallet reports it (untrusted: render as text) */
  name: string;
  address: string;
  signer: Signer;
  disconnect(): Promise<void>;
}

/** What the session owner hears about: another account, or none (disconnected / wrong chain) */
export type SessionChange = (next: WalletSession | null, reason?: string) => void;

// ── Discovery (EIP-6963) ────────────────────────────────────────────────────

const announced = new Map<string, InjectedWallet>();
const listeners = new Set<(wallets: InjectedWallet[]) => void>();
let started = false;

function legacyWallet(): InjectedWallet | undefined {
  const ethereum = (globalThis as { ethereum?: Eip1193Provider }).ethereum;
  if (!ethereum || typeof ethereum.request !== 'function') return undefined;
  const flags = ethereum as unknown as Record<string, unknown>;
  const name = flags.isRabby ? 'Rabby' : flags.isPhantom ? 'Phantom' : flags.isMetaMask ? 'MetaMask' : 'Browser wallet';
  return { id: 'window', name, icon: '', provider: ethereum };
}

/** Wallets announced so far; the legacy window.ethereum only when nothing announced itself */
export function listWallets(): InjectedWallet[] {
  start();
  const wallets = [...announced.values()];
  if (wallets.length > 0) return wallets;
  const legacy = legacyWallet();
  return legacy ? [legacy] : [];
}

function start(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('eip6963:announceProvider', (event) => {
    const detail = (event as CustomEvent).detail as { info?: { uuid?: string; name?: string; icon?: string; rdns?: string }; provider?: Eip1193Provider };
    const info = detail?.info;
    if (!info?.uuid || !detail.provider || typeof detail.provider.request !== 'function') return;
    announced.set(info.uuid, {
      id: info.uuid,
      name: String(info.name ?? 'Wallet').slice(0, 60),
      icon: String(info.icon ?? ''),
      rdns: info.rdns,
      provider: detail.provider,
    });
    const wallets = listWallets();
    for (const listener of listeners) listener(wallets);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

/** Call `listener` whenever a wallet announces itself; returns the unsubscribe */
export function watchWallets(listener: (wallets: InjectedWallet[]) => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Wallet icons are data: URIs supplied by the extension; accept images only */
export function safeIcon(wallet: InjectedWallet): string | undefined {
  return /^data:image\/(svg\+xml|png|webp|gif|jpeg);base64,[a-z0-9+/=\s]+$/i.test(wallet.icon) ? wallet.icon : undefined;
}

// ── Chain ───────────────────────────────────────────────────────────────────

function chainParams(network: Network) {
  return {
    chainId: toQuantity(network.chainId),
    chainName: network.name,
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: [network.rpcUrl],
    ...(network.explorer ? { blockExplorerUrls: [network.explorer] } : {}),
  };
}

const errorCode = (err: unknown): number | undefined => {
  const e = err as { code?: unknown; data?: { originalError?: { code?: unknown } }; error?: { code?: unknown } };
  const code = e?.data?.originalError?.code ?? e?.error?.code ?? e?.code;
  return typeof code === 'number' ? code : undefined;
};

/** Ask the wallet to use `network`, adding the chain first when the wallet does not know it */
export async function ensureChain(provider: Eip1193Provider, network: Network): Promise<void> {
  const current = Number(BigInt(String(await provider.request({ method: 'eth_chainId' }))));
  if (current === network.chainId) return;
  const chainId = toQuantity(network.chainId);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (err) {
    // 4902: unknown chain (some wallets wrap it, some answer -32603)
    const code = errorCode(err);
    if (code !== 4902 && code !== -32603) throw err;
    await provider.request({ method: 'wallet_addEthereumChain', params: [chainParams(network)] });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  }
}

// ── Injected sessions ───────────────────────────────────────────────────────

async function sessionFor(wallet: InjectedWallet, account: string, unsubscribe: () => void): Promise<WalletSession> {
  const browser = new BrowserProvider(wallet.provider as never, 'any');
  const signer = await browser.getSigner(account);
  return {
    kind: 'injected',
    name: wallet.name,
    address: getAddress(account),
    signer,
    async disconnect() {
      unsubscribe();
      // EIP-2255 wallets can drop the permission; the others just forget us on reload
      await wallet.provider.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => undefined);
    },
  };
}

/**
 * Connect to an injected wallet on `network`.  With `silent`, only an already
 * authorized wallet answers (no prompt) and null means "not authorized".
 * `onChange` hears about account switches, chain switches and disconnects
 * made in the wallet.
 */
export async function connectWallet(
  wallet: InjectedWallet,
  network: Network,
  { silent = false, onChange }: { silent?: boolean; onChange?: SessionChange } = {},
): Promise<WalletSession | null> {
  const accounts = (await wallet.provider.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' })) as string[];
  const account = accounts?.find((a) => isAddress(a));
  if (!account) {
    if (silent) return null;
    throw new Error(`${wallet.name} did not share any account.`);
  }
  if (silent) {
    const chain = Number(BigInt(String(await wallet.provider.request({ method: 'eth_chainId' }))));
    if (chain !== network.chainId) return null; // never pop a chain switch without a click
  } else {
    await ensureChain(wallet.provider, network);
  }

  let current = getAddress(account);
  const onAccounts = (next: string[]) => {
    const replacement = next?.find((a) => isAddress(a));
    if (!replacement) {
      unsubscribe();
      onChange?.(null, `${wallet.name} disconnected.`);
      return;
    }
    if (getAddress(replacement) === current) return;
    current = getAddress(replacement);
    sessionFor(wallet, replacement, unsubscribe).then(
      (session) => onChange?.(session),
      () => onChange?.(null),
    );
  };
  const onChain = (chainId: string) => {
    if (Number(BigInt(chainId)) === network.chainId) return;
    unsubscribe();
    onChange?.(null, `${wallet.name} switched to another network. Connect again to use ${network.name}.`);
  };
  const unsubscribe = () => {
    wallet.provider.removeListener?.('accountsChanged', onAccounts);
    wallet.provider.removeListener?.('chainChanged', onChain);
  };
  if (onChange) {
    wallet.provider.on?.('accountsChanged', onAccounts);
    wallet.provider.on?.('chainChanged', onChain);
  }
  return sessionFor(wallet, account, unsubscribe);
}

// ── Burner sessions ─────────────────────────────────────────────────────────

export function burnerSession(wallet: Wallet): WalletSession {
  return {
    kind: 'burner',
    name: 'Burner wallet',
    address: wallet.address,
    signer: wallet,
    async disconnect() {
      /* nothing to tell: the key stays in this browser for next time */
    },
  };
}
