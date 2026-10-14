import { Contract, getAddress, getBytes, hexlify, isAddress, Provider, randomBytes, Signer, Wallet, ZeroAddress } from 'ethers';
import {
  Address,
  BlobAccount,
  ChunkAccount,
  ChunkState,
  ConfigAccount,
  decodeBlob,
  decodeChunk,
  decodeConfig,
  decodeGrant,
  decodeIdentity,
  decodeRecord,
  decodeReplicator,
  GrantAccount,
  Hex32,
  IdentityAccount,
  ids,
  isBlobClosable,
  isClosable,
  isHex32,
  MAX_DIRECT_CHUNK_SIZE,
  MAX_RECORD_CONTENT,
  MAX_SEGMENT_SIZE,
  MONADB_ABI,
  monadbInterface,
  quoteBlob,
  quoteChunk,
  quoteExtension,
  RecordAccount,
  ReplicatorAccount,
  sameAddress,
  VACANT,
} from './contract';
import {
  decryptBytes,
  deriveEncryptionKeyPair,
  ENCRYPTION_OVERHEAD,
  EncryptionKeyPair,
  encryptBytes,
  open,
  randomKey,
  seal,
  SEAL_OVERHEAD,
  sha256,
  SignMessage,
} from './crypto';
import { BundleEntry, BundleFile, chooseLayout, decodeBundle, decodeStripe, encodeBlobs, encodeBundle, stripePlainLengths } from './blob-layout';
import { BLOB_FILE_SCHEMA, BlobManifest, decodeBlobManifest, encodeBlobManifest, isBlobManifest } from './blob-manifest';
import { gunzip, maybeCompress } from './compression';
import { readChunkFromLedger } from './ledger';
import { blobRoot, depth, verifyFragment } from './merkle';
import { decodeIndex, decodeManifest, encodeIndex, encodeManifest, FILE_SCHEMA, FileManifest, fromHex, manifestTextBytes, toHex } from './manifest';
import { createMonadProvider } from './provider';
import { MonaDBTransactionError, TransactionSender, TxRequest, TxResult } from './transactions';

/** Shape of deployments/monad-<network>.json (the fields the SDK reads) */
export interface MonaDBDeployment {
  network: string;
  chainId: number;
  rpcUrl: string;
  /** MonaDB contract address */
  contract: string;
  /** Block of the deployment, informative */
  deployBlock?: number;
  /** Public replicator endpoints, if the deployment advertises any */
  nodes?: string[];
}

export interface MonaDBClientOptions {
  /** The user's wallet: an ethers Signer (Wallet, BrowserProvider signer…) */
  signer: Signer;
  /** Read provider or RPC URL (defaults to deployment.rpcUrl) */
  provider?: Provider | string;
  /** Signs the key-derivation message (default: signer.signMessage) */
  signMessage?: SignMessage;
  deployment?: MonaDBDeployment;
  /** Contract address (defaults to deployment.contract) */
  contract?: string;
  /** Chain id for an RPC URL (defaults to deployment.chainId) */
  chainId?: number;
  /** Replicator HTTP endpoints tried first */
  nodeUrls?: string[];
  /** Where the encrypted bytes go (default "auto"):
   *  - "blob": Reed-Solomon shards, one per replicator node, one entry per
   *    blob, storage prepaid per epoch and checked with storage proofs
   *    (docs/blob-protocol.md).  The cheapest and most durable path.
   *  - "direct": whole chunks straight to replicator nodes (one full copy per
   *    replica).
   *  - "ledger": written to Monad's event logs in segments, so replicators and
   *    readers can rebuild them without trusting anyone.
   *  - "auto": blob when a replicator node answers, else ledger. */
  mode?: UploadMode;
  /** Blob storage prepaid, in epochs of the contract's `epochSeconds` (default 12) */
  epochs?: number;
  /** Blob parity shards = node losses tolerated (default: by node count, e.g. 10+4 with 14 nodes) */
  redundancy?: number;
  /** Bytes per ledger chunk (default 1 MiB, at most 4 MiB) */
  chunkSize?: number;
  /** Bytes per ledger segment transaction (default 48 KiB, at most 96 KiB) */
  segmentSize?: number;
  /** Bytes per direct chunk (default 8 MiB, at most ~16 MiB) */
  directChunkSize?: number;
  /** gzip the file before encryption when it saves ≥ 10 % (default true) */
  compress?: boolean;
  /** Custom delivery of direct chunks (tests, gateways) instead of HTTP PUT to the nodes */
  pushChunk?: (chunk: ChunkRef, data: Uint8Array) => Promise<void>;
  /** Replicas requested per chunk (default 1) */
  replicas?: number;
  /** Write ledger segments with a throwaway session key funded in the upload
   *  transaction, so the wallet signs once per upload (default true) */
  sessionWriter?: boolean;
  /** Margin over eth_estimateGas, in % (default 10).  Monad charges the gas limit. */
  gasBufferPct?: number;
  /** Segment transactions in flight at once (default 8) */
  concurrency?: number;
  /** Rebuild chunks from the logs when no replicator has them (default true) */
  ledgerFallback?: boolean;
  /** Custom chunk source (tests, gateways) tried before the replicators */
  fetchChunk?: (chunk: ChunkRef) => Promise<Uint8Array>;
  /** Give up on a replicator after this long (default 30 s) */
  nodeTimeoutMs?: number;
}

export interface ChunkRef {
  /** keccak256("chunk", owner, contentHash) */
  id: Hex32;
  owner: Address;
  contentHash: Uint8Array;
}

export type UploadMode = 'blob' | 'direct' | 'ledger' | 'auto';
export type ResolvedMode = 'blob' | 'direct' | 'ledger';
export type AnyManifest = FileManifest | BlobManifest;

export interface UploadOptions {
  name: string;
  mime?: string;
  replicas?: number;
  /** Overrides the client's mode for this file */
  mode?: UploadMode;
  /** Overrides the client's compress setting for this file */
  compress?: boolean;
  /** Blob storage prepaid, in epochs (overrides the client's) */
  epochs?: number;
  /** Blob parity shards (overrides the client's) */
  redundancy?: number;
  onProgress?: (progress: UploadProgress) => void;
}

export interface UploadProgress {
  /** `push` = chunks or shards sent to the nodes, `segments` = ledger writes */
  stage: 'sign' | 'open' | 'segments' | 'push' | 'done';
  done: number;
  total: number;
}

export interface UploadResult {
  recordId: Hex32;
  mode: ResolvedMode;
  /** Blob ids (blob mode) */
  blobs?: Hex32[];
  /** Erasure code (blob mode): any `k` of `k + m` shards rebuild the file */
  layout?: { k: number; m: number; fragmentSize: number };
  /** Storage paid until (blob mode, unix seconds) */
  expiresAt?: bigint;
  /** Bytes encrypted and stored (after compression) */
  storedSize: number;
  /** Nodes that accepted direct chunks or shards */
  nodes: string[];
  /** Chunk ids (data chunks, then the index chunk if any), or blob ids */
  chunks: Hex32[];
  size: number;
  /** Upload fees paid to the protocol and replicators (wei) */
  feePaid: bigint;
  /** Gas charged for every transaction of the upload (wallet + session), in wei */
  networkFee: bigint;
  /** Wallet-signed transaction hashes */
  transactions: string[];
  /** Segment transactions written to the logs */
  segmentTransactions: number;
}

export interface FileQuote {
  mode: ResolvedMode;
  /** Blob mode: erasure code, prepaid epochs and how long they last */
  layout?: { k: number; m: number };
  epochs?: number;
  storageSeconds?: bigint;
  /** Chunks (direct, ledger) or blobs */
  chunks: number;
  /** Ledger segment transactions */
  segments: number;
  /** Paid to the protocol and replicators (wei) */
  uploadFee: bigint;
  /** Gas of every transaction (wallet + session writes), with the client's margin */
  gas: bigint;
  /** Wei per gas used for `networkFee` */
  gasPrice: bigint;
  /** gas × gasPrice: Monad charges the gas limit */
  networkFee: bigint;
  /** Value the wallet sends with the upload (fees + the session key's gas budget) */
  value: bigint;
  /** uploadFee + networkFee */
  total: bigint;
}

export interface DownloadResult {
  name: string;
  mime: string;
  data: Uint8Array;
  manifest: AnyManifest;
}

/** Blob of a file and its replication state */
export interface BlobStatus {
  id: Hex32;
  state: 'Hot' | 'Cool' | 'Closed';
  held: number;
  dataShards: number;
  totalShards: number;
  holders: Address[];
  expiresAt: bigint | null;
}

