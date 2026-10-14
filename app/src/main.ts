import './style.css';
import {
  MonaDBClient,
  isHex32,
  type ChunkStatus,
  type ConfigAccount,
  type FileEntry,
  type AnyManifest,
  type FileQuote,
  type ReplicatorAccount,
  type UploadMode,
} from '@monadb/sdk';
import { isAddress, VoidSigner, ZeroAddress } from 'ethers';
import { balloonSvg, cloudSvg, planeSvg, skylineSvg, stepShareSvg, stepUploadSvg, stepWalletSvg, sunSvg } from './art';
import { fundOnLocalnet, loadBurner } from './burner';
import { bytes, displayName, errorMessage, gwei, mon, plural, safeFileName, safeMime, short } from './format';
import { createProvider, explorerUrl, NetworkProblem, type NetworkEnv, probeContract, resolveNetwork } from './network';
import { burnerSession, connectWallet, listWallets, safeIcon, watchWallets, type WalletSession } from './wallet';

// ── Network ─────────────────────────────────────────────────────────────────

// VITE_MONADB_NETWORK / VITE_MONADB_DEPLOYMENT / VITE_MONADB_CONTRACT / VITE_MONADB_RPC_URL / VITE_MONADB_NODE_URLS (see .env.example)
const NETWORK = resolveNetwork(import.meta.env as NetworkEnv);
/** Reads go through the deployment's RPC; writes through the wallet */
const provider = createProvider(NETWORK);

/**
 * Max file size in the demo: the SDK encodes in memory (about 2–3× the file
 * while uploading); ledger uploads stay small (one 48 KiB segment
 * transaction at ~40 gas per byte)
 */
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_LEDGER_BYTES = 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const FUND_MON = '100';
const BURNER = 'burner';

/** Read-only client (replicator list) before any wallet connects */
const reader = NETWORK.deployment
  ? new MonaDBClient({ signer: new VoidSigner(ZeroAddress, provider), provider, deployment: NETWORK.deployment, chainId: NETWORK.chainId })
  : undefined;

// ── State ───────────────────────────────────────────────────────────────────

interface FileView {
  entry: FileEntry;
  manifest?: AnyManifest;
  chunks?: ChunkStatus[];
  /** Wallets holding a grant (owner only, loaded when the share panel opens) */
  viewers?: string[];
  error?: string;
}

interface Notice {
  text: string;
  /** Command that fixes it, shown as code */
  command?: string;
}

/** A file opened from a link (#file=<record id>) or a pasted id, resolved once the key is unlocked */
interface LinkRequest {
  recordId: string;
  status: 'waiting' | 'checking' | 'no-access' | 'missing' | 'error';
  owner?: string;
  error?: string;
}

