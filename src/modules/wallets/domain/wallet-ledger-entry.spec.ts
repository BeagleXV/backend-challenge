import { describe, expect, it } from 'bun:test';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';
import { Money } from '../../../shared/domain/money';
import { UnbalancedLedgerEntryError } from './errors';

const NOW = new Date('2026-08-26T12:00:00.000Z');

describe('WalletLedgerEntry', () => {
  it('creates a balanced DEBIT entry', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '75.00', currency: 'BRL' }),
      createdAt: NOW,
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('creates a balanced CREDIT entry', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '125.00', currency: 'BRL' }),
      createdAt: NOW,
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects an unbalanced entry at creation time', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '80.00', currency: 'BRL' }), // deveria ser 75.00
        createdAt: NOW,
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('rehydrates without revalidating the arithmetic', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '125.00', currency: 'BRL' }),
      createdAt: NOW,
    });
    expect(entry.money.toJSON().amount).toBe('25.00');
  });
});
