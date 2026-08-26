import { Entity, Enum, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { FailureCode } from '../../../../shared/domain/failure-code';
import { WalletEntity } from './wallet.entity';

@Entity({ tableName: 'wager_transactions' })
@Unique({ name: 'wager_tx_idempotency_key_unique', properties: ['idempotencyKey'] })
@Unique({ name: 'wager_tx_provider_external_unique', properties: ['providerId', 'externalTransactionId'] })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 255, fieldName: 'provider_id' })
  providerId!: string;

  @Property({ type: 'string', length: 255, fieldName: 'external_transaction_id' })
  externalTransactionId!: string;

  @Property({ type: 'string', length: 512, fieldName: 'idempotency_key' })
  idempotencyKey!: string;

  @Property({ type: 'string', length: 128, fieldName: 'payload_hash' })
  payloadHash!: string;

  @ManyToOne(() => WalletEntity, { fieldName: 'wallet_id' })
  wallet!: WalletEntity;

  @Property({ type: 'uuid', fieldName: 'player_id' })
  playerId!: string;

  @Property({ type: 'string', length: 255, fieldName: 'round_id' })
  roundId!: string;

  @Property({ type: 'string', length: 255, fieldName: 'game_id' })
  gameId!: string;

  @Enum(() => WagerTransactionKind)
  kind!: WagerTransactionKind;

  @Property({ type: 'decimal', precision: 19, scale: 2, fieldName: 'money_amount' })
  moneyAmount!: string;

  @Property({ type: 'string', length: 3, fieldName: 'money_currency' })
  moneyCurrency!: string;

  @Property({ type: 'string', length: 255, fieldName: 'reference_external_transaction_id', nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ type: 'datetime', fieldName: 'created_at' })
  createdAt!: Date;

  @Enum(() => WagerTransactionStatus)
  status!: WagerTransactionStatus;

  /** Self-reference: a transação (de reversão) que resolveu esta referência. */
  @ManyToOne(() => WagerTransactionEntity, { fieldName: 'reference_transaction_id', nullable: true })
  referenceTransaction?: WagerTransactionEntity;

  @Enum({ items: () => FailureCode, nullable: true, fieldName: 'failure_code' })
  failureCode?: FailureCode;

  @Property({ type: 'datetime', fieldName: 'processed_at', nullable: true })
  processedAt?: Date;

  @Property({ type: 'integer', fieldName: 'reference_retry_count' })
  referenceRetryCount!: number;

  @Property({ type: 'datetime', fieldName: 'next_reference_check_at', nullable: true })
  nextReferenceCheckAt?: Date;
}
