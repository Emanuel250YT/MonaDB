import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FsChunkStore } from './fs-chunk-store.service';

const A = '0x' + 'a1'.repeat(32);
const B = '0x' + 'b2'.repeat(32);

describe('FsChunkStore', () => {
  let dataDir: string;
  let store: FsChunkStore;

  beforeAll(() => Logger.overrideLogger(false));

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monadb-fs-store-'));
    store = new FsChunkStore(new ConfigService({ storage: { dataDir } }));
    await store.onModuleInit();
  });

  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('stores one file per chunk under DATA_DIR/chunks', async () => {
    const data = Buffer.from('ciphertext bytes');
    await store.putChunk(A, data);

    expect(fs.readFileSync(path.join(dataDir, 'chunks', A))).toEqual(data);
    expect(await store.getChunk(A)).toEqual(data);
    expect(await store.hasChunk(A)).toBe(true);
    expect(await store.hasChunk(B)).toBe(false);
    expect(await store.getChunk(B)).toBeNull();
  });

  it('writes atomically and leaves no temporary files behind', async () => {
    await store.putChunk(A, Buffer.alloc(300_000, 7));
    await store.putChunk(B, Buffer.alloc(10, 1));
    expect(fs.readdirSync(path.join(dataDir, 'chunks')).sort()).toEqual([A, B].sort());
  });

  it('is idempotent and replaces a chunk that is written again', async () => {
    await store.putChunk(A, Buffer.from('one'));
    await store.putChunk(A, Buffer.from('one'));
    expect(await store.getChunk(A)).toEqual(Buffer.from('one'));
    await store.putChunk(A, Buffer.from('two'));
    expect(await store.getChunk(A)).toEqual(Buffer.from('two'));
  });

  it('lists and deletes chunks', async () => {
    await store.putChunk(B, Buffer.from('b'));
    await store.putChunk(A, Buffer.from('a'));
    expect(await store.listChunkIds()).toEqual([A, B].sort());

    await store.deleteChunk(A);
    await store.deleteChunk(A); // deleting twice is fine
    expect(await store.listChunkIds()).toEqual([B]);
  });

  it('rejects ids that are not 0x chunk ids (no path traversal)', async () => {
    for (const bad of ['../../etc/passwd', 'chunks/x', '', '0x' + 'g'.repeat(64), 'a'.repeat(66), '0x' + 'a'.repeat(65)]) {
      await expect(store.putChunk(bad, Buffer.from('x'))).rejects.toThrow('Invalid chunk id');
    }
    await expect(store.getChunk('..\\secret')).rejects.toThrow('Invalid chunk id');
  });

  it('removes temporary files left by an interrupted write on start', async () => {
    const leftover = path.join(dataDir, 'chunks', `${A}.123.abcd.tmp`);
    fs.writeFileSync(leftover, 'partial');
    await store.onModuleInit();
    expect(fs.existsSync(leftover)).toBe(false);
    expect(await store.listChunkIds()).toEqual([]);
  });
});