const state = {
  wallets: listWallets(),
  session: undefined as WalletSession | undefined,
  client: undefined as MonaDBClient | undefined,
  burnerPersisted: true,
  /** Bumped on every connect/disconnect so stale background work stops */
  generation: 0,
  registered: false,
  unlocked: false,
  balance: undefined as bigint | undefined,
  busy: false,
  /** The MonaDB contract answers on this network (undefined while checking) */
  ready: undefined as boolean | undefined,
  config: undefined as ConfigAccount | undefined,
  notice: undefined as Notice | undefined,
  file: undefined as File | undefined,
  replicas: 1,
  /** auto = erasure-coded blob on the nodes when one answers, else the ledger */
  mode: 'auto' as UploadMode,
  /** Blob storage prepaid, in contract epochs */
  epochs: 12,
  /** Blob parity shards = node losses survived (undefined = by node count) */
  redundancy: undefined as number | undefined,
  /** Replicator nodes that answered the last probe */
  nodesAlive: undefined as number | undefined,
  quote: undefined as FileQuote | undefined,
  quoting: false,
  quoteError: '',
  request: undefined as LinkRequest | undefined,
  /** File to flash in the list (opened from a link) */
  highlight: '',
  progress: [] as { stage: string; text: string }[],
  files: new Map<string, FileView>(),
  watching: new Set<string>(),
  downloading: '',
  replicators: [] as ReplicatorAccount[],
  nodeUrl: readSetting('monadb:node', ''),
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Addresses and ids are the only chain values that go into markup, and only
 * after isAddress / isHex32 (0x + hex, so nothing to escape).  Names, MIME
 * types, endpoints and wallet names only ever reach the page through
 * textContent.
 */
function addr(value: string): string {
  return isAddress(value) ? value : '';
}

function hex32(value: string): string {
  return isHex32(value) ? value : '';
}

function link(href: string, label: string, className = ''): string {
  return `<a ${className ? `class="${className}" ` : ''}href="${esc(href)}" target="_blank" rel="noreferrer">${esc(label)}</a>`;
}

/** An address, linked to MonadVision when the network has an explorer */
function accountLink(account: string, label = short(account), className = 'hex'): string {
  if (!addr(account)) return '';
  const url = explorerUrl(NETWORK, 'address', account);
  return url ? link(url, label, className) : `<span class="${className}" title="${account}">${esc(label)}</span>`;
}

/** A record, chunk or blob id (not an account: no explorer page) */
function idLabel(id: string, label = short(id)): string {
  return hex32(id) ? `<span class="hex" title="${id}">${esc(label)}</span>` : '';
}

function txLink(hash: string, label = short(hash)): string {
  const url = explorerUrl(NETWORK, 'tx', hash);
  return url ? link(url, label, 'hex') : idLabel(hash, label);
}

/** Replace a section's markup only when it changed (keeps focus and selections); `fill` sets text every time */
function setHtml(el: HTMLElement, html: string, fill?: (root: HTMLElement) => void): void {
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
  fill?.(el);
}

function setText(root: ParentNode, selector: string, value: string): void {
  for (const node of root.querySelectorAll<HTMLElement>(selector)) {
    if (node.textContent !== value) node.textContent = value;
  }
}

function readSetting(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeSetting(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* private mode: the setting lasts for this visit only */
  }
}

function toast(message: string, isError = false): void {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' is-error' : ''}`;
  el.textContent = message;
  $('toasts')?.append(el);
  setTimeout(() => el.remove(), isError ? 9000 : 5000);
}

const COPY_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>';

/** Link that opens a file in this app: #file=<record id> (fragments never reach a server) */
function fileLink(recordId: string): string {
  const url = new URL(location.href);
  url.search = '';
  url.hash = `file=${recordId}`;
  return url.toString();
}

/** The record id in a pasted MonaDB link, or a bare id (0x + 64 hex) */
function parseFileRef(value: string): string | undefined {
  const text = value.trim();
  if (isHex32(text)) return text.toLowerCase();
  const match = /[#?&]file=(0x[0-9a-fA-F]{64})(?![0-9a-fA-F])/.exec(text);
  return match ? match[1].toLowerCase() : undefined;
}

async function copyText(value: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast(`${what} copied.`);
  } catch {
    toast(value);
  }
}

async function run(task: () => Promise<void>): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    await task();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err), true);
  } finally {
    state.busy = false;
    render();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isCool(chunks: ChunkStatus[]): boolean {
  return chunks.every((c) => c.state === 'Cool' || c.state === 'Closed');
}

function noMonHint(): string {
  if (NETWORK.burner) return ' Use “Fund” to get test MON.';
  if (NETWORK.faucet) return ` Get test MON at ${NETWORK.faucet}.`;
  return ' Add some MON to pay the storage fee and the gas.';
}

function windowText(): string {
  const seconds = Number(state.config?.replicationWindow ?? 0n);
  if (!seconds) return 'its replication window';
  return seconds % 3600 === 0 ? `its ${plural(seconds / 3600, 'hour')} replication window` : `its ${plural(Math.round(seconds / 60), 'minute')} replication window`;
}

// ── Network checks ──────────────────────────────────────────────────────────

async function checkNetwork(): Promise<void> {
  if (NETWORK.problem) {
    state.ready = false;
    state.notice = { text: NETWORK.problem };
  } else if (!NETWORK.deployment) {
    state.ready = false;
    state.notice = {
      text: `MonaDB is not deployed on ${NETWORK.name} yet. Deploy the contract, then regenerate the SDK deployments (or set VITE_MONADB_DEPLOYMENT):`,
      command: `npx hardhat compile && npm run deploy:${NETWORK.network} && npm run export-abi`,
    };
  } else {
    try {
      state.config = await probeContract(NETWORK, provider);
      state.ready = true;
      state.notice = undefined;
    } catch (err) {
      state.ready = false;
      const kind = err instanceof NetworkProblem ? err.kind : 'rpc';
      state.notice = {
        text: errorMessage(err),
        command:
          kind === 'missing'
            ? `npm run deploy:${NETWORK.network}`
            : NETWORK.network === 'localnet' && kind === 'rpc'
              ? 'npm run localnet'
              : undefined,
      };
    }
  }
  render();
  if (state.ready) await refreshReplicators();
}

async function refreshReplicators(): Promise<void> {
  try {
    const all = await (state.client ?? reader)?.replicators();
    if (all) {
      state.replicators = all
        .filter((r) => isAddress(r.authority))
        .sort((a, b) => Number(b.active) - Number(a.active) || Number(b.confirmations - a.confirmations));
    }
  } catch (err) {
    console.warn('Could not list replicators', err);
  }
  render();
}

function requireReady(): void {
  if (state.ready === false) throw new Error(state.notice?.text ?? `MonaDB is not available on ${NETWORK.name}.`);
}

// ── Wallet ──────────────────────────────────────────────────────────────────

function nodeUrls(): string[] {
  return [...new Set([state.nodeUrl, ...NETWORK.nodeUrls].filter(Boolean))];
}

function resetAccount(): void {
  state.generation++;
  state.registered = false;
  state.unlocked = false;
  state.balance = undefined;
  state.file = undefined;
  state.quote = undefined;
  state.quoteError = '';
  state.progress = [];
  state.files.clear();
  state.watching.clear();
  if (state.request) state.request = { recordId: state.request.recordId, status: 'waiting' };
}

/** Start using a connected wallet: one MonaDBClient per account */
async function adopt(session: WalletSession): Promise<void> {
  resetAccount();
  state.session = session;
  state.client = new MonaDBClient({
    signer: session.signer,
    provider,
    deployment: NETWORK.deployment,
    chainId: NETWORK.chainId,
    nodeUrls: nodeUrls(),
    chunkSize: CHUNK_BYTES,
    // The burner signs without prompts, so it writes the segments itself
    sessionWriter: session.kind !== 'burner',
  });
  render();
  const generation = state.generation;
  const [registered] = await Promise.all([state.client.isRegistered(), refreshBalance()]);
  if (generation === state.generation) state.registered = registered;
}

/** How a wallet is remembered for the silent reconnect */
const walletKey = (wallet: { rdns?: string; name: string }) => wallet.rdns || wallet.name;

async function connect(choice: string): Promise<void> {
  if (!NETWORK.deployment) throw new Error(`MonaDB is not deployed on ${NETWORK.name} yet.`);
  let session: WalletSession | null;
  let remembered = BURNER;
  if (choice === BURNER) {
    if (!NETWORK.burner) throw new Error('The burner wallet only exists on the localnet.');
    const burner = loadBurner(provider);
    state.burnerPersisted = burner.persisted;
    session = burnerSession(burner.wallet);
  } else {
    const wallet = state.wallets[Number(choice)];
    if (!wallet) throw new Error('That wallet is not available any more. Reload the page and try again.');
    remembered = walletKey(wallet);
    session = await connectWallet(wallet, NETWORK, { onChange: (next, reason) => void switchAccount(next, reason) });
  }
  if (!session) throw new Error('The wallet did not share an account.');
  writeSetting('monadb:wallet', remembered);
  await adopt(session);
  toast(`Connected ${short(session.address)} with ${session.name}.`);
}

/** The wallet switched accounts, switched networks or disconnected on its own */
async function switchAccount(next: WalletSession | null, reason?: string): Promise<void> {
  if (!next) {
    resetAccount();
    state.session = undefined;
    state.client = undefined;
    render();
    toast(reason ?? 'Your wallet disconnected.');
    return;
  }
  try {
    await adopt(next);
    toast(`Switched to ${short(next.address)}. Unlock your key again for this account.`);
  } catch (err) {
    toast(errorMessage(err), true);
  }
  render();
}

/** Reconnect the wallet used last time without prompting (already authorized wallets only) */
let reconnectTried = false;
async function reconnect(): Promise<void> {
  const remembered = readSetting('monadb:wallet', '');
  if (reconnectTried || state.session || state.busy || !remembered || !NETWORK.deployment) return;
  const index = state.wallets.findIndex((w) => walletKey(w) === remembered);
  if (remembered !== BURNER && index === -1) return; // the extension may register later
  reconnectTried = true;
  state.busy = true;
  render();
  try {
    if (remembered === BURNER) {
      if (!NETWORK.burner) return;
      const burner = loadBurner(provider);
      state.burnerPersisted = burner.persisted;
      await adopt(burnerSession(burner.wallet));
    } else {
      const session = await connectWallet(state.wallets[index], NETWORK, {
        silent: true,
        onChange: (next, reason) => void switchAccount(next, reason),
      });
      if (session) await adopt(session);
    }
  } catch (err) {
    console.warn('Silent reconnect failed', err);
  } finally {
    state.busy = false;
    render();
  }
}

async function disconnect(): Promise<void> {
  const session = state.session;
  resetAccount();
  state.session = undefined;
  state.client = undefined;
  writeSetting('monadb:wallet', '');
  render();
  await session?.disconnect().catch((err) => console.warn('Wallet disconnect failed', err));
  toast('Disconnected.');
}

async function refreshBalance(): Promise<void> {
  const session = state.session;
  if (!session) return;
  try {
    const value = await provider.getBalance(session.address);
    if (state.session === session) state.balance = value;
  } catch (err) {
    console.warn('Could not read the balance', err);
  }
  render();
}

async function fund(): Promise<void> {
  const session = requireSession();
  if (!NETWORK.burner) throw new Error('Funding only exists on the localnet.');
  await fundOnLocalnet(provider, session.address, FUND_MON);
  await refreshBalance();
  toast(`The local node set this wallet to ${FUND_MON} test MON.`);
}

async function unlock(): Promise<void> {
  const client = requireClient();
  requireReady();
  if (!state.registered && state.balance === 0n) throw new Error(`This wallet has no MON on ${NETWORK.name}.${noMonHint()}`);
  // A signature (re-)derives the key; register publishes it, or rotates it if the one on-chain differs
  const hash = await client.register();
  if (!state.registered) toast(hash ? 'Encryption key registered on Monad.' : 'Your key was already registered.');
  else if (hash) toast('Your registered key was updated to match this wallet.');
  state.registered = true;
  state.unlocked = true;
  void refreshBalance();
  await refreshFiles();
  await resolveRequest();
}

function requireSession(): WalletSession {
  if (!state.session) throw new Error('Connect a wallet first.');
  return state.session;
}

function requireClient(): MonaDBClient {
  if (!state.client) throw new Error('Connect a wallet first.');
  return state.client;
}

// ── Upload ──────────────────────────────────────────────────────────────────

async function chooseFile(file: File | undefined): Promise<void> {
  state.file = file;
  state.quote = undefined;
  state.progress = [];
  render();
  if (!file || !state.client) return;
  if (file.size > MAX_FILE_BYTES) {
    toast(`This demo accepts files up to ${bytes(MAX_FILE_BYTES)}. Pick a smaller file.`, true);
    state.file = undefined;
    render();
    return;
  }
  await updateQuote();
}

const fileMime = (file: File) => file.type || 'application/octet-stream';

/** Copies worth paying for: direct chunks need that many nodes, ledger chunks that many active replicators */
function maxCopies(kind: 'direct' | 'ledger'): number {
  const available = kind === 'direct' ? state.nodesAlive : state.replicators.filter((r) => r.active).length;
  return available === undefined ? 5 : Math.max(1, Math.min(5, available));
}

function quoteOptions(file: File) {
  return { epochs: state.epochs, redundancy: state.redundancy, name: file.name, mime: fileMime(file) };
}

/** Ledger uploads above the demo limit can be quoted but not sent */
function uploadBlocker(file: File | undefined, quote: FileQuote | undefined): string {
  if (file && quote?.mode === 'ledger' && file.size > MAX_LEDGER_BYTES) {
    return `Ledger uploads are limited to ${bytes(MAX_LEDGER_BYTES)} in this demo. Choose a storage on the nodes, or a smaller file.`;
  }
  return '';
}

let quoteSeq = 0;
async function updateQuote(): Promise<void> {
  const client = state.client;
  const file = state.file;
  if (!client || !file) return;
  requireReady();
  const seq = ++quoteSeq;
  state.quoting = true;
  state.quoteError = '';
  render();
  try {
    // A fresh probe, so the quote and the upload see the same nodes (the SDK caches them for a minute)
    const nodes = (await client.directTargets(true)).length;
    state.nodesAlive = nodes;
    if ((state.mode === 'blob' || state.mode === 'direct') && nodes === 0) {
      throw new Error('No replicator node answers right now, so this storage cannot upload. Choose “Monad logs” or try again later.');
    }
    if (state.redundancy !== undefined) state.redundancy = Math.min(state.redundancy, Math.max(0, nodes - 1));
    // "auto" falls back to the ledger when no node answers
    const ledger = state.mode === 'ledger' || (state.mode === 'auto' && nodes === 0);
    state.replicas = Math.min(state.replicas, maxCopies(ledger ? 'ledger' : 'direct'));
    const quote = await client.quoteFile(file.size, state.replicas, state.mode, quoteOptions(file));
    if (seq !== quoteSeq) return;
    state.quote = quote;
  } catch (err) {
    if (seq !== quoteSeq) return;
    state.quote = undefined;
    state.quoteError = errorMessage(err);
  } finally {
    if (seq === quoteSeq) {
      state.quoting = false;
      render();
    }
  }
}

function setProgress(stage: string, text: string): void {
  const line = state.progress.find((p) => p.stage === stage);
  if (line) line.text = text;
  else state.progress = [...state.progress, { stage, text }];
  render();
}

async function upload(): Promise<void> {
  const client = requireClient();
  const session = requireSession();
  const file = state.file;
  if (!file) throw new Error('Choose a file first.');
  requireReady();
  if (state.quoteError) throw new Error(state.quoteError);
  const quote = state.quote ?? (await client.quoteFile(file.size, state.replicas, state.mode, quoteOptions(file)));
  const blocker = uploadBlocker(file, quote);
  if (blocker) throw new Error(blocker);
  await refreshBalance();
  // the wallet sends the fees (plus the session key's gas budget, returned at the end) and pays its own gas
  const needed = quote.value + quote.networkFee;
  if (state.balance !== undefined && state.balance < needed) {
    throw new Error(`This upload needs about ${mon(needed)} and the wallet holds ${mon(state.balance)}.${noMonHint()}`);
  }

  state.progress = [];
  setProgress('encrypt', 'Compressing and encrypting in your browser…');
  const generation = state.generation;
  const data = new Uint8Array(await file.arrayBuffer());
  const burner = session.kind === 'burner';
  const result = await client.uploadFile(data, {
    name: file.name,
    mime: fileMime(file),
    replicas: state.replicas,
    mode: quote.mode,
    epochs: state.epochs,
    redundancy: state.redundancy,
    onProgress: (p) => {
      if (p.stage === 'sign') {
        setProgress(
          'sign',
          burner
            ? `Signing ${plural(p.total, 'transaction')} with the burner key`
            : `Approve ${plural(p.total, 'transaction')} in your wallet: pay the storage, save the sealed record${quote.mode === 'ledger' ? ', fund a one-time session key' : ''}`,
        );
      }
      if (p.stage === 'open') setProgress('open', `Paid the storage and saved the record on Monad (${p.done}/${p.total})`);
      if (p.stage === 'segments') {
        setProgress('segments', `Wrote encrypted segments to Monad's logs (${p.done}/${p.total})${burner ? '' : ', signed by a one-time session key'}`);
      }
      if (p.stage === 'push') {
        setProgress('push', quote.mode === 'blob'
          ? `Sent erasure-coded shards to the nodes, one shard per node (${p.done}/${p.total})`
          : `Sent encrypted chunks straight to replicator nodes (${p.done}/${p.total})`);
      }
      if (p.stage === 'done') {
        setProgress(
          'done',
          quote.mode === 'blob'
            ? `Done. Any ${quote.layout?.k} of the ${(quote.layout?.k ?? 0) + (quote.layout?.m ?? 0)} nodes can rebuild your file; they prove it periodically to get paid.`
            : quote.mode === 'direct'
              ? 'Done. The nodes confirm on Monad and are paid from the escrow as they do.'
              : `Done. Replicators rebuild the chunks from Monad's logs next${burner ? '' : '; the session key sent its leftover MON back'}.`,
        );
      }
    },
  });

  toast(`Uploaded ${file.name}. Replicators are picking it up.`);
  if (generation !== state.generation) return; // the wallet switched accounts meanwhile
  state.file = undefined;
  state.quote = undefined;
  state.progress = [];
  const entry: FileEntry = { recordId: result.recordId, owner: session.address, shared: false, createdAt: Math.floor(Date.now() / 1000) };
  state.files.set(result.recordId, { entry });
  void refreshBalance();
  await loadFile(result.recordId);
  void watchUntilCool(result.recordId);
}

