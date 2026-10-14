import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAddress } from 'ethers';
import { StorageService } from '../storage/storage.service';
import { MonadService } from '../monad/monad.service';
import { PushResult, ReplicatorService } from '../replicator/replicator.service';
import { BlobService } from '../blobs/blob.service';
import { QueryDto } from './dto/query.dto';
import { chunkRecordFromAccount, ChunkRecord } from '../storage/metadata-store';
import { isChunkId } from '../storage/chunk-store';

export type ChunkMeta = Omit<ChunkRecord, 'storedAt'> & {
  storedAt: Date | null;
  /** `local`: this node stores the chunk; `chain`: read from the contract */
  source: 'local' | 'chain';
};

@Injectable()
export class QueryService {
  constructor(
    private readonly storage: StorageService,
    private readonly monad: MonadService,
    private readonly replicator: ReplicatorService,
    private readonly blobs: BlobService,
    private readonly config: ConfigService,
  ) { }

  /**
   * JSON query — returns metadata records matching the filter.  Owners are
   * stored checksummed and ids lower case, so filters match in any case.
   */
  async query(dto: QueryDto): Promise<ChunkRecord[]> {
    const filter = dto.filter ? { ...dto.filter } : undefined;
    if (filter?.owner) filter.owner = getAddress(filter.owner.toLowerCase());
    if (filter?.chunkId) filter.chunkId = filter.chunkId.toLowerCase();
    return this.storage.queryChunks({
      filter,
      orderBy: dto.orderBy,
      order: dto.order,
      limit: dto.limit,
      offset: dto.offset,
    });
  }

  /**
   * Retrieve raw chunk bytes from the local chunk store.  Readers verify them
   * against the content hash in their manifest.
   */
  async getChunkData(chunkId: string): Promise<Buffer> {
    const id = this._chunkId(chunkId);
    const raw = await this.storage.getRawChunk(id);
    if (!raw) {
      throw new NotFoundException(
        `Chunk ${id} not found on this node. ` +
        `Query the network for a replicator that holds it.`,
      );
    }
    return raw;
  }

  /**
   * A direct chunk pushed by its uploader: the replicator checks it against
   * the on-chain chunk, stores it and confirms it.
   */
  async pushChunkData(chunkId: string, body: unknown): Promise<PushResult> {
    const id = this._chunkId(chunkId);
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new BadRequestException('Send the chunk bytes as an application/octet-stream body');
    }
    return this.replicator.acceptPush(id, body);
  }

  /**
   * Get chunk metadata — tries the local store first, then the contract.
   */
  async getChunkMeta(chunkId: string): Promise<ChunkMeta> {
    const id = this._chunkId(chunkId);
    const local = await this.storage.getChunkMeta(id);
    if (local) return { ...local, source: 'local' };

    const onChain = await this.monad.getChunk(id).catch(() => null);
    if (!onChain) {
      throw new NotFoundException(`Chunk ${id} not found`);
    }
    return { ...chunkRecordFromAccount(id, onChain.data), storedAt: null, source: 'chain' };
  }

  /**
   * Health/status of this replicator node.  The SDK picks upload targets
   * from it: `registered`, `active` and `contract` must match.
   */
  async getNodeStatus(): Promise<Record<string, unknown>> {
    const [block, balance, replicator, storedChunks] = await Promise.all([
      this.monad.getBlockNumber(),
      this.monad.getBalance(),
      this.monad.getReplicator(),
      this.storage.countChunks(),
    ]);
    return {
      status: 'ok',
      ...this.monad.network,
      block,
      replicator: this.monad.address,
      registered: replicator !== null,
      active: replicator?.active ?? false,
      // On-chain endpoint vs the one this node is configured with
      endpoint: replicator?.endpoint ?? null,
      nodeEndpoint: this.config.get<string>('replication.nodeEndpoint'),
      confirmations: replicator ? Number(replicator.confirmations) : 0,
      // wei amounts as strings (JSON has no bigint)
      weiEarned: (replicator?.earned ?? 0n).toString(),
      balanceWei: balance.toString(),
      storage: { ...this.storage.drivers, chunks: storedChunks },
      scan: this.replicator.status,
      blobs: this.blobs.status,
    };
  }

  /** A chunk id (0x + 64 hex), lower case: the chunk store key */
  private _chunkId(chunkId: string): string {
    if (!isChunkId(chunkId)) {
      throw new BadRequestException(`"${chunkId}" is not a chunk id (0x + 64 hex characters)`);
    }
    return chunkId.toLowerCase();
  }
}
