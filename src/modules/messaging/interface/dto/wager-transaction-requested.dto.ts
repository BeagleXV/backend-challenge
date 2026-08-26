import { Type } from 'class-transformer';
import { IsEnum, IsISO8601, IsOptional, IsString, IsUUID, MinLength, ValidateNested } from 'class-validator';
import { MoneyDto } from '../../../wallets/interface/dto/money.dto';
import { SubmittableWagerTransactionKind } from '../../../wallets/interface/dto/process-wager-transaction.dto';

/** Corpo de `data` da mensagem `WagerTransactionRequested` (seção 10 do desafio). */
export class WagerTransactionRequestedDataDto {
  @IsString()
  @MinLength(1)
  providerId!: string;

  @IsString()
  @MinLength(1)
  externalTransactionId!: string;

  @IsString()
  @MinLength(1)
  idempotencyKey!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @MinLength(1)
  roundId!: string;

  @IsString()
  @MinLength(1)
  gameId!: string;

  @IsEnum(SubmittableWagerTransactionKind)
  kind!: SubmittableWagerTransactionKind;

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @MinLength(1)
  referenceExternalTransactionId?: string;
}

/** Envelope completo da mensagem SQS (seção 10). */
export class WagerTransactionRequestedEnvelopeDto {
  @IsString()
  @MinLength(1)
  messageId!: string;

  @IsString()
  type!: string;

  @IsISO8601()
  occurredAt!: string;

  @ValidateNested()
  @Type(() => WagerTransactionRequestedDataDto)
  data!: WagerTransactionRequestedDataDto;
}
