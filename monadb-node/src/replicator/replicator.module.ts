import { Module } from '@nestjs/common';
import { MonadModule } from '../monad/monad.module';
import { StorageModule } from '../storage/storage.module';
import { ReplicatorService } from './replicator.service';

@Module({
  imports: [MonadModule, StorageModule],
  providers: [ReplicatorService],
  exports: [ReplicatorService],
})
export class ReplicatorModule { }
