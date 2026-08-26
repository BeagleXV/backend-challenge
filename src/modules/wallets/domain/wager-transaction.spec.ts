import { describe, expect, it } from 'bun:test';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';
import { Money } from '../../../shared/domain/money';
import { FailureCode } from '../../../shared/domain/failure-code';
import { InvalidTransactionStateError, MissingReferenceError } from './errors';
import { LedgerDirection } from './wallet-ledger-entry';

const NOW = new Date('2026-08-26T12:00:00.000Z');

function createTx(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    createdAt: NOW,
    ...overrides,
  });
}

describe('WagerTransaction', () => {
  it('is born PENDING', () => {
    expect(createTx().status).toBe(WagerTransactionStatus.Pending);
  });

  it('requires a reference for REFUND and ROLLBACK', () => {
    expect(() => createTx({ kind: WagerTransactionKind.Refund })).toThrow(MissingReferenceError);
    expect(() => createTx({ kind: WagerTransactionKind.Rollback })).toThrow(MissingReferenceError);
  });

  it('accepts REFUND/ROLLBACK with a reference', () => {
    const tx = createTx({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-0',
    });
    expect(tx.requiresReference()).toBe(true);
  });

  it('transitions to PROCESSED and becomes terminal', () => {
    const tx = createTx();
    tx.markProcessed(undefined, NOW);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toEqual(NOW);
    expect(tx.isTerminal()).toBe(true);
  });

  it('transitions to REJECTED with a failureCode and becomes terminal', () => {
    const tx = createTx();
    tx.reject(FailureCode.InsufficientBalance);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(tx.isTerminal()).toBe(true);
  });

  it('transitions to FAILED with a failureCode and becomes terminal', () => {
    const tx = createTx();
    tx.fail(FailureCode.ValidationError);
    expect(tx.status).toBe(WagerTransactionStatus.Failed);
    expect(tx.isTerminal()).toBe(true);
  });

  it('transitions to PENDING_REFERENCE and is not terminal', () => {
    const tx = createTx({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-0',
    });
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.isTerminal()).toBe(false);
  });

  it('throws when transitioning out of a terminal state', () => {
    const tx = createTx();
    tx.markProcessed(undefined, NOW);
    expect(() => tx.reject(FailureCode.InsufficientBalance)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markProcessed(undefined, NOW)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  it('affectsBalance is false only for LOSS', () => {
    expect(createTx({ kind: WagerTransactionKind.Bet }).affectsBalance()).toBe(true);
    expect(createTx({ kind: WagerTransactionKind.Win }).affectsBalance()).toBe(true);
    expect(createTx({ kind: WagerTransactionKind.Loss }).affectsBalance()).toBe(false);
  });

  it('matchesPayload compares the stored payloadHash', () => {
    const tx = createTx({ payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('xyz')).toBe(false);
  });

  it('ledgerDirectionFor: BET is DEBIT, WIN/REFUND/OPENING are CREDIT', () => {
    expect(createTx({ kind: WagerTransactionKind.Bet }).ledgerDirectionFor()).toBe(
      LedgerDirection.Debit,
    );
    expect(createTx({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    expect(
      createTx({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-0',
      }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
    expect(createTx({ kind: WagerTransactionKind.Opening }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
  });

  it('ledgerDirectionFor: ROLLBACK inverts the referenced transaction direction', () => {
    const bet = createTx({ kind: WagerTransactionKind.Bet });
    const rollbackOfBet = createTx({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-0',
    });
    expect(rollbackOfBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);

    const win = createTx({ kind: WagerTransactionKind.Win });
    const rollbackOfWin = createTx({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-0',
    });
    expect(rollbackOfWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  it('ledgerDirectionFor: ROLLBACK without a reference throws', () => {
    const rollback = createTx({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-0',
    });
    expect(() => rollback.ledgerDirectionFor()).toThrow(MissingReferenceError);
  });

  it('ledgerDirectionFor: LOSS throws (never produces a ledger entry)', () => {
    expect(() => createTx({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor()).toThrow(
      InvalidTransactionStateError,
    );
  });

  it('scheduleReferenceRetry increments the count and schedules a future check with backoff', () => {
    const tx = createTx({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ext-0' });
    tx.markPendingReference();

    expect(tx.referenceRetryCount).toBe(0);
    expect(tx.nextReferenceCheckAt).toBeUndefined();

    tx.scheduleReferenceRetry(NOW);
    expect(tx.referenceRetryCount).toBe(1);
    expect(tx.nextReferenceCheckAt!.getTime()).toBeGreaterThan(NOW.getTime());

    const firstDelay = tx.nextReferenceCheckAt!.getTime() - NOW.getTime();
    tx.scheduleReferenceRetry(NOW);
    const secondDelay = tx.nextReferenceCheckAt!.getTime() - NOW.getTime();
    expect(secondDelay).toBeGreaterThan(firstDelay);
  });

  it('hasExceededReferenceRetries becomes true only after the configured max attempts', () => {
    const tx = createTx({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ext-0' });
    tx.markPendingReference();
    for (let i = 0; i < 9; i++) {
      tx.scheduleReferenceRetry(NOW);
      expect(tx.hasExceededReferenceRetries()).toBe(false);
    }
    tx.scheduleReferenceRetry(NOW);
    expect(tx.hasExceededReferenceRetries()).toBe(true);
  });

  it('scheduleReferenceRetry throws once the transaction is terminal', () => {
    const tx = createTx();
    tx.markProcessed(undefined, NOW);
    expect(() => tx.scheduleReferenceRetry(NOW)).toThrow(InvalidTransactionStateError);
  });

  it('rehydrates without revalidating reference requirements', () => {
    const tx = WagerTransaction.rehydrate({
      id: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'provider-a:ext-1',
      payloadHash: 'hash-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      referenceExternalTransactionId: undefined,
      createdAt: NOW,
      status: WagerTransactionStatus.Processed,
    });
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });
});