export interface ChunkStatus {
  id: Hex32;
  state: ChunkState | 'Closed';
  confirmedReplicas: number;
  requiredReplicas: number;
  replicators: Address[];
}

export interface FileEntry {
  recordId: Hex32;
  owner: Address;
  /** true when another wallet shared it with this one */
  shared: boolean;
  createdAt: number;
}

/** lookupFile: `missing` = no file record with that id (deleted, or another network) */
export type FileLookup = { status: 'ok'; entry: FileEntry } | { status: 'no-access'; owner: Address } | { status: 'missing' };

/**
 * Gas of each operation, measured on the contract (scripts/measure-costs.ts)
 * with headroom; used by quotes.  Uploads estimate the real transactions.
 */
export const GAS = {
  tx: 21_000n,
  upload: 90_000n,
  firstOpen: 120_000n,
  directChunk: 175_000n,
  ledgerChunk: 180_000n,
  blob: 170_000n,
  record: 80_000n,
  recordWord: 23_500n,
  segment: 30_000n,
  segmentByte: 41n,
  segmentComplete: 60_000n,
  register: 75_000n,
} as const;

/** Chunks per upload transaction (~10M gas: under Monad's 30M cap and the 16.7M cap of Osaka-era EVMs) */
const CHUNKS_PER_TX = 60;
/** Probe timeout for replicator nodes before an upload */
const NODE_PROBE_MS = 3_000;
/** Blocks the session key stays quiet before its sweep (Monad's emptying-transaction rule, k = 3) */
const SWEEP_QUIET_BLOCKS = 4;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * High-level MonaDB client: encrypted files on Monad.
 *
 *   const monadb = new MonaDBClient({ signer, deployment: DEPLOYMENTS.testnet });
 *   await monadb.register();
 *   const { recordId } = await monadb.uploadFile(bytes, { name: 'report.pdf' });
 *   const { data } = await monadb.downloadFile(recordId);
 *   await monadb.share(recordId, friendAddress);
 *
 * Files are compressed when it pays, encrypted with a random key
 * (AES-256-GCM) and stored as erasure-coded blobs, direct chunks or ledger
 * chunks.  The wallet signs one `upload` transaction (open + pay every chunk
 * or blob, create the record).  The manifest (hashes + key) is sealed to the
 * owner's X25519 key; sharing seals it again for the reader's published key.
 */
export class MonaDBClient {
  readonly provider: Provider;
  readonly signer: Signer;
  readonly contractAddress: string;
  readonly contract: Contract;
  readonly sender: TransactionSender;
  readonly chainId?: number;

  private readonly signMessage: SignMessage;
  private nodeUrls: string[];
  private readonly chunkSize: number;
  private readonly segmentSize: number;
  private readonly directChunkSize: number;
  private readonly mode: UploadMode;
  private readonly compress: boolean;
  private readonly customPush?: (chunk: ChunkRef, data: Uint8Array) => Promise<void>;
  private readonly replicas: number;
  private readonly epochs: number;
  private readonly redundancy?: number;
  private readonly sessionWriter: boolean;
  private readonly gasBuffer: bigint;
  private readonly ledgerFallback: boolean;
  private readonly customFetch?: (chunk: ChunkRef) => Promise<Uint8Array>;
  private readonly nodeTimeoutMs: number;
  private directNodes?: { urls: string[]; at: number };
  private activeEndpoints?: { urls: string[]; at: number };
  private keyPair?: Promise<EncryptionKeyPair>;
  private configCache?: { value: ConfigAccount; at: number };
  private endpoints = new Map<string, string | null>();
  private addressCache?: Address;

  constructor(options: MonaDBClientOptions) {
    const deployment = options.deployment;
    const contract = options.contract ?? deployment?.contract;
    if (!contract) throw new Error('Pass `contract` or a `deployment`');
    const provider = options.provider ?? deployment?.rpcUrl;
    if (!provider) throw new Error('Pass `provider` or a `deployment` with an rpcUrl');
    const chainId = options.chainId ?? deployment?.chainId;
    if (typeof provider === 'string') {
      if (chainId === undefined) throw new Error('Pass `chainId` with an RPC URL');
      this.provider = createMonadProvider(provider, chainId);
    } else {
      this.provider = provider;
    }
    this.chainId = chainId;
    this.signer = options.signer;
    this.contractAddress = getAddress(contract);
    this.contract = new Contract(this.contractAddress, MONADB_ABI, this.provider);
    this.signMessage = options.signMessage ?? (async (message) => getBytes(await options.signer.signMessage(message)));
    this.nodeUrls = (options.nodeUrls ?? deployment?.nodes ?? []).map((u) => u.replace(/\/$/, ''));
    this.chunkSize = options.chunkSize ?? 1024 * 1024;
    this.segmentSize = Math.min(options.segmentSize ?? 48 * 1024, MAX_SEGMENT_SIZE);
    // leave room for the encryption overhead under the contract's 16 MiB cap
    this.directChunkSize = Math.min(options.directChunkSize ?? 8 * 1024 * 1024, MAX_DIRECT_CHUNK_SIZE - 64);
    this.mode = options.mode ?? 'auto';
    this.compress = options.compress ?? true;
    this.customPush = options.pushChunk;
    this.replicas = options.replicas ?? 1;
    this.epochs = options.epochs ?? 12;
    this.redundancy = options.redundancy;
    this.sessionWriter = options.sessionWriter ?? true;
    this.gasBuffer = BigInt(options.gasBufferPct ?? 10);
    this.ledgerFallback = options.ledgerFallback ?? true;
    this.customFetch = options.fetchChunk;
    this.nodeTimeoutMs = options.nodeTimeoutMs ?? 30_000;
    this.sender = new TransactionSender(this.provider, { gasBufferPct: options.gasBufferPct ?? 10, concurrency: options.concurrency ?? 8 });
  }

  /** The wallet address */
  async address(): Promise<Address> {
    this.addressCache ??= getAddress(await this.signer.getAddress());
    return this.addressCache;
  }

  /** Replace the replicator endpoints tried first */
  setNodeUrls(urls: string[]): void {
    this.nodeUrls = urls.map((u) => u.replace(/\/$/, ''));
    this.directNodes = undefined;
  }

  private tx(method: string, args: unknown[], value?: bigint, label = method): TxRequest {
    return { signer: this.signer, to: this.contractAddress, data: monadbInterface.encodeFunctionData(method, args), value, label };
  }

  // ── Identity ───────────────────────────────────────────────────────────────

  /** The wallet's encryption key pair (one message signature, then cached) */
  keys(): Promise<EncryptionKeyPair> {
    this.keyPair ??= deriveEncryptionKeyPair(this.signMessage).catch((err) => {
      this.keyPair = undefined;
      throw err;
    });
    return this.keyPair;
  }

  async identity(user?: Address): Promise<IdentityAccount | null> {
    const who = getAddress(user ?? (await this.address()));
    return decodeIdentity(await this.contract.getIdentity(who), who);
  }

  async isRegistered(user?: Address): Promise<boolean> {
    return (await this.identity(user)) !== null;
  }

  /**
   * Publish this wallet's encryption key.  Registers it the first time and
   * rotates it if a different key is on-chain.  Returns the transaction
   * hash, or null when nothing had to change.
   */
  async register(): Promise<string | null> {
    const { publicKey } = await this.keys();
    const current = await this.identity();
    if (current && toHex(current.encryptionKey) === toHex(publicKey)) return null;
    const result = await this.sender.send(this.tx(current ? 'updateIdentity' : 'registerIdentity', [hexlify(publicKey)], undefined, 'register'));
    return result.hash;
  }

  // ── Pricing ────────────────────────────────────────────────────────────────

  async config(fresh = false): Promise<ConfigAccount> {
    if (!fresh && this.configCache && Date.now() - this.configCache.at < 30_000) return this.configCache.value;
    let raw;
    let admin: string;
    try {
      [raw, admin] = await Promise.all([this.contract.getConfig(), this.contract.admin()]);
    } catch (err) {
      throw new Error(`MonaDB is not deployed at ${this.contractAddress} on this network (${(err as Error).message})`);
    }
    const value = decodeConfig(raw, admin);
    this.configCache = { value, at: Date.now() };
    return value;
  }

  /** Wei per gas for fee estimates (eth_gasPrice: base fee + tip on Monad) */
  async gasPrice(): Promise<bigint> {
    const fee = await this.provider.getFeeData();
    return fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
  }

