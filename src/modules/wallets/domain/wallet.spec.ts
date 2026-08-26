import { describe, expect, it } from 'bun:test';
import { Wallet } from './wallet';
import { Money } from '../../../shared/domain/money';
import { CurrencyMismatchError } from '../../../shared/domain/errors';
import { InsufficientBalanceError } from './errors';
import { LedgerDirection } from './wallet-ledger-entry';

const NOW = new Date('2026-08-26T12:00:00.000Z');

function openWallet(initial = '100.00') {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({ amount: initial, currency: 'BRL' }),
    createdAt: NOW,
  });
}

describe('Wallet', () => {
  it('opens with version 1, regardless of initial balance', () => {
    const wallet = openWallet('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('1000.00');
  });

  it('debits the balance and increments version', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit({
      entryId: 'entry-1',
      transactionId: 'tx-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      at: NOW,
    });

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('credits the balance and increments version', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.credit({
      entryId: 'entry-1',
      transactionId: 'tx-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      at: NOW,
    });

    expect(wallet.balance.toJSON().amount).toBe('125.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  it('rejects a debit that would make the balance negative', () => {
    const wallet = openWallet('100.00');
    expect(() =>
      wallet.debit({
        entryId: 'entry-1',
        transactionId: 'tx-1',
        money: Money.from({ amount: '150.00', currency: 'BRL' }),
        at: NOW,
      }),
    ).toThrow(InsufficientBalanceError);

    // saldo e version não devem ter mudado
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('allows a debit that exactly zeroes the balance', () => {
    const wallet = openWallet('100.00');
    wallet.debit({
      entryId: 'entry-1',
      transactionId: 'tx-1',
      money: Money.from({ amount: '100.00', currency: 'BRL' }),
      at: NOW,
    });
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('rejects debit/credit in a different currency', () => {
    const wallet = openWallet('100.00');
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => wallet.debit({ entryId: 'e1', transactionId: 't1', money: usd, at: NOW })).toThrow(
      CurrencyMismatchError,
    );
    expect(() => wallet.credit({ entryId: 'e1', transactionId: 't1', money: usd, at: NOW })).toThrow(
      CurrencyMismatchError,
    );
  });

  it('the mandatory concurrency scenario: two 80.00 debits against a 100.00 balance, applied sequentially', () => {
    // A serialização real (SELECT FOR UPDATE) acontece na camada de infraestrutura;
    // aqui validamos que a segunda operação, quando efetivamente aplicada depois da
    // primeira, é rejeitada e o estado final bate com o esperado.
    const wallet = openWallet('100.00');
    const eighty = Money.from({ amount: '80.00', currency: 'BRL' });

    const firstEntry = wallet.debit({ entryId: 'e1', transactionId: 't1', money: eighty, at: NOW });
    expect(firstEntry).toBeDefined();
    expect(wallet.balance.toJSON().amount).toBe('20.00');

    expect(() => wallet.debit({ entryId: 'e2', transactionId: 't2', money: eighty, at: NOW })).toThrow(
      InsufficientBalanceError,
    );
    expect(wallet.balance.toJSON().amount).toBe('20.00');
  });

  it('rehydrates without revalidating', () => {
    const rehydrated = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: Money.from({ amount: '42.00', currency: 'BRL' }),
      version: 7,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(rehydrated.balance.toJSON().amount).toBe('42.00');
    expect(rehydrated.version).toBe(7);
  });
});
