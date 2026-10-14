import {
  IsOptional,
  IsString,
  IsNumber,
  IsIn,
  Matches,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CHUNK_STATES, ORDER_BY_FIELDS } from '../../storage/metadata-store';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CHUNK_ID = /^0x[0-9a-fA-F]{64}$/;

export class QueryFilterDto {
  @ApiPropertyOptional({ description: 'Filter by uploader wallet (0x address, any case)' })
  @IsOptional()
  @IsString()
  @Matches(EVM_ADDRESS, { message: 'owner must be a 0x address' })
  owner?: string;

  @ApiPropertyOptional({ enum: CHUNK_STATES, description: 'Replication state' })
  @IsOptional()
  @IsIn(CHUNK_STATES)
  state?: 'Pending' | 'Hot' | 'Cool' | 'Closed';

  @ApiPropertyOptional({ description: 'Exact chunk id (0x + 64 hex)' })
  @IsOptional()
  @IsString()
  @Matches(CHUNK_ID, { message: 'chunkId must be 0x + 64 hex characters' })
  chunkId?: string;

  @ApiPropertyOptional({ description: 'sha256 of the chunk bytes (64 hex chars)' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-fA-F]{64}$/, { message: 'contentHash must be 64 hex characters' })
  contentHash?: string;
}

export class QueryDto {
  @ApiPropertyOptional({ type: QueryFilterDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => QueryFilterDto)
  filter?: QueryFilterDto;

  @ApiPropertyOptional({
    enum: ORDER_BY_FIELDS,
    default: 'uploadedAt',
  })
  @IsOptional()
  @IsString()
  @IsIn(ORDER_BY_FIELDS)
  orderBy?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 1000 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1000)
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  offset?: number;
}