  /** Max wei per gas a transaction may pay (what Monad reserves from the sender) */
  private async maxGasPrice(): Promise<bigint> {
    const fee = await this.provider.getFeeData();
    return fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  }

  private withBuffer(gas: bigint): bigint {
    return (gas * (100n + this.gasBuffer)) / 100n;
  }

  /** Gas limit of one ledger segment transaction of `bytes` bytes */
  private segmentGas(bytes: number, completes: boolean): bigint {
    return this.withBuffer(GAS.tx + GAS.segment + GAS.segmentByte * BigInt(bytes) + (completes ? GAS.segmentComplete : 0n));
  }

  /** Gas of the record that stores a sealed manifest of `bytes` bytes */
  private recordGas(bytes: number): bigint {
    return GAS.record + GAS.recordWord * BigInt(Math.ceil(bytes / 32));
  }

  /**
   * Cost (wei) of uploading `size` plaintext bytes: the fee paid to the
   * protocol and replicators, plus the gas of every transaction.  An upper
   * bound when the file compresses (the upload measures the real size).
   * Pass the file's `name` (and `mime`) for an exact manifest size.
   */
  async quoteFile(
    size: number,
    replicas = this.replicas,
    mode: UploadMode = this.mode,
    {
      epochs = this.epochs,
      redundancy = this.redundancy,
      name,
      mime = 'application/octet-stream',
    }: { epochs?: number; redundancy?: number; name?: string; mime?: string } = {},
  ): Promise<FileQuote> {
    const [config, gasPrice] = await Promise.all([this.config(), this.gasPrice()]);
    const resolved = await this.resolveMode(mode);
    const textBytes = name === undefined ? undefined : manifestTextBytes(name, mime);
    if (resolved === 'blob') return this.quoteBlobs(size, epochs, redundancy, config, textBytes, gasPrice);
    const direct = resolved === 'direct';
    const chunkSizes = this.encryptedChunkSizes(size, direct ? this.directChunkSize : this.chunkSize);
    const indexed = chunkSizes.length > this.inlineChunkLimit();
    if (indexed) chunkSizes.push(32 * chunkSizes.length + ENCRYPTION_OVERHEAD);

    let uploadFee = 0n;
    let segments = 0;
    let sessionGas = 0n;
    for (const chunk of chunkSizes) {
      uploadFee += quoteChunk(config, chunk, replicas);
      if (direct) continue;
      const count = Math.ceil(chunk / this.segmentSize);
      segments += count;
      for (let i = 0; i < count; i++) sessionGas += this.segmentGas(Math.min(this.segmentSize, chunk - i * this.segmentSize), i === count - 1);
    }
    // 86 fixed bytes + name + MIME type (about 40 for typical files) + chunk hashes
    const manifestBytes = 86 + (textBytes ?? 40) + 32 * (indexed ? 1 : chunkSizes.length) + SEAL_OVERHEAD;
    const txs = Math.ceil(chunkSizes.length / CHUNKS_PER_TX);
    const walletGas = this.withBuffer(
      BigInt(txs) * (GAS.tx + GAS.upload) +
        GAS.firstOpen +
        BigInt(chunkSizes.length) * (direct ? GAS.directChunk : GAS.ledgerChunk) +
        this.recordGas(manifestBytes),
    );
    const useSession = !direct && this.sessionWriter;
    if (useSession) sessionGas += GAS.tx;
    const gas = walletGas + sessionGas;
    const networkFee = gas * gasPrice;
    const sessionBudget = useSession ? sessionGas * (await this.maxGasPrice()) : 0n;
    return {
      mode: resolved,
      chunks: chunkSizes.length,
      segments,
      uploadFee,
      gas,
      gasPrice,
      networkFee,
      value: uploadFee + sessionBudget,
      total: uploadFee + networkFee,
    };
  }

  /** "auto" → "blob" when a replicator node answers, else "ledger" ("direct" with a custom push) */
  async resolveMode(mode: UploadMode = this.mode): Promise<ResolvedMode> {
    if (mode !== 'auto') return mode;
    if (this.customPush) return 'direct';
    return (await this.directTargets()).length > 0 ? 'blob' : 'ledger';
  }

  private async quoteBlobs(
    size: number,
    epochs: number,
    redundancy: number | undefined,
    config: ConfigAccount,
    textBytes: number | undefined,
    gasPrice: bigint,
  ): Promise<FileQuote> {
    const nodes = Math.max(1, (await this.directTargets()).length);
    const layout = chooseLayout({ payloadSize: size, nodes, redundancy: redundancy !== undefined ? Math.min(redundancy, nodes - 1) : undefined });
    const n = layout.k + layout.m;
    let uploadFee = 0n;
    let remaining = layout.stripes;
    while (remaining > 0) {
      const stripes = Math.min(remaining, layout.stripesPerBlob);
      remaining -= stripes;
      uploadFee += quoteBlob(config, BigInt(stripes * layout.fragmentSize), n, epochs);
    }
    // 96 fixed bytes + name + MIME type (about 74 assumed) + 36 per blob
    const manifestBytes = 96 + (textBytes ?? 74) + 36 * layout.blobCount + SEAL_OVERHEAD;
    const gas = this.withBuffer(GAS.tx + GAS.upload + GAS.firstOpen + BigInt(layout.blobCount) * GAS.blob + this.recordGas(manifestBytes));
    return {
      mode: 'blob',
      layout: { k: layout.k, m: layout.m },
      epochs,
      storageSeconds: BigInt(epochs) * config.epochSeconds,
      chunks: layout.blobCount,
      segments: 0,
      uploadFee,
      gas,
      gasPrice,
      networkFee: gas * gasPrice,
      value: uploadFee,
      total: uploadFee + gas * gasPrice,
    };
  }

