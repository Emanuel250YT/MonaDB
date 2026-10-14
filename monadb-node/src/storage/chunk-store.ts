/**
 * Raw chunk bytes, keyed by chunk id (0x + 64 hex).  Implemented by
 * RocksDBService (production), S3ChunkStore (any S3-compatible object store)
 * and FsChunkStore (development, no native module).
 */
export interface ChunkStore {
  putChunk(chunkId: string, data: Buffer): Promise<void>;
  /** null when the chunk is not stored */
  getChunk(chunkId: string): Promise<Buffer | null>;
  hasChunk(chunkId: string): Promise<boolean>;
  deleteChunk(chunkId: string): Promise<void>;
  listChunkIds(): Promise<string[]>;
}

/** Nest injection token for the configured ChunkStore (CHUNK_STORE) */
export const CHUNK_STORE = Symbol('CHUNK_STORE');

/** A chunk or blob id: keccak256 output, 0x + 64 hex characters */
export const ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function isChunkId(value: string): boolean {
  return typeof value === 'string' && ID_PATTERN.test(value);
}
