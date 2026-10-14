import { Module } from '@nestjs/common';
import { MonadService } from './monad.service';

@Module({
  providers: [MonadService],
  exports: [MonadService],
})
export class MonadModule { }