// ── Files ───────────────────────────────────────────────────────────────────

async function refreshFiles(): Promise<void> {
  const client = requireClient();
  const generation = state.generation;
  const entries = await client.listFiles();
  if (generation !== state.generation) return;

  // Owned beats shared when the same record shows up twice; drop anything that is not an id / address
  const fresh = new Map<string, FileEntry>();
  for (const entry of entries) {
    if (!isHex32(entry.recordId) || !isAddress(entry.owner)) continue;
    const seen = fresh.get(entry.recordId);
    if (!seen || (seen.shared && !entry.shared)) fresh.set(entry.recordId, entry);
  }
  for (const id of [...state.files.keys()]) if (!fresh.has(id)) state.files.delete(id);
  for (const [id, entry] of fresh) state.files.set(id, { ...state.files.get(id), entry });
  render();

  // A few at a time: public RPCs rate-limit bursts
  const ids = [...fresh.keys()];
  await Promise.all(
    Array.from({ length: Math.min(3, ids.length) }, async () => {
      for (let id = ids.shift(); id; id = ids.shift()) await loadFile(id);
    }),
  );
  for (const [id, view] of state.files) if (view.chunks && !isCool(view.chunks)) void watchUntilCool(id);
}

async function loadFile(recordId: string): Promise<void> {
  const client = state.client;
  const view = state.files.get(recordId);
  if (!client || !view) return;
  try {
    const status = await client.fileStatus(recordId);
    view.manifest = status.manifest;
    view.chunks = status.chunks;
    view.error = undefined;
  } catch (err) {
    view.error = errorMessage(err);
  }
  render();
}

