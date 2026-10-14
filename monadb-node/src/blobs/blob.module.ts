import { Module } from '@nestjs/common';
import { MonadModule } from '../monad/monad.module';
import { StorageModule } from '../storage/storage.module';
import { BlobController } from './blob.controller';
import { BlobService } from './blob.service';

@Module({
  imports: [MonadModule, StorageModule],
  providers: [BlobService],
  controllers: [BlobController],
  exports: [BlobService],
})
export class BlobModule {}
