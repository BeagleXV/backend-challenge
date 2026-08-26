import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { Money } from '../../../../shared/domain/money';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity';

export function walletLedgerEntryToDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: entity.id,
    walletId: entity.wallet.id,
    transactionId: entity.transaction.id,
    direction: entity.direction,
    money: Money.from({ amount: entity.moneyAmount, currency: entity.moneyCurrency }),
    balanceBefore: Money.from({
      amount: entity.balanceBeforeAmount,
      currency: entity.balanceBeforeCurrency,
    }),
    balanceAfter: Money.from({
      amount: entity.balanceAfterAmount,
      currency: entity.balanceAfterCurrency,
    }),
    createdAt: entity.createdAt,
  });
}

/** O ledger é write-once: só existe a construção da entidade nova, nunca uma sincronização de update. */
export function walletLedgerEntryToNewEntity(
  entry: WalletLedgerEntry,
  walletRef: WalletLedgerEntryEntity['wallet'],
  transactionRef: WalletLedgerEntryEntity['transaction'],
): WalletLedgerEntryEntity {
  const entity = new WalletLedgerEntryEntity();
  entity.id = entry.id;
  entity.wallet = walletRef;
  entity.transaction = transactionRef;
  entity.direction = entry.direction;
  entity.moneyAmount = entry.money.toJSON().amount;
  entity.moneyCurrency = entry.money.currency;
  entity.balanceBeforeAmount = entry.balanceBefore.toJSON().amount;
  entity.balanceBeforeCurrency = entry.balanceBefore.currency;
  entity.balanceAfterAmount = entry.balanceAfter.toJSON().amount;
  entity.balanceAfterCurrency = entry.balanceAfter.currency;
  entity.createdAt = entry.createdAt;
  return entity;
}