/** Poll the chunks (or blobs) until every one is Cool (or closed) */
async function watchUntilCool(recordId: string): Promise<void> {
  if (state.watching.has(recordId)) return;
  state.watching.add(recordId);
  const generation = state.generation;
  try {
    for (let i = 0; i < 200; i++) {
      await sleep(3000);
      const client = state.client;
      const view = state.files.get(recordId);
      if (generation !== state.generation || !client || !view?.chunks) return;
      const chunks = await (view.manifest?.v === 3 ? client.fileStatus(recordId).then((s) => s.chunks) : client.chunkStatus(view.chunks.map((c) => c.id))).catch(
        () => undefined,
      );
      if (!chunks || generation !== state.generation) continue;
      view.chunks = chunks;
      render();
      if (isCool(chunks)) {
        toast(`${view.manifest ? displayName(view.manifest.name) : 'Your file'} is replicated.`);
        return;
      }
    }
  } finally {
    if (generation === state.generation) state.watching.delete(recordId);
  }
}

async function download(recordId: string): Promise<void> {
  state.downloading = recordId;
  render();
  try {
    const file = await requireClient().downloadFile(recordId);
    const name = safeFileName(file.name);
    const url = URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: safeMime(file.mime) }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast(`Downloaded ${name}, decrypted and verified.`);
  } finally {
    state.downloading = '';
  }
}

async function share(recordId: string, viewer: string): Promise<void> {
  const client = requireClient();
  if (!isAddress(viewer)) throw new Error('Enter a valid 0x address.');
  if (viewer.toLowerCase() === requireSession().address.toLowerCase()) throw new Error('That is your own wallet: you can already open this file.');
  if (!(await client.isRegistered(viewer))) {
    throw new Error(`${short(viewer)} has no MonaDB key yet. Ask them to open MonaDB and create one first.`);
  }
  await client.share(recordId, viewer);
  toast(`Shared with ${short(viewer)}. Send them the link: they open it with their own key.`);
  void refreshBalance();
  await loadViewers(recordId);
}

async function revoke(recordId: string, viewer: string): Promise<void> {
  if (!isAddress(viewer)) throw new Error('Not a valid 0x address.');
  await requireClient().revoke(recordId, viewer);
  toast(`Revoked ${short(viewer)}. A copy they already opened stays with them.`);
  void refreshBalance();
  await loadViewers(recordId);
}

async function loadViewers(recordId: string): Promise<void> {
  const client = state.client;
  const view = state.files.get(recordId);
  if (!client || !view || view.entry.shared) return;
  try {
    view.viewers = (await client.viewers(recordId)).filter((v) => isAddress(v));
  } catch (err) {
    console.warn('Could not list viewers', err);
    view.viewers ??= [];
  }
  render();
}

async function reclaim(recordId: string): Promise<void> {
  const view = state.files.get(recordId);
  const blob = view?.manifest?.v === 3;
  const { closed } = await requireClient().reclaimDeposits(recordId);
  if (closed === 0) {
    toast(
      blob
        ? 'Nothing to reclaim yet: prepaid storage closes one epoch after it ends, or 10 minutes after an upload no node took.'
        : `Nothing to reclaim yet. A chunk settles by itself once every replica confirmed it; unfilled copies come back after ${windowText()}.`,
    );
    return;
  }
  toast(`Closed ${plural(closed, blob ? 'blob' : 'chunk')}. The unspent escrow is back in your wallet; replicators keep the data.`);
  void refreshBalance();
  await loadFile(recordId);
}

async function extend(recordId: string): Promise<void> {
  const epochs = state.epochs;
  const days = state.config ? (Number(state.config.epochSeconds) * epochs) / 86_400 : undefined;
  await requireClient().extendFile(recordId, epochs);
  toast(`Prepaid ${plural(epochs, 'more epoch')}${days ? ` (about ${plural(Math.round(days), 'day')})` : ''}.`);
  void refreshBalance();
  await loadFile(recordId);
}

async function removeFile(recordId: string): Promise<void> {
  const view = state.files.get(recordId);
  const name = view?.manifest ? displayName(view.manifest.name) : 'this file';
  const unsettled = (view?.chunks ?? []).filter(
    (c) => c.state !== 'Closed' && c.state !== 'Pending' && c.confirmedReplicas < c.requiredReplicas,
  ).length;
  const warning = unsettled
    ? `\n\n${plural(unsettled, 'chunk')} still wait for replicas, so their escrow stays locked until they settle (Reclaim later).`
    : '';
  const ok = confirm(
    `Delete “${name}”?\n\nIn one transaction this revokes every grant, deletes the record and closes the settled chunks, returning their unspent escrow. ` +
      `Prepaid blob storage runs until it ends. Replicators may keep the encrypted copies they hold.${warning}`,
  );
  if (!ok) return;
  await requireClient().deleteFile(recordId);
  state.files.delete(recordId);
  toast(`Deleted ${name}.`);
  void refreshBalance();
}

// ── Links ───────────────────────────────────────────────────────────────────

function readLinkRequest(): void {
  const recordId = parseFileRef(location.hash) ?? parseFileRef(location.search);
  if (recordId && state.request?.recordId !== recordId) state.request = { recordId, status: 'waiting' };
}

/** Open the linked file: listed already, found by lookup, or tell who to ask for access */
async function resolveRequest(): Promise<void> {
  const request = state.request;
  const client = state.client;
  if (!request || !client || !state.unlocked) return;
  request.status = 'checking';
  render();
  try {
    if (!state.files.has(request.recordId)) {
      const found = await client.lookupFile(request.recordId);
      if (state.request !== request) return;
      if (found.status !== 'ok') {
        request.status = found.status;
        if (found.status === 'no-access') request.owner = found.owner;
        render();
        return;
      }
      state.files.set(found.entry.recordId, { entry: found.entry });
      void loadFile(found.entry.recordId);
    }
    state.request = undefined;
    focusFile(request.recordId);
  } catch (err) {
    request.status = 'error';
    request.error = errorMessage(err);
  }
  render();
}

