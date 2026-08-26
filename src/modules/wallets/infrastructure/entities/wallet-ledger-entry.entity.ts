import { Entity, Enum, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { LedgerDirection } from '../../domain/wallet-ledger-entry';
import { WalletEntity } from './wallet.entity';
import { WagerTransactionEntity } from './wager-transaction.entity';

/**
 * Imutável por construção: nenhum setter é exposto além dos campos definidos na criação, e a
 * imutabilidade real (proteção contra UPDATE/DELETE mesmo por bug de aplicação) é reforçada por
 * trigger no schema — ver migration.
 */
@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ name: 'wallet_ledger_tx_wallet_unique', properties: ['transaction', 'wallet'] })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => WalletEntity, { fieldName: 'wallet_id' })
  wallet!: WalletEntity;

  @ManyToOne(() => WagerTransactionEntity, { fieldName: 'transaction_id' })
  transaction!: WagerTransactionEntity;

  @Enum(() => LedgerDirection)
  direction!: LedgerDirection;

  @Property({ type: 'decimal', precision: 19, scale: 2, fieldName: 'money_amount' })
  moneyAmount!: string;

  @Property({ type: 'string', length: 3, fieldName: 'money_currency' })
  moneyCurrency!: string;

  @Property({ type: 'decimal', precision: 19, scale: 2, fieldName: 'balance_before_amount' })
  balanceBeforeAmount!: string;

  @Property({ type: 'string', length: 3, fieldName: 'balance_before_currency' })
  balanceBeforeCurrency!: string;

  @Property({ type: 'decimal', precision: 19, scale: 2, fieldName: 'balance_after_amount' })
  balanceAfterAmount!: string;

  @Property({ type: 'string', length: 3, fieldName: 'balance_after_currency' })
  balanceAfterCurrency!: string;

  @Property({ type: 'datetime', fieldName: 'created_at' })
  createdAt!: Date;
}
