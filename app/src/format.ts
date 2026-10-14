import { formatEther, formatUnits } from 'ethers';

// ── Numbers and addresses ───────────────────────────────────────────────────

export function short(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  return `${+(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/**
 * An amount of MON.  Below 1 MON every amount gets 6 decimals, so the lines
 * of a quote add up at a glance; tiny amounts keep their first digits.
 */
export function mon(wei: bigint): string {
  const value = Number(formatEther(wei));
  if (value === 0) return '0 MON';
  const abs = Math.abs(value);
  if (abs >= 1000) return `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} MON`;
  if (abs >= 1) return `${value.toFixed(4)} MON`;
  if (abs >= 0.000001) return `${value.toFixed(6)} MON`;
  return `${value.toPrecision(2)} MON`;
}

/** A gas price in gwei, e.g. "100 gwei" */
export function gwei(wei: bigint): string {
  const value = Number(formatUnits(wei, 'gwei'));
  return `${value >= 10 ? Math.round(value) : +value.toFixed(2)} gwei`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ── Downloads ───────────────────────────────────────────────────────────────

/** Control and bidi-override characters (these let "gpj.exe" show as "exe.jpg") */
const INVISIBLE = /[\x00-\x1f\x7f‎‏‪-‮⁦-⁩]/g;

/** A manifest name for display (always rendered with textContent) */
export function displayName(name: string): string {
  return name.replace(INVISIBLE, '').trim().slice(0, 200) || 'Untitled file';
}

/**
 * The name in a manifest is chosen by whoever shared the file: keep only the
 * last path segment, drop invisible characters and never return "." or "..".
 */
export function safeFileName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const clean = base.replace(INVISIBLE, '').trim();
  return !clean || clean === '.' || clean === '..' ? 'monadb-download' : clean.slice(0, 200);
}

/** A plain type/subtype MIME, or application/octet-stream */
export function safeMime(mime: string): string {
  return /^[\w.+-]{1,64}\/[\w.+-]{1,128}$/.test(mime) ? mime : 'application/octet-stream';
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** Wallets report a rejected prompt with EIP-1193's 4001, ethers' ACTION_REJECTED or just words */
export function isRejection(err: unknown): boolean {
  for (let e = err as { code?: unknown; message?: unknown; cause?: unknown; error?: unknown } | undefined, depth = 0; e && depth < 4; depth++) {
    if (e.code === 4001 || e.code === 'ACTION_REJECTED') return true;
    if (typeof e.message === 'string' && /user rejected|rejected the request|request rejected|approval denied|user denied|declined|cancell?ed by (the )?user/i.test(e.message)) {
      return true;
    }
    e = (e.cause ?? e.error) as typeof e;
  }
  return false;
}

/** What the contract's custom errors mean, in words */
const CONTRACT_ERRORS: Record<string, string> = {
  NotRegistered: 'This wallet (or the one you share with) has no MonaDB key yet.',
  FeeAboveMax: 'The price changed while you were signing. Check the new quote and try again.',
  InsufficientPayment: 'The payment did not cover the fee. Check the new quote and try again.',
  ChunkExists: 'You already uploaded these exact bytes.',
  BlobExists: 'You already uploaded these exact bytes.',
  ChunkNotSettled: 'These chunks cannot be closed yet: they still wait for replicas.',
  BlobNotClosable: 'This storage cannot be closed before it ends.',
  BlobExpired: 'This storage has already ended.',
  NotOwner: 'Only the owner can do that.',
  CannotGrantSelf: 'That is your own wallet: you can already open this file.',
  GrantNotFound: 'That wallet has no access to revoke.',
  RecordNotFound: 'This file does not exist any more.',
  InvalidContent: 'The file description does not fit in one record.',
};

/** A sentence for a toast */
export function errorMessage(err: unknown): string {
  if (isRejection(err)) return 'You rejected the request in your wallet.';
  const e = err as { code?: unknown; errorName?: unknown; shortMessage?: unknown; message?: unknown; info?: { error?: { message?: unknown } } };
  if (e?.code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(String(e?.message ?? ''))) {
    return 'Not enough MON in this wallet for this transaction and its gas.';
  }
  if (typeof e?.errorName === 'string' && CONTRACT_ERRORS[e.errorName]) return CONTRACT_ERRORS[e.errorName];
  if (e?.code === 'NETWORK_ERROR' || e?.code === 'SERVER_ERROR' || e?.code === 'TIMEOUT') {
    return `The RPC did not answer (${String(e.shortMessage ?? e.message ?? e.code)}). Try again in a moment.`;
  }
  const text = typeof e?.shortMessage === 'string' ? e.shortMessage : typeof e?.message === 'string' ? e.message : String(err);
  // ethers appends a JSON dump of the request: keep the sentence
  return text.replace(/\s*\((?:action|transaction|info|request|code|version)=.*$/s, '');
}