function focusFile(recordId: string): void {
  state.highlight = recordId;
  render();
  requestAnimationFrame(() => document.querySelector(`li.file[data-id="${hex32(recordId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  setTimeout(() => {
    if (state.highlight !== recordId) return;
    state.highlight = '';
    render();
  }, 4000);
}

async function shareLink(recordId: string): Promise<void> {
  const view = state.files.get(recordId);
  const url = fileLink(recordId);
  if (!navigator.share) return copyText(url, 'Link');
  try {
    await navigator.share({ title: view?.manifest ? displayName(view.manifest.name) : 'MonaDB file', text: 'Open this file in MonaDB', url });
  } catch (err) {
    if ((err as Error).name !== 'AbortError') await copyText(url, 'Link');
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function render(): void {
  renderTopbar();
  renderNotice();
  renderRequest();
  renderIdentity();
  renderUpload();
  renderFiles();
  renderFooter();
}

function renderTopbar(): void {
  const network = $('network');
  if (network) {
    network.textContent = NETWORK.name;
    network.classList.toggle('is-live', state.ready === true);
  }
  const vaultNetwork = $('vault-network');
  if (vaultNetwork) vaultNetwork.textContent = NETWORK.name;
  const account = $<HTMLButtonElement>('account');
  if (account) {
    const session = state.session;
    account.textContent = session
      ? `${short(session.address)} · ${state.balance === undefined ? '…' : mon(state.balance)}`
      : 'Connect wallet';
    account.title = session ? 'Copy address' : '';
    account.disabled = state.busy && !session;
  }
}

function renderNotice(): void {
  const notice = $('notice');
  if (!notice) return;
  notice.hidden = !state.notice;
  if (!state.notice) return;
  setHtml(notice, `<span data-text="notice"></span>${state.notice.command ? ' <code data-text="command"></code>' : ''}`, (root) => {
    setText(root, '[data-text="notice"]', state.notice?.text ?? '');
    setText(root, '[data-text="command"]', state.notice?.command ?? '');
  });
}

function renderRequest(): void {
  const el = $('open-request');
  if (!el) return;
  const request = state.request;
  el.hidden = !request;
  if (!request) return;
  const me = addr(state.session?.address ?? '');
  const recheck = (label: string) =>
    `<button class="button button-quiet button-small" type="button" data-action="recheck" ${state.busy ? 'disabled' : ''}>${label}</button>`;
  const body = {
    waiting: `<p>${state.session ? 'Unlock your key below' : 'Connect your wallet and unlock your key below'} to open it. Only the owner and the wallets they gave access to can decrypt it.</p>`,
    checking: '<p class="muted">Checking your access…</p>',
    missing: `<p>There is no MonaDB file with this id on ${esc(NETWORK.name)}. It may have been deleted, or the link is for another network.</p>`,
    'no-access': `<p>This file belongs to ${accountLink(request.owner ?? '')}. Your wallet has no access yet: send the owner your address so they can share it with you, then check again.</p>
      <div class="row copy-field">
        <input readonly value="${me}" aria-label="Your wallet address" />
        <button class="button button-small" type="button" data-action="copy" data-copy="${me}" data-what="Your address">Copy my address</button>
      </div>
      ${recheck('Check again')}`,
    error: `<p data-text="request-error"></p>${recheck('Try again')}`,
  }[request.status];
  setHtml(
    el,
    `<p class="request-title">Shared file ${idLabel(request.recordId)}</p>${body}
     <button class="button button-quiet button-small" type="button" data-action="dismiss-request">Dismiss</button>`,
    (root) => setText(root, '[data-text="request-error"]', request.error ?? ''),
  );
}

function renderIdentity(): void {
  const el = $('identity');
  if (!el) return;
  const disabled = state.busy ? 'disabled' : '';
  const session = state.session;

  if (!session) {
    const blocked = !NETWORK.deployment || Boolean(NETWORK.problem);
    const wallets = state.wallets
      .map(
        (_, i) =>
          `<button class="wallet-option" type="button" data-action="connect" data-wallet="${i}" ${disabled || (blocked ? 'disabled' : '')}>
            <img class="wallet-icon" data-wallet-icon="${i}" alt="" hidden /><span data-wallet-name="${i}"></span>
          </button>`,
      )
      .join('');
    const burner = NETWORK.burner
      ? `<button class="wallet-option wallet-burner" type="button" data-action="connect" data-wallet="${BURNER}" ${disabled || (blocked ? 'disabled' : '')}>
          <span class="wallet-icon wallet-icon-burner" aria-hidden="true"></span><span>Burner wallet (test only)</span>
        </button>`
      : '';
    setHtml(
      el,
      `
      <p class="muted">Connect a wallet on ${esc(NETWORK.name)} (MetaMask, Rabby, Phantom, Backpack…). You need a little MON for the storage fee and the gas.</p>
      <div class="wallets" id="wallet-picker">${wallets}${burner}</div>
      ${state.wallets.length === 0 ? '<p class="muted small">No browser wallet found. Install MetaMask, Rabby or another EVM wallet and reload.</p>' : ''}
      ${NETWORK.burner ? '<p class="muted small">The burner wallet keeps a throwaway key in this browser’s storage, so anyone using this browser can spend from it. Test MON only.</p>' : ''}`,
      (root) => {
        state.wallets.forEach((wallet, i) => {
          setText(root, `[data-wallet-name="${i}"]`, wallet.name);
          const img = root.querySelector<HTMLImageElement>(`[data-wallet-icon="${i}"]`);
          const icon = safeIcon(wallet);
          if (img && icon && img.getAttribute('src') !== icon) img.src = icon;
          if (img) img.hidden = !icon;
        });
      },
    );
    return;
  }

  const walletLine = `
    <div class="wallet-line">
      <span class="wallet-name" data-text="wallet"></span>
      ${accountLink(session.address, short(session.address))}
      <span class="muted">${state.balance === undefined ? '…' : esc(mon(state.balance))}</span>
      <span class="wallet-actions">
        ${session.kind === 'burner' && NETWORK.burner ? `<button class="button button-quiet button-small" type="button" data-action="fund" ${disabled}>Fund ${FUND_MON} MON</button>` : ''}
        ${NETWORK.faucet && state.balance === 0n ? link(NETWORK.faucet, 'Get test MON', 'button button-quiet button-small') : ''}
        <button class="button button-quiet button-small" type="button" data-action="disconnect" ${disabled}>Disconnect</button>
      </span>
    </div>
    ${
      session.kind === 'burner'
        ? `<p class="muted small">Burner wallet: its key lives in this browser’s storage. Use it on ${esc(NETWORK.name)} with test MON only.${
            state.burnerPersisted ? '' : ' Storage is blocked here, so this burner disappears when you close the tab.'
          }</p>`
        : ''
    }`;
  const fill = (root: HTMLElement) => setText(root, '[data-text="wallet"]', session.kind === 'burner' ? 'Burner wallet' : session.name);

  if (state.unlocked) {
    setHtml(el, `${walletLine}<p>Your encryption key is registered and unlocked for this visit. Files are encrypted before they leave this tab.</p>`, fill);
    return;
  }
  const warning = `<p class="warning">Only sign the “MonaDB encryption key” message inside MonaDB apps: whoever gets that signature can decrypt your files.</p>`;
  setHtml(
    el,
    walletLine +
      (state.registered
        ? `<p class="muted">Sign one message to unlock your key. It costs nothing, sends no transaction, and the key never leaves this tab.</p>
           <button class="button" type="button" data-action="unlock" ${disabled}>Unlock my files</button>${warning}`
        : `<p class="muted">Your wallet signs one message to create your encryption key (always the same key for this wallet), then publishes
             its public half on Monad in one transaction (a little gas, no deposit).</p>
           <button class="button" type="button" data-action="unlock" ${disabled}>Create my encryption key</button>${warning}`),
    fill,
  );
}

function renderUpload(): void {
  const el = $('upload');
  if (!el) return;
  $('step-upload')?.classList.toggle('is-locked', !state.unlocked);
  if (!state.unlocked) {
    setHtml(el, `<p class="muted">Unlock your key first.</p>`);
    return;
  }
  const disabled = state.busy ? 'disabled' : '';
  const file = state.file;
  const quote = state.quote;
  // the mode the quote resolved to ("auto" → blob, or ledger without nodes)
  const resolved = quote?.mode ?? (state.mode === 'auto' ? undefined : state.mode);
  const nodes = state.nodesAlive;
  const active = state.replicators.filter((r) => r.active).length;
  const modes: [UploadMode, string][] = [
    ['auto', 'Automatic'],
    ['blob', 'Nodes, erasure coded (cheapest)'],
    ['direct', 'Nodes, full copies'],
    ['ledger', 'Monad logs (ledger)'],
  ];
  const epochSeconds = state.config ? Number(state.config.epochSeconds) : 30 * 86_400;
  const durations = [1, 3, 6, 12, 24].map((n) => [n, n * epochSeconds] as const);
  // test networks may run epochs of minutes: never round a duration down to "0 days"
  const durationLabel = (seconds: number) => {
    const days = seconds / 86_400;
    if (days >= 365) return `${+(days / 365).toFixed(1)} yr`;
    if (days >= 28) return `${Math.round(days / 30)} mo`;
    if (days >= 1) return plural(+days.toFixed(1), 'day');
    if (seconds >= 3600) return plural(+(seconds / 3600).toFixed(1), 'hour');
    return plural(Math.max(1, Math.round(seconds / 60)), 'minute');
  };
  const protocolPct = state.config ? state.config.protocolFeeBps / 100 : undefined;
  const burner = state.session?.kind === 'burner';
  const blocker = uploadBlocker(file, quote);

  const modeHint = !quote
    ? ''
    : quote.mode === 'blob'
      ? `Split into ${(quote.layout?.k ?? 0) + (quote.layout?.m ?? 0)} shards, one per node; any ${quote.layout?.k} rebuild it. Monad keeps one root, the payment and who can read it.`
      : quote.mode === 'direct'
        ? 'Whole encrypted chunks go straight to the nodes, one full copy each; Monad keeps the hash, the payment and who can read it.'
        : 'Chunks are written to Monad’s event logs in 48 KiB segments, readable before any node has copied them.';

  let durability = '';
  if (resolved === 'blob') {
    // m parity shards; k = min(10, nodes − m) data shards (the SDK's chooseLayout)
    const parity = nodes ? Array.from({ length: Math.min(nodes, 11) }, (_, m) => m).filter((m) => nodes - m >= 1) : [];
    const code = (m: number) => `${Math.min(10, (nodes ?? 1) - m)}+${m}`;
    const automatic = quote?.layout && state.redundancy === undefined ? ` (${quote.layout.k}+${quote.layout.m})` : '';
    durability = `
      <label for="redundancy">Redundancy</label>
      <select id="redundancy" ${disabled}>
        <option value="auto" ${state.redundancy === undefined ? 'selected' : ''}>Automatic${automatic}</option>
        ${parity
          .map(
            (m) =>
              `<option value="${m}" ${m === state.redundancy ? 'selected' : ''}>${code(m)}: ${m === 0 ? 'no spare shards' : `survives ${plural(m, 'lost node')}`}</option>`,
          )
          .join('')}
      </select>
      <span class="muted small hint">${plural(nodes ?? 0, 'node')} answering on ${esc(NETWORK.name)}; one shard per node.</span>
      <label for="epochs">Keep for</label>
      <select id="epochs" ${disabled}>
        ${durations.map(([n, days]) => `<option value="${n}" ${n === state.epochs ? 'selected' : ''}>${durationLabel(days)}</option>`).join('')}
      </select>
      <span class="muted small hint">Prepaid; extend it any time before it ends.</span>`;
  } else if (resolved) {
    const max = maxCopies(resolved === 'ledger' ? 'ledger' : 'direct');
    durability = `
      <label for="replicas">Copies</label>
      <select id="replicas" ${disabled}>
        ${Array.from({ length: max }, (_, i) => i + 1)
          .map((n) => `<option value="${n}" ${n === state.replicas ? 'selected' : ''}>${plural(n, 'replica')}</option>`)
          .join('')}
      </select>
      <span class="muted small hint">${
        resolved === 'direct'
          ? `${plural(nodes ?? 0, 'node')} answering on ${esc(NETWORK.name)}: at most one copy per node.`
          : `${plural(active, 'active replicator')} on ${esc(NETWORK.name)} rebuild it from the logs.`
      }</span>`;
  }

  const units = quote?.mode === 'blob' ? 'blob' : 'encrypted chunk';
  const chunks = file ? (quote?.chunks ?? Math.max(1, Math.ceil(file.size / CHUNK_BYTES))) : 0;

  setHtml(
    el,
    `
    <label class="dropzone" id="dropzone">
      <input type="file" id="file-input" ${disabled} />
      <span>${
        file
          ? `<strong data-text="file-name"></strong><br />${esc(bytes(file.size))}${quote ? ` in ${plural(chunks, units)}` : ''}`
          : `Drop a file here or choose one (up to ${esc(bytes(MAX_FILE_BYTES))}, ${esc(bytes(MAX_LEDGER_BYTES))} on the ledger)`
      }</span>
    </label>
    <div class="options">
      <label for="mode">Storage</label>
      <select id="mode" ${disabled}>
        ${modes.map(([value, label]) => `<option value="${value}" ${value === state.mode ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      ${modeHint ? `<span class="muted small hint">${modeHint}</span>` : ''}
      ${durability}
    </div>
    ${state.quoteError ? '<p class="quote-error" data-text="quote-error"></p>' : ''}
    ${
      quote
        ? `<dl class="quote${state.quoting ? ' is-stale' : ''}" aria-busy="${state.quoting}">
            <dt>${quote.mode === 'blob' ? 'Storage fee' : 'Upload fee'}</dt><dd>${esc(mon(quote.uploadFee))}${protocolPct !== undefined ? ` <span class="muted">(${protocolPct}% protocol, the rest pays the ${quote.mode === 'blob' ? 'shard holders as they prove they keep it' : 'replicas'})</span>` : ''}</dd>
            <dt>Network fee</dt><dd>${esc(mon(quote.networkFee))} <span class="muted">(${esc(quote.gas.toLocaleString('en-US'))} gas × ${esc(gwei(quote.gasPrice))}; Monad charges the gas limit)</span></dd>
            <dt class="quote-total">Total</dt><dd class="quote-total">${esc(mon(quote.total))} <span class="muted">(at most: compressible files cost less; nothing comes back later)</span></dd>
            <dt>Transactions</dt><dd>${burner ? 'no prompts' : 'one wallet prompt'}${
              quote.mode !== 'ledger'
                ? ', no bytes on chain'
                : `, then ${plural(quote.segments, 'segment write')} to the logs${burner ? '' : ' by a one-time session key'}`
            }</dd>          </dl>`
        : file && state.quoting
          ? '<p class="muted">Working out the cost…</p>'
          : ''
    }
    ${blocker ? '<p class="quote-error" data-text="blocker"></p>' : ''}
    <button class="button" type="button" data-action="upload" ${!file || !quote || state.quoting || blocker || state.busy ? 'disabled' : ''}>Encrypt and upload</button>
    ${state.progress.length ? `<ol class="progress">${state.progress.map((p) => `<li>${esc(p.text)}</li>`).join('')}</ol>` : ''}`,
    (root) => {
      setText(root, '[data-text="file-name"]', file?.name ?? '');
      setText(root, '[data-text="quote-error"]', state.quoteError);
      setText(root, '[data-text="blocker"]', blocker);
    },
  );
}

function renderFiles(): void {
  const el = $('files');
  if (!el) return;
  $('step-files')?.classList.toggle('is-locked', !state.unlocked);
  if (!state.unlocked) {
    setHtml(el, `<p class="muted">Your files and the ones shared with you show up here.</p>`);
    return;
  }
  const files = [...state.files.values()].sort((a, b) => b.entry.createdAt - a.entry.createdAt);
  const openForm = `
    <form class="row open-form" id="open-form">
      <input name="ref" placeholder="Paste a MonaDB link or file id (0x…)" spellcheck="false" autocomplete="off" aria-label="MonaDB link or file id" />
      <button class="button button-quiet button-small" type="submit">Open</button>
    </form>`;
  if (files.length === 0) {
    setHtml(
      el,
      `<p class="muted">No files yet. Upload one above, or ask someone to share a file with ${esc(short(state.session?.address ?? ''))}.</p>
      <button class="button button-quiet button-small" type="button" data-action="refresh" ${state.busy ? 'disabled' : ''}>Check again</button>
      ${openForm}`,
    );
    return;
  }

  // Keyed, in-place updates: status polling must not reset a half-typed share address
  if (!el.querySelector('ul.file-list')) {
    setHtml(el, `<ul class="file-list"></ul><button class="button button-quiet button-small" type="button" data-action="refresh">Refresh</button>${openForm}`);
  }
  const list = el.querySelector<HTMLUListElement>('ul.file-list');
  if (!list) return;
  const items = new Map<string, HTMLLIElement>();
  for (const li of [...list.children] as HTMLLIElement[]) {
    if (state.files.has(li.dataset.id ?? '')) items.set(li.dataset.id!, li);
    else li.remove();
  }
  files.forEach((view, index) => {
    const li = items.get(view.entry.recordId) ?? createFileItem(view);
    if (list.children[index] !== li) list.insertBefore(li, list.children[index] ?? null);
    updateFileItem(li, view);
  });
  for (const control of el.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) {
    if (!control.dataset.action || control.dataset.action === 'refresh') control.disabled = state.busy;
  }
}

function createFileItem(view: FileView): HTMLLIElement {
  const { entry } = view;
  const li = document.createElement('li');
  li.className = 'file';
  li.dataset.id = entry.recordId;
  const id = hex32(entry.recordId);
  const url = esc(fileLink(id));
  li.innerHTML = `
    <div class="file-head">
      <span class="file-name"></span>
      <span class="file-meta"></span>
    </div>
    <div class="file-status"></div>
    <div class="row">
      <button class="button button-small" type="button" data-action="download">Download</button>
      ${
        entry.shared
          ? ''
          : `<details class="share">
              <summary class="button button-quiet button-small">Share</summary>
              <div class="share-panel">
                <p class="share-step">1. Give their wallet access</p>
                <form class="row share-form">
                  <input name="viewer" placeholder="0x address of a registered wallet" spellcheck="false" autocomplete="off" aria-label="Address to share with" />
                  <button class="button button-small" type="submit">Give access</button>
                </form>
                <p class="muted small">Sharing seals the file key to their published key. Revoking stops access through MonaDB, but cannot take back a copy they already opened.</p>
                <ul class="viewers"></ul>
                <p class="share-step">2. Send them the link</p>
                <div class="row copy-field">
                  <input readonly value="${url}" aria-label="Link to this file" data-action="select" />
                  <button class="button button-small" type="button" data-action="copy" data-copy="${url}" data-what="Link">Copy link</button>
                  ${'share' in navigator ? '<button class="button button-quiet button-small" type="button" data-action="share-link">Share…</button>' : ''}
                </div>
                <p class="muted small">The link opens this file for the wallets you gave access to. Anyone else sees whose file it is and can send you their address.</p>
              </div>
            </details>`
      }
      <button class="button button-quiet button-small" type="button" data-action="copy" data-copy="${url}" data-what="Link">Copy link</button>
      ${
        entry.shared
          ? ''
          : `<button class="button button-quiet button-small" type="button" data-action="extend" hidden>Extend storage</button>
            <button class="button button-quiet button-small" type="button" data-action="reclaim">Reclaim escrow</button>
            <button class="button button-quiet button-small button-danger" type="button" data-action="delete">Delete</button>`
      }
      <span class="file-meta">Record ${idLabel(id)}<button class="icon-button" type="button" data-action="copy" data-copy="${id}" data-what="File id" title="Copy the file id" aria-label="Copy the file id">${COPY_ICON}</button></span>
    </div>
    <details class="chunks">
      <summary>Chunks and replicas</summary>
      <ol class="chunk-list"></ol>
    </details>`;
  return li;
}

const STATE_LABEL: Record<ChunkStatus['state'], string> = {
  Pending: 'Writing',
  Hot: 'Hot',
  Cool: 'Cool',
  Closed: 'Settled and closed',
};

function fileStatusText(chunks: ChunkStatus[] | undefined): string {
  if (!chunks) return '';
  if (chunks.every((c) => c.state === 'Closed')) return 'Settled';
  if (isCool(chunks)) return 'Replicated';
  if (chunks.some((c) => c.state === 'Pending')) return 'Writing';
  return 'Waiting for replicas';
}

function updateFileItem(li: HTMLLIElement, view: FileView): void {
  const { entry, manifest, chunks } = view;
  li.classList.toggle('is-highlight', state.highlight === entry.recordId);
  const status = fileStatusText(chunks);
  const origin = entry.shared ? `Shared by ${short(entry.owner)}` : 'Yours';

  setText(li, '.file-name', manifest ? displayName(manifest.name) : view.error ? 'Unreadable file' : 'Decrypting…');
  setText(li, '.file-head .file-meta', [manifest ? bytes(manifest.size) : '', origin, status].filter(Boolean).join(' · '));

  const holder = li.querySelector<HTMLElement>('.file-status');
  if (holder) {
    setHtml(
      holder,
      view.error
        ? `<p class="muted" data-text="error"></p>`
        : `<div class="strip" role="img" aria-label="${esc(status)}">${(chunks ?? [])
            .map(
              (c) =>
                `<span class="cell ${c.state === 'Cool' ? 'is-cool' : c.state === 'Closed' ? 'is-closed' : c.state === 'Pending' ? 'is-pending' : ''}" data-replicas="${c.confirmedReplicas}/${c.requiredReplicas}" title="${esc(STATE_LABEL[c.state])}: ${c.confirmedReplicas} of ${c.requiredReplicas} replicas"></span>`,
            )
            .join('')}</div>`,
      (root) => setText(root, '[data-text="error"]', view.error ?? ''),
    );
  }

  const chunkList = li.querySelector<HTMLElement>('.chunk-list');
  if (chunkList) {
    setHtml(
      chunkList,
      (chunks ?? [])
        .map(
          (c, i) => `
          <li>
            <span class="chunk-state">#${i + 1} ${esc(STATE_LABEL[c.state])}</span>
            ${c.state === 'Closed' ? '' : `<span class="muted">${c.confirmedReplicas} of ${c.requiredReplicas} replicas</span>`}
            ${idLabel(c.id)}
            ${c.replicators.length ? `<span class="muted">kept by</span> ${c.replicators.map((r) => accountLink(r)).join(' ')}` : ''}
          </li>`,
        )
        .join('') || '<li class="muted">Loading…</li>',
    );
  }

  const viewers = li.querySelector<HTMLElement>('.viewers');
  if (viewers) {
    setHtml(
      viewers,
      view.viewers === undefined
        ? ''
        : view.viewers.length === 0
          ? '<li class="muted small">Nobody else has access yet.</li>'
          : view.viewers
              .map(
                (v) =>
                  `<li>${accountLink(v)}<button class="button button-quiet button-small" type="button" data-action="revoke" data-viewer="${addr(v)}">Revoke</button></li>`,
              )
              .join(''),
    );
  }

  const downloadButton = li.querySelector<HTMLButtonElement>('[data-action="download"]');
  if (downloadButton) {
    downloadButton.disabled = state.busy || !manifest;
    downloadButton.textContent = state.downloading === entry.recordId ? 'Downloading…' : 'Download';
  }
  const reclaimButton = li.querySelector<HTMLButtonElement>('[data-action="reclaim"]');
  if (reclaimButton) reclaimButton.disabled = state.busy || !chunks || chunks.every((c) => c.state === 'Closed');
  const extendButton = li.querySelector<HTMLButtonElement>('[data-action="extend"]');
  if (extendButton) {
    // prepaid storage: blob files only, while it lasts
    extendButton.hidden = manifest?.v !== 3 || !chunks || chunks.every((c) => c.state === 'Closed');
    extendButton.disabled = state.busy;
    extendButton.textContent = `Extend ${plural(state.epochs, 'epoch')}`;
  }
  for (const button of li.querySelectorAll<HTMLButtonElement>('[data-action="delete"], [data-action="revoke"]')) {
    button.disabled = state.busy;
  }
}

function renderFooter(): void {
  const input = $<HTMLInputElement>('node-url');
  if (input && document.activeElement !== input) input.value = state.nodeUrl;

  const contracts = $('contracts');
  if (contracts) {
    const contract = NETWORK.deployment?.contract ?? '';
    setHtml(
      contracts,
      contract
        ? `MonaDB contract ${accountLink(contract, contract)} on ${esc(NETWORK.name)} (chain ${NETWORK.chainId})`
        : `MonaDB is not deployed on ${esc(NETWORK.name)} yet.`,
    );
  }

  const details = $('replicators');
  const list = $('replicator-list');
  if (details && list) {
    details.hidden = state.replicators.length === 0;
    const summary = details.querySelector('summary');
    const active = state.replicators.filter((r) => r.active).length;
    if (summary) summary.textContent = `${plural(state.replicators.length, 'replicator node')} (${active} active)`;
    setHtml(
      list,
      state.replicators
        .map(
          (r, i) => `
          <li>
            ${accountLink(r.authority)}
            <span class="hex endpoint" data-endpoint="${i}"></span>
            <span class="${r.active ? 'badge is-live' : 'badge'}">${r.active ? 'active' : 'inactive'}</span>
            <span class="muted">${esc(plural(Number(r.confirmations), 'confirmation'))}</span>
          </li>`,
        )
        .join(''),
      (root) => state.replicators.forEach((r, i) => setText(root, `[data-endpoint="${i}"]`, r.endpoint)),
    );
  }
}

// ── Events ──────────────────────────────────────────────────────────────────

function fileId(target: HTMLElement): string {
  return target.closest<HTMLElement>('li.file')?.dataset.id ?? '';
}

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const target = event.target.closest<HTMLElement>('[data-action]');
  if (!target || (target as HTMLButtonElement).disabled) return;
  const action = target.dataset.action;
  if (action === 'connect') void run(() => connect(target.dataset.wallet ?? ''));
  if (action === 'disconnect') void run(disconnect);
  if (action === 'fund') void run(fund);
  if (action === 'unlock') void run(unlock);
  if (action === 'upload') void run(upload);
  if (action === 'refresh') void run(refreshFiles);
  if (action === 'download') void run(() => download(fileId(target)));
  if (action === 'reclaim') void run(() => reclaim(fileId(target)));
  if (action === 'extend') void run(() => extend(fileId(target)));
  if (action === 'delete') void run(() => removeFile(fileId(target)));
  if (action === 'revoke') void run(() => revoke(fileId(target), target.dataset.viewer ?? ''));
  if (action === 'copy') void copyText(target.dataset.copy ?? '', target.dataset.what ?? 'Text');
  if (action === 'select') (target as HTMLInputElement).select();
  if (action === 'share-link') void shareLink(fileId(target));
  if (action === 'recheck') void run(resolveRequest);
  if (action === 'dismiss-request') {
    state.request = undefined;
    if (parseFileRef(location.hash)) history.replaceState(null, '', location.pathname + location.search);
    render();
  }
});

$('account')?.addEventListener('click', () => {
  const session = state.session;
  if (!session) {
    $('step-identity')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.querySelector<HTMLButtonElement>('#wallet-picker button:not(:disabled)')?.focus({ preventScroll: true });
    return;
  }
  navigator.clipboard
    ?.writeText(session.address)
    .then(() => toast('Address copied.'))
    .catch(() => toast(session.address));
});

document.addEventListener('change', (event) => {
  const target = event.target as HTMLElement;
  if (target.id === 'file-input') void run(() => chooseFile((target as HTMLInputElement).files?.[0]));
  if (target.id === 'replicas') {
    state.replicas = Number((target as HTMLSelectElement).value) || 1;
    void run(updateQuote);
  }
  if (target.id === 'mode') {
    state.mode = (target as HTMLSelectElement).value as UploadMode;
    void run(updateQuote);
  }
  if (target.id === 'epochs') {
    state.epochs = Number((target as HTMLSelectElement).value) || 12;
    void run(updateQuote);
  }
  if (target.id === 'redundancy') {
    const value = (target as HTMLSelectElement).value;
    state.redundancy = value === 'auto' ? undefined : Number(value);
    void run(updateQuote);
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target as HTMLFormElement;
  if (form.id === 'open-form') {
    event.preventDefault();
    const recordId = parseFileRef(String(new FormData(form).get('ref') ?? ''));
    if (!recordId) {
      toast('Paste a MonaDB link (…#file=0x…) or a file id.', true);
      return;
    }
    state.request = { recordId, status: 'waiting' };
    form.reset();
    void run(resolveRequest);
    return;
  }
  if (form.classList.contains('share-form')) {
    event.preventDefault();
    const viewer = String(new FormData(form).get('viewer') ?? '').trim();
    void run(async () => {
      await share(fileId(form), viewer);
      form.reset();
    });
  }
});

// <details> toggle does not bubble: listen in the capture phase
document.addEventListener(
  'toggle',
  (event) => {
    const details = event.target as HTMLDetailsElement;
    if (details.classList?.contains('share') && details.open) void loadViewers(fileId(details));
  },
  true,
);

$('node-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = ($<HTMLInputElement>('node-url')?.value ?? '').trim().replace(/\/$/, '');
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) {
    toast('Enter an http(s) URL, or leave it empty.', true);
    return;
  }
  state.nodeUrl = url;
  writeSetting('monadb:node', url);
  state.client?.setNodeUrls(nodeUrls());
  toast(url ? `Downloads try ${url} first.` : 'Downloads use the replicators recorded on-chain.');
});

