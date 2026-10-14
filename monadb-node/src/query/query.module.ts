import { Module } from '@nestjs/common';
import { QueryController } from './query.controller';
import { QueryService } from './query.service';
import { StorageModule } from '../storage/storage.module';
import { MonadModule } from '../monad/monad.module';
import { BlobModule } from '../blobs/blob.module';
import { ReplicatorModule } from '../replicator/replicator.module';

@Module({
  imports: [StorageModule, MonadModule, ReplicatorModule, BlobModule],
  controllers: [QueryController],
  providers: [QueryService],
})
export class QueryModule { }
