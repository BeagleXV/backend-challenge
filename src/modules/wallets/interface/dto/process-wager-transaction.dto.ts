import { Type } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
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
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  providerId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  roundId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  gameId!: string;

  @IsEnum(SubmittableWagerTransactionKind)
  kind!: SubmittableWagerTransactionKind;

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  referenceExternalTransactionId?: string;
}