for (const type of ['dragover', 'dragleave', 'drop'] as const) {
  document.addEventListener(type, (event) => {
    const zone = (event.target as HTMLElement).closest?.('#dropzone');
    if (!zone) return;
    event.preventDefault();
    zone.classList.toggle('is-over', type === 'dragover');
    if (type === 'drop' && !state.busy) void run(() => chooseFile((event as DragEvent).dataTransfer?.files?.[0]));
  });
}

// Leaving mid-upload strands the session key's small balance and half-written chunks
window.addEventListener('beforeunload', (event) => {
  if (state.busy && state.progress.length > 0) event.preventDefault();
});

window.addEventListener('hashchange', () => {
  const before = state.request;
  readLinkRequest();
  if (state.request !== before) {
    render();
    void run(resolveRequest);
    $('vault')?.scrollIntoView({ behavior: 'smooth' });
  }
});

// ── Landing art ─────────────────────────────────────────────────────────────

const ART: Record<string, () => string> = {
  skyline: skylineSvg,
  sun: sunSvg,
  cloud: cloudSvg,
  plane: planeSvg,
  balloon: balloonSvg,
  'step-wallet': stepWalletSvg,
  'step-upload': stepUploadSvg,
  'step-share': stepShareSvg,
};

function drawArt(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-art]')) el.innerHTML = ART[el.dataset.art ?? '']?.() ?? '';
}

/** Sections fade in from a blur the first time they scroll into view */
function revealOnScroll(): void {
  const targets = [...document.querySelectorAll<HTMLElement>('[data-reveal]')];
  if (!('IntersectionObserver' in window)) {
    for (const target of targets) target.classList.add('is-visible');
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.12 },
  );
  for (const target of targets) observer.observe(target);
}

// ── Start ───────────────────────────────────────────────────────────────────

drawArt();
revealOnScroll();
readLinkRequest();
if (state.request) requestAnimationFrame(() => $('vault')?.scrollIntoView());

watchWallets((wallets) => {
  state.wallets = wallets;
  render();
  void reconnect();
});
render();
void checkNetwork().then(reconnect);