  /**
   * Replicator nodes that accept uploads now: the configured nodes, then
   * every active registered replicator, each probed with GET /status
   * (registered, active, same contract).  Cached for a minute.
   */
  async directTargets(fresh = false): Promise<string[]> {
    if (!fresh && this.directNodes && Date.now() - this.directNodes.at < 60_000) return this.directNodes.urls;
    const registered = await this.replicators().catch(() => []);
    const candidates = [...this.nodeUrls];
    for (const r of registered) {
      const url = r.endpoint.replace(/\/$/, '');
      if (r.active && url && !candidates.includes(url)) candidates.push(url);
    }
    const alive = await Promise.all(
      candidates.map(async (url) => {
        try {
          const response = await fetch(`${url}/status`, { signal: AbortSignal.timeout(NODE_PROBE_MS) });
          if (!response.ok) return false;
          const status = (await response.json()) as { registered?: boolean; active?: boolean; contract?: string };
          return status.registered === true && status.active !== false && (!status.contract || sameAddress(status.contract, this.contractAddress));
        } catch {
          return false;
        }
      }),
    );
    const urls = candidates.filter((_, i) => alive[i]);
    this.directNodes = { urls, at: Date.now() };
    return urls;
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  private async readyToUpload(): Promise<{ config: ConfigAccount; identity: IdentityAccount; keys: EncryptionKeyPair }> {
    const [config, identity, keys] = await Promise.all([this.config(), this.identity(), this.keys()]);
    if (!identity) throw new Error('Register this wallet first (MonaDBClient.register)');
    if (toHex(identity.encryptionKey) !== toHex(keys.publicKey)) {
      throw new Error("The published encryption key is not this wallet's; call register() to rotate it");
    }
    return { config, identity, keys };
  }

  async uploadFile(data: Uint8Array, options: UploadOptions): Promise<UploadResult> {
    const replicas = options.replicas ?? this.replicas;
    const progress = options.onProgress ?? (() => undefined);
    const { config, identity, keys } = await this.readyToUpload();
    const mode = await this.resolveMode(options.mode ?? this.mode);
    if (mode === 'blob') {
      const compressed = (options.compress ?? this.compress) ? await maybeCompress(data) : null;
      return this.uploadBlobPayload(
        compressed ?? data,
        {
          name: options.name,
          mime: options.mime ?? 'application/octet-stream',
          size: data.length,
          sha256: sha256(data),
          compressed: compressed !== null,
          bundle: false,
        },
        options,
        identity.recordNonce,
        keys.publicKey,
        config,
      );
    }
    const direct = mode === 'direct';
    // direct uploads need a node before anything is paid
    const targets = direct && !this.customPush ? await this.directTargets(true) : [];
    if (direct && !this.customPush && targets.length === 0) {
      throw new Error('No replicator node is reachable for a direct upload; retry later or use mode "ledger"');
    }
    const me = await this.address();

    // 1. Compress (when it pays), encrypt and split
    const compressed = (options.compress ?? this.compress) ? await maybeCompress(data) : null;
    const payload = compressed ?? data;
    const chunkSize = direct ? this.directChunkSize : this.chunkSize;
    const dek = randomKey();
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < payload.length || parts.length === 0; offset += chunkSize) {
      parts.push(encryptBytes(dek, payload.subarray(offset, offset + chunkSize)));
    }
    const hashes = parts.map((p) => sha256(p));
    const manifest: FileManifest = {
      v: 2,
      name: options.name,
      mime: options.mime ?? 'application/octet-stream',
      size: data.length,
      chunkSize,
      sha256: sha256(data),
      dek,
      createdAt: Math.floor(Date.now() / 1000),
      chunkCount: parts.length,
      chunks: hashes,
      ...(direct ? { direct: true } : {}),
      ...(compressed ? { compression: 'gzip' as const } : {}),
    };

    // 2. Records hold up to 2 KiB (and each word costs gas): long chunk lists move to an index chunk
    let sealed = seal(keys.publicKey, encodeManifest(manifest));
    if (parts.length > this.inlineChunkLimit() || sealed.length > MAX_RECORD_CONTENT) {
      const indexChunk = encryptBytes(dek, encodeIndex(hashes));
      parts.push(indexChunk);
      const indexHash = sha256(indexChunk);
      hashes.push(indexHash);
      sealed = seal(keys.publicKey, encodeManifest({ ...manifest, chunks: [], index: indexHash }));
    }

    // 3. One wallet transaction (more for > 100 chunks): open + pay each chunk, create the record,
    //    fund the session key that writes the ledger segments
    const useSession = !direct && this.sessionWriter;
    const segmentSize = direct ? 0 : this.segmentSize;
    const session = useSession ? new Wallet(hexlify(randomBytes(32)), this.provider) : null;
    const writer = session ? session.address : me;
    const chunkIds = hashes.map((h) => ids.chunk(me, h));
    const args = parts.map((part, i) => ({
      contentHash: hexlify(hashes[i]),
      size: part.length,
      segmentSize,
      replicas,
      maxFee: quoteChunk(config, part.length, replicas),
    }));
    const feePaid = args.reduce((n, a) => n + a.maxFee, 0n);
    let sessionBudget = 0n;
    if (session) {
      let gas = GAS.tx; // the sweep back to the wallet
      for (const part of parts) {
        const count = Math.ceil(part.length / segmentSize);
        for (let i = 0; i < count; i++) gas += this.segmentGas(Math.min(segmentSize, part.length - i * segmentSize), true);
      }
      sessionBudget = gas * (await this.maxGasPrice());
    }

    const groups: (typeof args)[] = [];
    for (let i = 0; i < args.length; i += CHUNKS_PER_TX) groups.push(args.slice(i, i + CHUNKS_PER_TX));
    progress({ stage: 'sign', done: 0, total: groups.length });
    const walletResults: TxResult[] = [];
    let networkFee = 0n;
    let written = 0;
    let acceptedBy: string[] = [];
    try {
      for (const [g, group] of groups.entries()) {
        const last = g === groups.length - 1;
        const value = group.reduce((n, a) => n + a.maxFee, 0n) + (last ? sessionBudget : 0n);
        // every group names the session writer (earlier groups send no extra value, so nothing goes to it)
        const result = await this.sender.send(
          this.tx('upload', [group, [], writer, last ? FILE_SCHEMA : '', last ? hexlify(sealed) : '0x'], value, `upload ${g + 1}/${groups.length}`),
        );
        walletResults.push(result);
        networkFee += result.fee;
        progress({ stage: 'open', done: g + 1, total: groups.length });
      }

      if (direct) {
        // 4a. Each chunk goes to up to `replicas` nodes; the others copy it from them
        let pushed = 0;
        const accepted = new Set<string>();
        const refs = chunkIds.map((id, i) => ({ id, owner: me, contentHash: hashes[i] }));
        let next = 0;
        const worker = async () => {
          while (next < refs.length) {
            const i = next++;
            for (const url of await this.pushDirect(refs[i], parts[i], targets, replicas)) accepted.add(url);
            progress({ stage: 'push', done: ++pushed, total: refs.length });
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, refs.length) }, worker));
        acceptedBy = [...accepted];
      } else {
        // 4b. The session key (or the wallet) writes the segments: all but each chunk's
        //     last first, then the last ones, whose estimate includes completing the chunk
        const writerSigner = session ?? this.signer;
        const requests: TxRequest[][] = [[], []];
        parts.forEach((part, c) => {
          const count = Math.ceil(part.length / segmentSize);
          for (let index = 0; index < count; index++) {
            const slice = part.subarray(index * segmentSize, (index + 1) * segmentSize);
            requests[index === count - 1 ? 1 : 0].push({
              signer: writerSigner,
              to: this.contractAddress,
              data: monadbInterface.encodeFunctionData('writeSegment', [chunkIds[c], index, slice]),
              label: `segment ${index} of chunk ${c}`,
            });
          }
        });
        const total = requests[0].length + requests[1].length;
        for (const phase of requests) {
          const results = await this.sender.sendAll(phase, {
            isDone: (name) => name === 'SegmentAlreadyWritten',
            onConfirmed: () => progress({ stage: 'segments', done: ++written, total }),
          });
          for (const r of results) if (r) networkFee += r.fee;
        }
      }
    } finally {
      // return the session key's MON even when a step failed
      if (session) networkFee += await this.sweep(session).catch(() => 0n);
      progress({ stage: 'done', done: 1, total: 1 });
    }

    return {
      recordId: ids.record(me, identity.recordNonce),
      mode,
      storedSize: payload.length,
      nodes: acceptedBy,
      chunks: chunkIds,
      size: data.length,
      feePaid,
      networkFee,
      transactions: walletResults.map((r) => r.hash),
      segmentTransactions: written,
    };
  }

  /** Decrypt the manifest of a record this wallet owns or was granted (v2 chunks or v3 blobs) */
  async getManifest(recordId: string): Promise<AnyManifest> {
    const record = await this.record(recordId);
    const me = await this.address();
    let content = record.content;
    if (!sameAddress(record.owner, me)) {
      const grant = await this.grant(record.id, me);
      if (!grant) throw new Error(`Record ${recordId} is not shared with ${me}`);
      content = grant.content;
    }
    const plain = open(await this.keys(), content);
    return isBlobManifest(plain) ? decodeBlobManifest(plain) : decodeManifest(plain);
  }

  /**
   * Download, verify and decrypt a file.  For a bundle (uploadFiles) pass
   * `entry` to get one of its files, or use downloadBundle for all of them.
   */
  async downloadFile(recordId: string, { entry }: { entry?: string } = {}): Promise<DownloadResult> {
    const record = await this.record(recordId);
    const manifest = await this.getManifest(recordId);
    if (manifest.v === 3) {
      const payload = await this.downloadBlobPayload(record.owner, manifest);
      if (!manifest.bundle) return { name: manifest.name, mime: manifest.mime, data: payload, manifest };
      const files = decodeBundle(payload);
      const file = entry === undefined ? (files.length === 1 ? files[0] : undefined) : files.find((f) => f.name === entry);
      if (!file) {
        throw new Error(entry === undefined ? `Record ${recordId} is a bundle of ${files.length} files: pass { entry } or use downloadBundle` : `No file "${entry}" in this bundle`);
      }
      return { name: file.name, mime: file.mime, data: file.data, manifest };
    }
    const refs = await this.chunkRefs(record, manifest);

    const plain: Uint8Array[] = new Array(refs.length);
    let next = 0;
    const worker = async () => {
      while (next < refs.length) {
        const i = next++;
        plain[i] = decryptBytes(manifest.dek, await this.fetchVerified(refs[i], record, !manifest.direct));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, refs.length) }, worker));
    const total = plain.reduce((n, p) => n + p.length, 0);
    let data: Uint8Array = new Uint8Array(total);
    let offset = 0;
    for (const p of plain) {
      data.set(p, offset);
      offset += p.length;
    }
    if (manifest.compression === 'gzip') data = await gunzip(data);
    if (data.length !== manifest.size || toHex(sha256(data)) !== toHex(manifest.sha256)) {
      throw new Error(`Integrity check failed for record ${recordId}`);
    }
    return { name: manifest.name, mime: manifest.mime, data, manifest };
  }

  /** Give `viewer` (who must have registered) read access to a file, or refresh their copy */
  async share(recordId: string, viewer: string): Promise<string> {
    if (!isAddress(viewer)) throw new Error(`${viewer} is not a Monad address`);
    const viewerAddress = getAddress(viewer);
    const identity = await this.identity(viewerAddress);
    if (!identity) throw new Error(`${viewerAddress} has no MonaDB identity yet`);
    const manifest = await this.getManifest(recordId);
    const sealed = seal(identity.encryptionKey, manifest.v === 3 ? encodeBlobManifest(manifest) : encodeManifest(manifest));
    const result = await this.sender.send(this.tx('grantAccess', [recordId, viewerAddress, hexlify(sealed)], undefined, 'share'));
    return result.hash;
  }

  async revoke(recordId: string, viewer: string): Promise<string> {
    return (await this.sender.send(this.tx('revokeAccess', [recordId, getAddress(viewer)], undefined, 'revoke'))).hash;
  }

  /** Wallets that hold a grant on the record */
  async viewers(recordId: string): Promise<Address[]> {
    return [...(await this.contract.viewersOf(recordId))];
  }

  /**
   * Delete a file in one transaction: the record (and every grant on it)
   * and, with `closeChunks`, the chunks that are settled (their unspent
   * escrow comes back).
   */
  async deleteFile(recordId: string, { closeChunks = true } = {}): Promise<string> {
    const record = await this.record(recordId);
    if (!sameAddress(record.owner, await this.address())) throw new Error('Only the owner can delete a file');
    const manifest = closeChunks ? await this.getManifest(recordId).catch(() => undefined) : undefined;
    const calls = [monadbInterface.encodeFunctionData('deleteRecord', [record.id])];
    // blobs are prepaid: they close after expiry (reclaimAllDeposits)
    if (manifest && manifest.v === 2) {
      for (const id of await this.closableChunks(record, manifest)) calls.push(monadbInterface.encodeFunctionData('closeChunk', [id]));
    }
    return (await this.sender.send(this.multicall(calls, 'delete'))).hash;
  }

  /** Close the settled chunks or blobs of a file to recover their unspent escrow (the data stays on replicators) */
  async reclaimDeposits(recordId: string): Promise<{ closed: number; transaction?: string }> {
    const record = await this.record(recordId);
    const manifest = await this.getManifest(recordId);
    const calls =
      manifest.v === 3
        ? (await this.closableBlobs(manifest.blobs.map((b) => ids.blob(record.owner, b.root)))).map((id) => monadbInterface.encodeFunctionData('closeBlob', [id]))
        : (await this.closableChunks(record, manifest)).map((id) => monadbInterface.encodeFunctionData('closeChunk', [id]));
    if (calls.length === 0) return { closed: 0 };
    return { closed: calls.length, transaction: (await this.sender.send(this.multicall(calls, 'reclaim'))).hash };
  }

  /**
   * Close every settled chunk and blob this wallet owns, including those of
   * deleted files that no manifest points to any more.  Returns the wei
   * recovered.
   */
  async reclaimAllDeposits(): Promise<{ closed: number; wei: bigint; transaction?: string }> {
    const me = await this.address();
    const [chunkIds, blobIds] = await Promise.all([this.pageAll((o, l) => this.contract.chunksOf(me, o, l), await this.contract.chunkCountOf(me)), this.pageAll((o, l) => this.contract.blobsOf(me, o, l), await this.contract.blobCountOf(me))]);
    const now = await this.chainNow();
    const chunks = (await this.chunks(chunkIds)).filter((c): c is ChunkAccount => c !== null && isClosable(c, now));
    const config = blobIds.length > 0 ? await this.config() : null;
    const blobs = (await this.blobs(blobIds)).filter((b): b is BlobAccount => b !== null && config !== null && isBlobClosable(b, config.epochSeconds, now));
    if (chunks.length + blobs.length === 0) return { closed: 0, wei: 0n };
    const calls = [
      ...chunks.map((c) => monadbInterface.encodeFunctionData('closeChunk', [c.id])),
      ...blobs.map((b) => monadbInterface.encodeFunctionData('closeBlob', [b.id])),
    ];
    const wei =
      chunks.reduce((n, c) => n + (c.reclaimed ? 0n : BigInt(c.requiredReplicas - c.confirmedReplicas) * c.rewardPerReplica), 0n) +
      blobs.reduce((n, b) => n + b.escrow, 0n);
    const result = await this.sender.send(this.multicall(calls, 'reclaim'));
    return { closed: calls.length, wei, transaction: result.hash };
  }

  /**
   * Replication state of every chunk of a file.  For blob files each blob is
   * one entry: `confirmedReplicas` = shards held, `requiredReplicas` = shards
   * in total, Cool once any `k` can rebuild it (details in `blobs`).
   */
  async fileStatus(recordId: string): Promise<{ manifest: AnyManifest; chunks: ChunkStatus[]; cool: boolean; blobs?: BlobStatus[] }> {
    const record = await this.record(recordId);
    const manifest = await this.getManifest(recordId);
    if (manifest.v === 3) {
      const blobs = await this.blobStatus(record.owner, manifest);
      const chunks: ChunkStatus[] = blobs.map((b) => ({
        id: b.id,
        state: b.state,
        confirmedReplicas: b.held,
        requiredReplicas: b.totalShards,
        replicators: b.holders,
      }));
      return { manifest, chunks, cool: blobs.every((b) => b.state !== 'Hot'), blobs };
    }
    const refs = await this.chunkRefs(record, manifest, true);
    const chunks = await this.chunkStatus(refs.map((r) => r.id));
    return { manifest, chunks, cool: chunks.every((c) => c.state === 'Cool' || c.state === 'Closed') };
  }

  async chunkStatus(chunkIds: Hex32[]): Promise<ChunkStatus[]> {
    const chunks = await this.chunks(chunkIds);
    return chunks.map((chunk, i) =>
      chunk
        ? { id: chunkIds[i], state: chunk.state, confirmedReplicas: chunk.confirmedReplicas, requiredReplicas: chunk.requiredReplicas, replicators: chunk.replicators }
        : { id: chunkIds[i], state: 'Closed', confirmedReplicas: 0, requiredReplicas: 0, replicators: [] },
    );
  }

  /** Resolve once every chunk is Cool (replicated) or closed */
  async waitUntilCool(chunkIds: Hex32[], { timeoutMs = 180_000, pollMs = 2_000 } = {}): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.chunkStatus(chunkIds);
      if (status.every((c) => c.state === 'Cool' || c.state === 'Closed')) return;
      await sleep(pollMs);
    }
    throw new Error(`Chunks not replicated after ${timeoutMs} ms`);
  }

  /**
   * What a link to `recordId` gives this wallet: the file entry when it owns
   * the record or holds a grant, otherwise the owner to ask for access.
   */
  async lookupFile(recordId: string): Promise<FileLookup> {
    if (!isHex32(recordId)) return { status: 'missing' };
    const record = decodeRecord(await this.contract.getRecord(recordId), recordId);
    if (!record || (record.schema !== FILE_SCHEMA && record.schema !== BLOB_FILE_SCHEMA)) return { status: 'missing' };
    const me = await this.address();
    if (sameAddress(record.owner, me)) {
      return { status: 'ok', entry: { recordId: record.id, owner: record.owner, shared: false, createdAt: Number(record.createdAt) } };
    }
    const grant = await this.grant(record.id, me);
    if (!grant) return { status: 'no-access', owner: record.owner };
    return { status: 'ok', entry: { recordId: record.id, owner: record.owner, shared: true, createdAt: Number(grant.grantedAt) } };
  }

  /** Files this wallet created or was given access to, newest first */
  async listFiles(): Promise<FileEntry[]> {
    const me = await this.address();
    const identity = await this.identity(me);
    const owned: Hex32[] = [];
    for (let from = 0n; identity && from < identity.recordNonce; from += 200n) {
      owned.push(...(await this.contract.recordsOf(me, from, 200n)));
    }
    const granted = await this.pageAll((o, l) => this.contract.grantsTo(me, o, l), await this.contract.grantCountTo(me));
    const [ownedRecords, grantedRecords, grants] = await Promise.all([
      Promise.all(owned.map((id) => this.contract.getRecord(id).then((r: unknown) => decodeRecord(r, id)))),
      Promise.all(granted.map((id) => this.contract.getRecord(id).then((r: unknown) => decodeRecord(r, id)))),
      Promise.all(granted.map((id) => this.grant(id, me))),
    ]);
    const isFile = (r: RecordAccount | null): r is RecordAccount => r !== null && (r.schema === FILE_SCHEMA || r.schema === BLOB_FILE_SCHEMA);
    const files: FileEntry[] = [
      ...ownedRecords.filter(isFile).map((r) => ({ recordId: r.id, owner: r.owner, shared: false, createdAt: Number(r.createdAt) })),
      ...grantedRecords.flatMap((r, i) =>
        isFile(r) && grants[i] ? [{ recordId: r.id, owner: r.owner, shared: true, createdAt: Number(grants[i]!.grantedAt) }] : [],
      ),
    ];
    return files.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Registered replicators and their endpoints */
  async replicators(): Promise<ReplicatorAccount[]> {
    const count = Number(await this.contract.replicatorCount());
    const out: ReplicatorAccount[] = [];
    for (let offset = 0; offset < count; offset += 100) {
      const [authorities, list] = await this.contract.getReplicators(offset, 100);
      authorities.forEach((a: string, i: number) => {
        const r = decodeReplicator(list[i], a);
        if (r) out.push(r);
      });
    }
    return out;
  }

  // ── Blobs (docs/blob-protocol.md) ──────────────────────────────────────────

  /**
   * Store many small files as one bundle: one blob and one record for all of
   * them.  Download one with downloadFile(recordId, { entry }) or all with
   * downloadBundle.
   */
  async uploadFiles(files: BundleFile[], options: Omit<UploadOptions, 'mime' | 'mode'> & { name?: string }): Promise<UploadResult & { entries: string[] }> {
    if (files.length === 0) throw new Error('No files to bundle');
    const { config, identity, keys } = await this.readyToUpload();
    const bundle = encodeBundle(files);
    const compressed = (options.compress ?? this.compress) ? await maybeCompress(bundle) : null;
    const result = await this.uploadBlobPayload(
      compressed ?? bundle,
      {
        name: options.name ?? `${files.length} files`,
        mime: 'application/x-monadb-bundle',
        size: bundle.length,
        sha256: sha256(bundle),
        compressed: compressed !== null,
        bundle: true,
      },
      options,
      identity.recordNonce,
      keys.publicKey,
      config,
    );
    return { ...result, entries: files.map((f) => f.name) };
  }

  /** Every file of a bundle, each verified against its sha256 */
  async downloadBundle(recordId: string): Promise<BundleEntry[]> {
    const record = await this.record(recordId);
    const manifest = await this.getManifest(recordId);
    if (manifest.v !== 3 || !manifest.bundle) throw new Error(`Record ${recordId} is not a bundle`);
    return decodeBundle(await this.downloadBlobPayload(record.owner, manifest));
  }

  /** Prepay `epochs` more epochs for every blob of a file (owner only), in one transaction */
  async extendFile(recordId: string, epochs: number): Promise<string> {
    const record = await this.record(recordId);
    const manifest = await this.getManifest(recordId);
    if (manifest.v !== 3) throw new Error('Only blob files are prepaid per epoch');
    const config = await this.config();
    const blobIds = manifest.blobs.map((b) => ids.blob(record.owner, b.root));
    const blobs = await this.blobs(blobIds);
    let fee = 0n;
    blobs.forEach((b, i) => {
      if (!b) throw new Error(`Blob ${blobIds[i]} is closed`);
      fee += quoteExtension(config, b, epochs);
    });
    return (await this.sender.send(this.tx('extendBlobs', [blobIds, epochs, fee], fee, 'extend'))).hash;
  }

  /** Holders and state of every blob of a v3 manifest */
  async blobStatus(owner: Address, manifest: BlobManifest): Promise<BlobStatus[]> {
    const blobIds = manifest.blobs.map((b) => ids.blob(owner, b.root));
    const blobs = await this.blobs(blobIds);
    return blobs.map((blob, i) =>
      blob
        ? {
            id: blobIds[i],
            state: blob.state,
            held: blob.held,
            dataShards: blob.dataShards,
            totalShards: blob.totalShards,
            holders: blob.slots.map((s) => s.holder),
            expiresAt: blob.expiresAt,
          }
        : { id: blobIds[i], state: 'Closed', held: 0, dataShards: manifest.k, totalShards: manifest.k + manifest.m, holders: [], expiresAt: null },
    );
  }

  private async uploadBlobPayload(
    payload: Uint8Array,
    meta: { name: string; mime: string; size: number; sha256: Uint8Array; compressed: boolean; bundle: boolean },
    options: Pick<UploadOptions, 'epochs' | 'redundancy' | 'onProgress'>,
    nonce: bigint,
    publicKey: Uint8Array,
    config: ConfigAccount,
  ): Promise<UploadResult> {
    const progress = options.onProgress ?? (() => undefined);
    const epochs = options.epochs ?? this.epochs;
    const targets = await this.directTargets(true);
    if (targets.length === 0) throw new Error('No replicator node is reachable for a blob upload; retry later or use mode "ledger"');
    const me = await this.address();
    const redundancy = options.redundancy ?? this.redundancy;
    const layout = chooseLayout({
      payloadSize: payload.length,
      nodes: targets.length,
      redundancy: redundancy !== undefined ? Math.min(redundancy, targets.length - 1) : undefined,
    });
    const n = layout.k + layout.m;
    const dek = randomKey();
    const blobs = encodeBlobs(payload, layout, dek);
    const manifest: BlobManifest = {
      v: 3,
      name: meta.name,
      mime: meta.mime,
      size: meta.size,
      createdAt: Math.floor(Date.now() / 1000),
      sha256: meta.sha256,
      dek,
      payloadSize: payload.length,
      k: layout.k,
      m: layout.m,
      fragmentSize: layout.fragmentSize,
      blobs: blobs.map((b) => ({ root: b.root, stripes: b.stripes })),
      ...(meta.compressed ? { compression: 'gzip' as const } : {}),
      ...(meta.bundle ? { bundle: true as const } : {}),
    };
    const sealed = seal(publicKey, encodeBlobManifest(manifest));
    if (sealed.length > MAX_RECORD_CONTENT) {
      throw new Error(`This file needs ${blobs.length} blobs, more than one record can list; split it into smaller files`);
    }

    // One wallet transaction: open + prepay every blob, create the record
    const blobIds = blobs.map((b) => ids.blob(me, b.root));
    const args = blobs.map((blob) => ({
      root: hexlify(blob.root),
      dataShards: layout.k,
      totalShards: n,
      shardSize: BigInt(blob.shardSize),
      payloadSize: BigInt(blob.payloadLength),
      epochs,
      maxFee: quoteBlob(config, BigInt(blob.shardSize), n, epochs),
    }));
    const feePaid = args.reduce((sum, a) => sum + a.maxFee, 0n);
    progress({ stage: 'sign', done: 0, total: 1 });
    const opened = await this.sender.send(this.tx('upload', [[], args, ZeroAddress, BLOB_FILE_SCHEMA, hexlify(sealed)], feePaid, 'upload'));
    progress({ stage: 'open', done: 1, total: 1 });

    // Each shard to its own node (rotated per blob); a node holds one shard per blob
    const accepted = new Set<string>();
    const jobs = blobs.flatMap((blob, b) => blob.shards.map((shard, j) => ({ b, j, shard })));
    let pushed = 0;
    let next = 0;
    const failures: string[] = [];
    const used = blobs.map(() => new Set<string>());
    const worker = async () => {
      while (next < jobs.length) {
        const { b, j, shard } = jobs[next++];
        const order = targets.map((_, t) => targets[(t + j + b) % targets.length]);
        let done = false;
        for (const url of order) {
          if (used[b].has(url)) continue;
          used[b].add(url);
          try {
            await this.pushShard(url, blobIds[b], j, shard, blobs[b].shardRoots, layout.fragmentSize);
            accepted.add(url);
            done = true;
            break;
          } catch (err) {
            failures.push(`blob ${b} shard ${j} → ${url}: ${(err as Error).message}`);
          }
        }
        if (!done) failures.push(`blob ${b} shard ${j}: no node took it`);
        progress({ stage: 'push', done: ++pushed, total: jobs.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
    progress({ stage: 'done', done: 1, total: 1 });
    const status = await this.blobStatus(me, manifest);
    const unreadable = status.filter((s) => s.held < s.dataShards);
    if (unreadable.length > 0) {
      throw new Error(
        `${unreadable.length} blob(s) got fewer than ${layout.k} shards (${failures.slice(0, 3).join('; ')}). ` +
          'Nodes may still rebuild them; the deposit of an unheld blob comes back after 10 minutes (reclaimAllDeposits).',
      );
    }
    return {
      recordId: ids.record(me, nonce),
      mode: 'blob',
      blobs: blobIds,
      layout: { k: layout.k, m: layout.m, fragmentSize: layout.fragmentSize },
      expiresAt: status.reduce((min, s) => (s.expiresAt !== null && (min === 0n || s.expiresAt < min) ? s.expiresAt : min), 0n),
      storedSize: payload.length,
      nodes: [...accepted],
      chunks: blobIds,
      size: meta.size,
      feePaid,
      networkFee: opened.fee,
      transactions: [opened.hash],
      segmentTransactions: 0,
    };
  }

  /** PUT a shard in pieces of 8 MiB (resumable: each piece says its offset) */
  private async pushShard(url: string, blob: Hex32, index: number, shard: Uint8Array, roots: Uint8Array[], fragmentSize: number): Promise<void> {
    const piece = 8 * 1024 * 1024;
    for (let offset = 0; offset < shard.length; offset += piece) {
      const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
      if (offset === 0) {
        headers['x-monadb-shard-roots'] = roots.map(toHex).join(',');
        headers['x-monadb-fragment-size'] = String(fragmentSize);
      }
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(`${url}/blob/${blob}/shard/${index}?offset=${offset}`, {
          method: 'PUT',
          headers,
          body: shard.subarray(offset, offset + piece) as BodyInit,
          signal: AbortSignal.timeout(Math.max(this.nodeTimeoutMs, 120_000)),
        });
        // 404: the node's RPC has not seen the upload transaction yet
        if (response.status === 404 && offset === 0 && attempt < 5) {
          await sleep(1_000 * (attempt + 1));
          continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
        break;
      }
    }
  }

  /** Fetch, verify and decode every stripe of a v3 manifest's blobs → payload (decompressed, checked) */
  private async downloadBlobPayload(owner: Address, manifest: BlobManifest): Promise<Uint8Array> {
    const { k, m, fragmentSize } = manifest;
    const n = k + m;
    const lengths = stripePlainLengths(manifest.payloadSize, k, fragmentSize);
    const payload = new Uint8Array(manifest.payloadSize);
    let global = 0;
    let offset = 0;
    for (const ref of manifest.blobs) {
      const blobId = ids.blob(owner, ref.root);
      const sources = await this.shardSources(blobId, n);
      const roots = await this.verifiedRoots(blobId, ref.root, sources.flatMap((s) => s.urls));
      const first = global;
      const plains: Uint8Array[] = new Array(ref.stripes);
      let cursor = 0;
      const worker = async () => {
        while (cursor < ref.stripes) {
          const stripe = cursor++;
          const fragments: (Uint8Array | null)[] = new Array(n).fill(null);
          let have = 0;
          // data shards first: no decoding needed when they are all there
          for (const source of sources) {
            if (have >= k) break;
            for (const url of source.urls) {
              const fragment = await this.fetchFragment(url, blobId, source.index, stripe, roots[source.index], fragmentSize, ref.stripes);
              if (fragment) {
                fragments[source.index] = fragment;
                have++;
                break;
              }
            }
          }
          if (have < k) throw new Error(`Blob ${blobId} stripe ${stripe}: only ${have} verified fragments, ${k} needed`);
          plains[stripe] = decodeStripe(fragments, k, m, fragmentSize, manifest.dek, lengths[first + stripe]);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, ref.stripes) }, worker));
      for (const plain of plains) {
        payload.set(plain, offset);
        offset += plain.length;
      }
      global += ref.stripes;
    }
    if (offset !== manifest.payloadSize) throw new Error('Integrity check failed: payload size');
    const plain = manifest.compression === 'gzip' ? await gunzip(payload) : payload;
    if (plain.length !== manifest.size || toHex(sha256(plain)) !== toHex(manifest.sha256)) {
      throw new Error('Integrity check failed: sha256');
    }
    return plain;
  }

  /** Per shard index: the endpoint of its holder, then every other active node (data shards first) */
  private async shardSources(blobId: Hex32, n: number): Promise<{ index: number; urls: string[] }[]> {
    const blob = await this.blobs([blobId]).then((b) => b[0]).catch(() => null);
    const all = await this.replicators().catch(() => []);
    const byAuthority = new Map(all.filter((r) => r.active).map((r) => [r.authority.toLowerCase(), r.endpoint.replace(/\/$/, '')]));
    const everyone = [...new Set([...this.nodeUrls, ...byAuthority.values()])];
    return Array.from({ length: n }, (_, index) => {
      const holder = blob?.slots[index]?.holder;
      const own = holder && holder !== VACANT ? byAuthority.get(holder.toLowerCase()) : undefined;
      return { index, urls: own ? [own, ...everyone.filter((u) => u !== own)] : everyone };
    });
  }

  /** Shard roots from any node, accepted only if they hash to the blob root */
  private async verifiedRoots(blobId: Hex32, root: Uint8Array, urls: string[]): Promise<Uint8Array[]> {
    for (const url of [...new Set(urls)]) {
      try {
        const response = await fetch(`${url}/blob/${blobId}/roots`, { signal: AbortSignal.timeout(this.nodeTimeoutMs) });
        if (!response.ok) continue;
        const body = (await response.json()) as unknown;
        if (!Array.isArray(body) || body.some((r) => typeof r !== 'string' || !/^[0-9a-f]{64}$/i.test(r))) continue;
        const roots = (body as string[]).map(fromHex);
        if (toHex(blobRoot(roots)) === toHex(root)) return roots;
      } catch {
        // next node
      }
    }
    throw new Error(`No node served shard roots matching blob ${blobId}`);
  }

  /**
   * One fragment, accepted only if it is exactly `fragmentSize` bytes and its
   * proof has the depth of the blob's stripe tree: a node cannot pass off
   * several fragments (or a subtree) with a shorter proof
   */
  private async fetchFragment(
    url: string,
    blobId: Hex32,
    index: number,
    stripe: number,
    shardRoot: Uint8Array,
    fragmentSize: number,
    stripes: number,
  ): Promise<Uint8Array | null> {
    try {
      const response = await fetch(`${url}/blob/${blobId}/shard/${index}/fragment/${stripe}`, { signal: AbortSignal.timeout(this.nodeTimeoutMs) });
      if (!response.ok) return null;
      const header = (response.headers.get('x-monadb-proof') ?? '').split(',').filter(Boolean);
      if (header.length !== depth(stripes) || header.some((h) => !/^[0-9a-f]{64}$/i.test(h))) return null;
      const proof = header.map(fromHex);
      const fragment = new Uint8Array(await response.arrayBuffer());
      if (fragment.length !== fragmentSize) return null;
      return verifyFragment(fragment, stripe, proof, shardRoot) ? fragment : null;
    } catch {
      return null;
    }
  }

  private async closableBlobs(blobIds: Hex32[]): Promise<Hex32[]> {
    const [blobs, config, now] = await Promise.all([this.blobs(blobIds), this.config(), this.chainNow()]);
    const me = await this.address();
    return blobs.filter((b): b is BlobAccount => b !== null && sameAddress(b.owner, me) && isBlobClosable(b, config.epochSeconds, now)).map((b) => b.id);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async record(recordId: string): Promise<RecordAccount> {
    if (!isHex32(recordId)) throw new Error(`${recordId} is not a record id`);
    const record = decodeRecord(await this.contract.getRecord(recordId), recordId);
    if (!record) throw new Error(`Record ${recordId} not found`);
    return record;
  }

  async grant(recordId: Hex32, viewer: Address): Promise<GrantAccount | null> {
    return decodeGrant(await this.contract.getGrant(recordId, viewer), recordId, viewer);
  }

  /** Chunks by id (null = closed or never opened) */
  async chunks(chunkIds: Hex32[]): Promise<(ChunkAccount | null)[]> {
    const out: (ChunkAccount | null)[] = [];
    for (let i = 0; i < chunkIds.length; i += 50) {
      const slice = chunkIds.slice(i, i + 50);
      const raw = await this.contract.getChunks(slice);
      raw.forEach((r: unknown, j: number) => out.push(decodeChunk(r, slice[j])));
    }
    return out;
  }

  /** Blobs by id (null = closed or never opened) */
  async blobs(blobIds: Hex32[]): Promise<(BlobAccount | null)[]> {
    const out: (BlobAccount | null)[] = [];
    for (let i = 0; i < blobIds.length; i += 20) {
      const slice = blobIds.slice(i, i + 20);
      const raw = await this.contract.getBlobs(slice);
      raw.forEach((r: unknown, j: number) => out.push(decodeBlob(r, slice[j])));
    }
    return out;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** The latest block's timestamp: what the contract compares deadlines to */
  async chainNow(): Promise<bigint> {
    const block = await this.provider.getBlock('latest');
    return BigInt(block?.timestamp ?? Math.floor(Date.now() / 1000));
  }

  private multicall(calls: string[], label: string): TxRequest {
    return this.tx('multicall', [calls], undefined, label);
  }

  private async pageAll(page: (offset: number, limit: number) => Promise<string[]>, count: bigint | number): Promise<Hex32[]> {
    const out: Hex32[] = [];
    for (let offset = 0; offset < Number(count); offset += 200) out.push(...(await page(offset, 200)));
    return out;
  }

  /** Chunk references of a file, in order (`withIndex` appends the index chunk) */
  private async chunkRefs(record: RecordAccount, manifest: FileManifest, withIndex = false): Promise<ChunkRef[]> {
    const owner = record.owner;
    const ref = (contentHash: Uint8Array): ChunkRef => ({ id: ids.chunk(owner, contentHash), owner, contentHash });
    if (!manifest.index) return manifest.chunks.map(ref);
    const indexRef = ref(manifest.index);
    const hashes = decodeIndex(decryptBytes(manifest.dek, await this.fetchVerified(indexRef, record, !manifest.direct)));
    const refs = hashes.map(ref);
    return withIndex ? [...refs, indexRef] : refs;
  }

  private async closableChunks(record: RecordAccount, manifest: FileManifest): Promise<Hex32[]> {
    const refs = await this.chunkRefs(record, manifest, true).catch(() =>
      // index chunk unreachable: close what the manifest names directly
      [...manifest.chunks, ...(manifest.index ? [manifest.index] : [])].map((h) => ({ id: ids.chunk(record.owner, h), owner: record.owner, contentHash: h })),
    );
    const [chunks, now] = await Promise.all([this.chunks(refs.map((r) => r.id)), this.chainNow()]);
    return chunks.filter((c): c is ChunkAccount => c !== null && isClosable(c, now)).map((c) => c.id);
  }

  /** Fetch a chunk (custom source, replicators, then the logs) and check its hash */
  private async fetchVerified(ref: ChunkRef, record: RecordAccount, ledger = true): Promise<Uint8Array> {
    const errors: string[] = [];
    const check = (bytes: Uint8Array) => toHex(sha256(bytes)) === toHex(ref.contentHash);

    if (this.customFetch) {
      try {
        const bytes = await this.customFetch(ref);
        if (check(bytes)) return bytes;
        errors.push('custom source: content hash mismatch');
      } catch (err) {
        errors.push(`custom source: ${(err as Error).message}`);
      }
    }

    const chunk = await this.chunks([ref.id]).then((c) => c[0]).catch(() => null);
    for (const url of await this.endpointsFor(chunk)) {
      try {
        const response = await fetch(`${url}/chunk/${ref.id}/data`, { signal: AbortSignal.timeout(this.nodeTimeoutMs) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (check(bytes)) return bytes;
        errors.push(`${url}: content hash mismatch`);
      } catch (err) {
        errors.push(`${url}: ${(err as Error).message}`);
      }
    }

    if (this.ledgerFallback && ledger) {
      try {
        const fromBlock = Number(chunk ? chunk.openedBlock : record.createdBlock);
        return await readChunkFromLedger(this.provider, this.contractAddress, ref.id, ref.contentHash, fromBlock, {
          segmentsTotal: chunk?.segmentsTotal || undefined,
          toBlock: chunk && chunk.completedBlock > 0n ? Number(chunk.completedBlock) : undefined,
        });
      } catch (err) {
        errors.push(`ledger: ${(err as Error).message}`);
      }
    }
    throw new Error(`Chunk ${ref.id} unavailable: ${errors.join('; ')}`);
  }

  /** Configured nodes first, then the replicators that confirmed this chunk */
  private async endpointsFor(chunk: ChunkAccount | null): Promise<string[]> {
    const urls = [...this.nodeUrls];
    const confirmed = chunk?.replicators ?? [];
    const unknown = confirmed.filter((r) => !this.endpoints.has(r.toLowerCase()));
    if (unknown.length > 0) {
      const infos = await Promise.all(unknown.map((r) => this.contract.getReplicator(r).then((raw: unknown) => decodeReplicator(raw, r)).catch(() => null)));
      unknown.forEach((r, i) => {
        const info = infos[i];
        this.endpoints.set(r.toLowerCase(), info && info.active ? info.endpoint.replace(/\/$/, '') : null);
      });
    }
    for (const r of confirmed) {
      const url = this.endpoints.get(r.toLowerCase());
      if (url && !urls.includes(url)) urls.push(url);
    }
    // closed chunk (or no confirmation yet): any active replicator may hold it
    if (!chunk || confirmed.length === 0) {
      if (!this.activeEndpoints || Date.now() - this.activeEndpoints.at > 60_000) {
        const all = await this.replicators().catch(() => []);
        this.activeEndpoints = { urls: all.filter((r) => r.active).map((r) => r.endpoint.replace(/\/$/, '')), at: Date.now() };
      }
      for (const url of this.activeEndpoints.urls) if (!urls.includes(url)) urls.push(url);
    }
    return urls;
  }

  /**
   * Send a direct chunk to up to `replicas` nodes (PUT /chunk/:id/data; the
   * node checks it against the on-chain hash, stores it and confirms).
   * Returns the nodes that took it; throws when none did.
   */
  private async pushDirect(ref: ChunkRef, data: Uint8Array, targets: string[], replicas: number): Promise<string[]> {
    if (this.customPush) {
      await this.customPush(ref, data);
      return [];
    }
    const errors: string[] = [];
    const accepted: string[] = [];
    for (const url of targets) {
      if (accepted.length >= replicas) break;
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await fetch(`${url}/chunk/${ref.id}/data`, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            body: data as BodyInit,
            signal: AbortSignal.timeout(Math.max(this.nodeTimeoutMs, 120_000)),
          });
          // 404: the node's RPC has not seen the upload transaction yet
          if (response.status === 404 && attempt < 5) {
            await sleep(1_000 * (attempt + 1));
            continue;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
          accepted.push(url);
        } catch (err) {
          errors.push(`${url}: ${(err as Error).message}`);
        }
        break;
      }
    }
    if (accepted.length === 0) {
      throw new Error(`No node accepted chunk ${ref.id} (${errors.join('; ')}). Its deposit can be reclaimed after 10 minutes (reclaimAllDeposits).`);
    }
    return accepted;
  }

  /**
   * Send the session key's remaining MON back to the wallet.  Monad lets an
   * account go under its 10 MON reserve only with an "emptying" transaction,
   * sent after `k` blocks without other transactions from it, so wait first.
   * Returns the gas it paid.
   */
  private async sweep(session: Wallet): Promise<bigint> {
    const start = await this.provider.getBlockNumber();
    while ((await this.provider.getBlockNumber()) < start + SWEEP_QUIET_BLOCKS) await sleep(400);
    const [balance, fee] = await Promise.all([this.provider.getBalance(session.address), this.provider.getFeeData()]);
    const maxFee = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    const priority = fee.maxPriorityFeePerGas ?? 0n;
    const cost = GAS.tx * maxFee;
    if (balance <= cost) return 0n;
    const me = await this.address();
    const result = await this.sender.send({
      signer: session,
      to: me,
      data: '0x',
      value: balance - cost,
      gasLimit: GAS.tx,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priority < maxFee ? priority : maxFee,
      label: 'return session funds',
    });
    return result.fee;
  }

  private encryptedChunkSizes(size: number, chunkSize: number): number[] {
    const sizes: number[] = [];
    for (let offset = 0; offset < size || sizes.length === 0; offset += chunkSize) {
      sizes.push(Math.min(chunkSize, size - offset) + ENCRYPTION_OVERHEAD);
    }
    return sizes;
  }

  /** Chunks a manifest can list inline before it needs an index chunk */
  private inlineChunkLimit(): number {
    return 16;
  }
}

export { MonaDBTransactionError };
