import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import configuration from './configuration';

const STORAGE_ENV = [
  'CHUNK_STORE', 'METADATA_STORE', 'BLOB_STORE', 'DATA_DIR', 'ROCKSDB_PATH', 'BLOB_DIR', 'BLOB_STAGING_DIR',
  'S3_BUCKET', 'S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_PREFIX',
  'S3_FORCE_PATH_STYLE', 'S3_CREATE_BUCKET', 'S3_MULTIPART_THRESHOLD', 'S3_PART_SIZE', 'S3_UPLOAD_CONCURRENCY',
  'DATABASE_URL', 'PG_SCHEMA', 'PG_POOL_MAX',
];
const MONAD_ENV = [
  'MONAD_NETWORK', 'MONAD_RPC_URL', 'MONAD_CHAIN_ID', 'MONADB_CONTRACT', 'MONADB_DEPLOYMENT', 'LOGS_BLOCK_RANGE',
  'GAS_LIMIT_BUFFER_PCT', 'MAX_CONFIRMATIONS_PER_TX', 'MIN_REWARD_WEI', 'BLOB_CLAIM_MIN_WEI', 'REPLICATE_OWNERS',
];

describe('configuration', () => {
  const saved = { ...process.env };
  // The machine's own settings must not leak into the expectations
  const clean = Object.fromEntries(Object.entries(saved).filter(([key]) => !STORAGE_ENV.includes(key) && !MONAD_ENV.includes(key)));
  const withEnv = (env: Record<string, string>) => {
    process.env = { ...clean, ...env };
    return configuration();
  };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to Monad testnet and the production stores', () => {
    const config = withEnv({});
    expect(config.monad).toMatchObject({
      network: 'testnet',
      rpcUrl: 'https://testnet-rpc.monad.xyz',
      chainId: 10143,
      contract: '',
      logsBlockRange: 100,
      gasBufferPct: 15,
      maxConfirmationsPerTx: 8,
    });
    expect(config.replication.minRewardWei).toBe(0n);
    expect(config.blobs.claimMinWei).toBe(5n * 10n ** 16n);
    expect(config.storage).toMatchObject({ chunkStore: 'rocksdb', metadataStore: 'oracle', blobStore: 'fs', dataDir: './data' });
    expect(config.blobs.dir.replace(/\\/g, '/')).toBe('data/blobs');
    expect(config.blobs.stagingDir.replace(/\\/g, '/')).toBe('data/blobs-staging');
    expect(config.s3).toMatchObject({
      bucket: '',
      endpoint: '',
      region: 'us-east-1',
      prefix: '',
      forcePathStyle: false,
      createBucket: false,
      multipartThreshold: 64 * 1024 * 1024,
      partSize: 16 * 1024 * 1024,
      uploadConcurrency: 4,
    });
    expect(config.postgres).toEqual({ url: '', schema: '', poolMax: 10 });
    expect(config.oracle.user).toBe('monadb');
    expect(config.replication.owners).toEqual([]);
  });

  it('parses wei amounts, booleans and owner lists (checksummed)', () => {
    const config = withEnv({
      MIN_REWARD_WEI: '25000000000000000',
      BLOB_CLAIM_MIN_WEI: '1000',
      UPDATE_ENDPOINT_ON_START: 'true',
      REPLICATE_OWNERS: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8, 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      MONADB_CONTRACT: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
      CHUNK_STORE: 'fs',
      METADATA_STORE: 'file',
      DATA_DIR: '/var/monadb',
    });
    expect(config.replication.minRewardWei).toBe(25_000_000_000_000_000n);
    expect(config.blobs.claimMinWei).toBe(1_000n);
    expect(config.replication.updateEndpointOnStart).toBe(true);
    expect(config.replication.owners).toEqual(['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC']);
    expect(config.monad.contract).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3');
    expect(config.storage).toMatchObject({ chunkStore: 'fs', metadataStore: 'file', blobStore: 'fs' });
    expect(config.rocksdb.path.replace(/\\/g, '/')).toBe('/var/monadb/rocksdb');
    expect(config.blobs.dir.replace(/\\/g, '/')).toBe('/var/monadb/blobs');
  });

  it('reads the network from MONADB_DEPLOYMENT, overridden by the MONAD_* variables', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monadb-config-'));
    const file = path.join(dir, 'monad-localnet.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ network: 'localnet', chainId: 31337, rpcUrl: 'http://127.0.0.1:8545', contract: '0x5fbdb2315678afecb367f032d93f642f64180aa3' }),
    );
    try {
      expect(withEnv({ MONADB_DEPLOYMENT: file }).monad).toMatchObject({
        network: 'localnet',
        chainId: 31337,
        rpcUrl: 'http://127.0.0.1:8545',
        contract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      });
      expect(withEnv({ MONADB_DEPLOYMENT: file, MONAD_RPC_URL: 'http://127.0.0.1:8546', MONAD_CHAIN_ID: '1' }).monad).toMatchObject({
        rpcUrl: 'http://127.0.0.1:8546',
        chainId: 1,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the S3 and Postgres settings; blobs follow CHUNK_STORE=s3', () => {
    const config = withEnv({
      CHUNK_STORE: 's3',
      METADATA_STORE: 'postgres',
      S3_BUCKET: 'monadb',
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'auto',
      S3_PREFIX: '/node-1',
      S3_FORCE_PATH_STYLE: 'true',
      S3_CREATE_BUCKET: '1',
      S3_PART_SIZE: String(8 * 1024 * 1024),
      DATABASE_URL: 'postgres://monadb@db/monadb',
      PG_SCHEMA: 'node_1',
      BLOB_DIR: '/mnt/big',
    });
    expect(config.storage).toMatchObject({ chunkStore: 's3', metadataStore: 'postgres', blobStore: 's3' });
    expect(config.s3).toMatchObject({
      bucket: 'monadb',
      endpoint: 'http://minio:9000',
      region: 'auto',
      prefix: 'node-1/',
      forcePathStyle: true,
      createBucket: true,
      partSize: 8 * 1024 * 1024,
    });
    expect(config.postgres).toMatchObject({ url: 'postgres://monadb@db/monadb', schema: 'node_1' });
    expect(config.blobs.dir).toBe('/mnt/big');

    expect(withEnv({ CHUNK_STORE: 's3', S3_BUCKET: 'b', BLOB_STORE: 'fs' }).storage.blobStore).toBe('fs');
    expect(withEnv({ BLOB_STORE: 's3', S3_BUCKET: 'b' }).storage).toMatchObject({ chunkStore: 'rocksdb', blobStore: 's3' });
  });

  it('fails fast on invalid values', () => {
    expect(() => withEnv({ MONADB_CONTRACT: 'nope' })).toThrow('MONADB_CONTRACT');
    expect(() => withEnv({ MONADB_DEPLOYMENT: path.join(os.tmpdir(), 'monadb-missing.json') })).toThrow('MONADB_DEPLOYMENT');
    expect(() => withEnv({ MONAD_CHAIN_ID: 'ten' })).toThrow('MONAD_CHAIN_ID');
    expect(() => withEnv({ CHUNK_STORE: 'leveldb' })).toThrow('CHUNK_STORE');
    expect(() => withEnv({ METADATA_STORE: 'mysql' })).toThrow('METADATA_STORE');
    expect(() => withEnv({ BLOB_STORE: 'rocksdb' })).toThrow('BLOB_STORE');
    expect(() => withEnv({ CHUNK_STORE: 's3' })).toThrow('S3_BUCKET');
    expect(() => withEnv({ BLOB_STORE: 's3' })).toThrow('S3_BUCKET');
    expect(() => withEnv({ S3_PART_SIZE: '1048576' })).toThrow('S3_PART_SIZE');
    expect(() => withEnv({ PG_SCHEMA: 'Bad-Schema' })).toThrow('PG_SCHEMA');
    expect(() => withEnv({ POLL_INTERVAL_MS: 'soon' })).toThrow('POLL_INTERVAL_MS');
    expect(() => withEnv({ MIN_REWARD_WEI: '0.5' })).toThrow('MIN_REWARD_WEI');
    expect(() => withEnv({ REPLICATE_OWNERS: 'not-an-address' })).toThrow('REPLICATE_OWNERS');
  });
});
