import { Type } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from './money.dto';

/**
 * Subconjunto de WagerTransactionKind submetível via API/fila — OPENING é interno e nunca aparece
 * aqui (seção 6.3 do desafio: "não pode ser submetido pela API nem pela fila").
 */
export enum SubmittableWagerTransactionKind {
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export class ProcessWagerTransactionDto {
  @ApiProperty({ example: 'provider-a' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  providerId!: string;

  @ApiProperty({ example: 'tx-1', description: 'Chave da transação no sistema do provedor.' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  externalTransactionId!: string;

  @ApiProperty({ example: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1' })
  @IsUUID()
  playerId!: string;

  @ApiProperty({ example: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2' })
  @IsUUID()
  walletId!: string;

  @ApiProperty({ example: 'round-1' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  roundId!: string;

  @ApiProperty({ example: 'fortune-chimp' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  gameId!: string;

  @ApiProperty({ enum: SubmittableWagerTransactionKind, example: SubmittableWagerTransactionKind.Bet })
  @IsEnum(SubmittableWagerTransactionKind)
  kind!: SubmittableWagerTransactionKind;

  @ApiProperty({ type: MoneyDto })
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @ApiProperty({
    required: false,
    example: 'tx-1',
    description: 'Obrigatório para REFUND/ROLLBACK — externalTransactionId da transação referenciada.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  referenceExternalTransactionId?: string;
}
