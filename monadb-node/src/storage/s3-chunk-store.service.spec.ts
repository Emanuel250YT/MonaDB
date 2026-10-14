import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3ChunkStore } from './s3-chunk-store.service';
import { FakeS3, s3Error } from '../../test/fake-s3';

const BUCKET = 'monadb-test';
const A = '0x' + 'a1'.repeat(32);
const B = '0x' + 'b2'.repeat(32);
const IDS = ['0x' + '31'.repeat(32), '0x' + '4f'.repeat(32), '0x' + '9a'.repeat(32), '0x' + 'b0'.repeat(32), '0x' + 'cd'.repeat(32)];

describe('S3ChunkStore', () => {
  let fake: FakeS3;

  const open = async (s3: Record<string, unknown> = {}) => {
    const store = new S3ChunkStore(new ConfigService({ s3: { bucket: BUCKET, prefix: 'node-1/', ...s3 } }), fake.client);
    await store.onModuleInit();
    return store;
  };

  beforeAll(() => Logger.overrideLogger(false));

  beforeEach(() => {
    fake = new FakeS3(BUCKET);
  });

  it('stores one object per chunk under ${S3_PREFIX}chunks/', async () => {
    const store = await open();
    const data = Buffer.from('ciphertext bytes');
    await store.putChunk(A, data);

    expect(fake.keys(BUCKET)).toEqual([`node-1/chunks/${A}`]);
    expect(await store.getChunk(A)).toEqual(data);
    expect(await store.hasChunk(A)).toBe(true);
  });

  it('returns null / false for missing chunks', async () => {
    const store = await open();
    expect(await store.getChunk(B)).toBeNull();
    expect(await store.hasChunk(B)).toBe(false);
  });

  it('replaces a chunk that is written again; deleting twice is fine', async () => {
    const store = await open();
    await store.putChunk(A, Buffer.from('one'));
    await store.putChunk(A, Buffer.from('two'));
    expect(await store.getChunk(A)).toEqual(Buffer.from('two'));

    await store.deleteChunk(A);
    await store.deleteChunk(A);
    expect(await store.hasChunk(A)).toBe(false);
  });

  it('lists every chunk id across ListObjectsV2 pages, ignoring foreign objects', async () => {
    const store = await open({ listPageSize: 2 });
    for (const id of [...IDS].reverse()) await store.putChunk(id, Buffer.from(id));
    fake.objects.set(`${BUCKET}/node-1/chunks/not-a-chunk-id`, Buffer.from('x'));
    fake.objects.set(`${BUCKET}/node-1/blobs/${A}/0`, Buffer.from('a shard'));
    fake.objects.set(`${BUCKET}/node-2/chunks/${A}`, Buffer.from('another node'));

    expect(await store.listChunkIds()).toEqual([...IDS].sort());
    expect(fake.count('ListObjectsV2')).toBe(3);
    expect(fake.inputs('ListObjectsV2').every((input) => input.Prefix === 'node-1/chunks/' && input.MaxKeys === 2)).toBe(true);
  });

  it('works without a prefix', async () => {
    const store = await open({ prefix: '' });
    await store.putChunk(A, Buffer.from('a'));
    expect(fake.keys(BUCKET)).toEqual([`chunks/${A}`]);
    expect(await store.listChunkIds()).toEqual([A]);
  });

  it('rejects ids that are not 0x chunk ids', async () => {
    const store = await open();
    for (const bad of ['../../etc/passwd', 'chunks/x', '', 'a'.repeat(66), '0x' + 'a'.repeat(63)]) {
      await expect(store.putChunk(bad, Buffer.from('x'))).rejects.toThrow('Invalid chunk id');
      await expect(store.getChunk(bad)).rejects.toThrow('Invalid chunk id');
    }
    expect(fake.count('PutObject')).toBe(0);
  });

  it('checks the bucket at boot and creates it only with S3_CREATE_BUCKET', async () => {
    fake = new FakeS3();
    await expect(open()).rejects.toThrow('does not exist');
    await open({ createBucket: true });
    expect([...fake.buckets]).toEqual([BUCKET]);
    // a second store (blobs) racing for the same bucket
    fake.buckets.clear();
    fake.failNext('HeadBucket', s3Error('NotFound', 404));
    fake.buckets.add(BUCKET);
    await expect(open({ createBucket: true })).resolves.toBeDefined();
  });

  it('surfaces errors other than "not found"', async () => {
    const store = await open();
    fake.failNext('GetObject', s3Error('AccessDenied', 403));
    await expect(store.getChunk(A)).rejects.toThrow('AccessDenied');
    fake.failNext('HeadObject', s3Error('Forbidden', 403));
    await expect(store.hasChunk(A)).rejects.toThrow('Forbidden');
  });

  it('needs S3_BUCKET', async () => {
    const store = new S3ChunkStore(new ConfigService({ s3: {} }), fake.client);
    await expect(store.onModuleInit()).rejects.toThrow('S3_BUCKET');
  });
});
