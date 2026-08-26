import { beforeEach, describe, expect, it } from 'bun:test';
import {
  fakeEntityManager,
  fakeLogger,
  InMemoryInboxPort,
  InMemoryWagerTransactionRepository,
  InMemoryWalletLedgerEntryRepository,
  InMemoryWalletRepository,
  NoopOutboxPort,
} from '../support/fakes';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wallets/application/use-cases/process-wager-transaction.use-case';
import { IdempotencyConflictError, WalletNotFoundError } from '../../src/modules/wallets/application/errors';
import { MetricsService } from '../../src/modules/observability/metrics/metrics.service';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wallets/domain/wager-transaction';
import { Money } from '../../src/shared/domain/money';
import { FailureCode } from '../../src/shared/domain/failure-code';

/**
 * Unidade de verdade: `ProcessWagerTransactionUseCase` com repositórios fake em memória — sem
 * Postgres, sem containers. As mesmas regras de negócio (resolução de referência, idempotência) já
 * são exercitadas contra Postgres real nos testes de integração/concorrência; aqui o objetivo é
 * cobrir cada ramo de decisão isoladamente e rápido, como a seção 13 do desafio pede em "unidade":
 * "regras de BET, WIN, LOSS, REFUND, ROLLBACK" e "idempotency key com payload divergente".
 */
describe('ProcessWagerTransactionUseCase (unidade, fakes em memória)', () => {
  let wallets: InMemoryWalletRepository;
  let transactions: InMemoryWagerTransactionRepository;
  let ledger: InMemoryWalletLedgerEntryRepository;
  let outbox: NoopOutboxPort;
  let inbox: InMemoryInboxPort;
  let useCase: ProcessWagerTransactionUseCase;

  const NOW = new Date('2026-08-26T12:00:00.000Z');

  beforeEach(() => {
    wallets = new InMemoryWalletRepository();
    transactions = new InMemoryWagerTransactionRepository();
    ledger = new InMemoryWalletLedgerEntryRepository();
    outbox = new NoopOutboxPort();
    inbox = new InMemoryInboxPort();
    useCase = new ProcessWagerTransactionUseCase(
      fakeEntityManager(),
      wallets,
      transactions,
      ledger,
      outbox,
      inbox,
      new MetricsService(),
      fakeLogger() as never,
    );
  });

  function seedWallet(overrides: Partial<{ id: string; playerId: string; currency: string; balance: string }> = {}) {
    const wallet = Wallet.open({
      id: overrides.id ?? 'wallet-1',
      playerId: overrides.playerId ?? 'player-1',
      initialBalance: Money.from({ amount: overrides.balance ?? '100.00', currency: overrides.currency ?? 'BRL' }),
      createdAt: NOW,
    });
    wallets.seed(wallet);
    return wallet;
  }

  function seedProcessedTransaction(overrides: {
    id: string;
    externalTransactionId: string;
    kind: WagerTransactionKind;
    amount: string;
    walletId: string;
    playerId: string;
    roundId?: string;
    currency?: string;
  }) {
    const tx = WagerTransaction.create({
      id: overrides.id,
      providerId: 'provider-a',
      externalTransactionId: overrides.externalTransactionId,
      idempotencyKey: `provider-a:${overrides.externalTransactionId}`,
      payloadHash: 'seed-hash',
      walletId: overrides.walletId,
      playerId: overrides.playerId,
      roundId: overrides.roundId ?? 'round-1',
      gameId: 'game-1',
      kind: overrides.kind,
      money: Money.from({ amount: overrides.amount, currency: overrides.currency ?? 'BRL' }),
      createdAt: NOW,
    });
    tx.markProcessed(undefined, NOW);
    transactions.seed(tx);
    return tx;
  }

  it('rejects with IdempotencyConflictError when the same key is reused with a different payload', async () => {
    seedWallet();
    await useCase.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'tx-1',
        idempotencyKey: 'provider-a:tx-1',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      },
      { correlationId: 'test' },
    );

    await expect(
      useCase.execute(
        {
          providerId: 'provider-a',
          externalTransactionId: 'tx-1',
          idempotencyKey: 'provider-a:tx-1',
          playerId: 'player-1',
          walletId: 'wallet-1',
          roundId: 'round-1',
          gameId: 'game-1',
          kind: WagerTransactionKind.Bet,
          money: { amount: '99.00', currency: 'BRL' }, // payload diferente, mesma key
        },
        { correlationId: 'test' },
      ),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('returns idempotentReplay=true and does not reprocess when the same key+payload is resubmitted', async () => {
    seedWallet();
    const input = {
      providerId: 'provider-a',
      externalTransactionId: 'tx-1',
      idempotencyKey: 'provider-a:tx-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    };
    const first = await useCase.execute(input, { correlationId: 'test' });
    const second = await useCase.execute(input, { correlationId: 'test' });

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(ledger.entries).toHaveLength(1); // não debitou de novo
  });

  it('BET on a non-existent wallet throws WalletNotFoundError', async () => {
    await expect(
      useCase.execute(
        {
          providerId: 'provider-a',
          externalTransactionId: 'tx-1',
          idempotencyKey: 'provider-a:tx-1',
          playerId: 'player-1',
          walletId: 'does-not-exist',
          roundId: 'round-1',
          gameId: 'game-1',
          kind: WagerTransactionKind.Bet,
          money: { amount: '25.00', currency: 'BRL' },
        },
        { correlationId: 'test' },
      ),
    ).rejects.toThrow(WalletNotFoundError);
  });

  it('rejects with CURRENCY_MISMATCH when the operation currency differs from the wallet currency', async () => {
    seedWallet({ currency: 'BRL' });
    const result = await useCase.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'tx-1',
        idempotencyKey: 'provider-a:tx-1',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'USD' },
      },
      { correlationId: 'test' },
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
  });

  it('LOSS never locks the wallet and never touches the ledger', async () => {
    seedWallet({ balance: '100.00' });
    const result = await useCase.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'loss-1',
        idempotencyKey: 'provider-a:loss-1',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Loss,
        money: { amount: '10.00', currency: 'BRL' },
      },
      { correlationId: 'test' },
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance?.amount).toBe('100.00');
    expect(ledger.entries).toHaveLength(0);
    expect(wallets.lockCallCount).toBe(0);
    expect(wallets.findCallCount).toBeGreaterThan(0);
  });

  it('REFUND referencing a WIN (not a BET) is rejected with REFERENCE_TYPE_INVALID', async () => {
    seedWallet();
    seedProcessedTransaction({
      id: 'win-1',
      externalTransactionId: 'win-1',
      kind: WagerTransactionKind.Win,
      amount: '25.00',
      walletId: 'wallet-1',
      playerId: 'player-1',
    });

    const result = await useCase.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'refund-1',
        idempotencyKey: 'provider-a:refund-1',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Refund,
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: 'win-1',
      },
      { correlationId: 'test' },
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReferenceTypeInvalid);
  });

  it('ROLLBACK referencing a transaction from a different wallet is rejected with REFERENCE_OWNER_MISMATCH', async () => {
    seedWallet({ id: 'wallet-1', playerId: 'player-1' });
    seedWallet({ id: 'wallet-2', playerId: 'player-2' });
    seedProcessedTransaction({
      id: 'bet-other-wallet',
      externalTransactionId: 'bet-other-wallet',
      kind: WagerTransactionKind.Bet,
      amount: '25.00',
      walletId: 'wallet-2',
      playerId: 'player-2',
    });

    const result = await useCase.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'rollback-1',
        idempotencyKey: 'provider-a:rollback-1',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Rollback,
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-other-wallet',
      },
      { correlationId: 'test' },
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReferenceOwnerMismatch);
  });

  it('REFUND with a different amount than the referenced BET is rejected with VALIDATION_ERROR', async () => {
    seedWallet();
    seedProcessedTransaction({
      id: 'bet-1',
      externalTransactionId: 'bet-1',
      kind: WagerTransactionKind.Bet,
      amount: '25.00',
      walletId: 'wallet-1',
      playerId: 'player-1',
    });

    const result = await useCase.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'refund-1',
        idempotencyKey: 'provider-a:refund-1',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Refund,
        money: { amount: '10.00', currency: 'BRL' }, // BET foi de 25.00
        referenceExternalTransactionId: 'bet-1',
      },
      { correlationId: 'test' },
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.ValidationError);
  });

  it('a second REFUND of the same BET is rejected with REFERENCE_ALREADY_REVERSED', async () => {
    seedWallet({ balance: '100.00' });
    seedProcessedTransaction({
      id: 'bet-1',
      externalTransactionId: 'bet-1',
      kind: WagerTransactionKind.Bet,
      amount: '25.00',
      walletId: 'wallet-1',
      playerId: 'player-1',
    });
    // já existe um REFUND PROCESSED referenciando bet-1
    const firstRefund = WagerTransaction.create({
      id: 'refund-already',
      providerId: 'provider-a',
      externalTransactionId: 'refund-already',
      idempotencyKey: 'provider-a:refund-already',
      payloadHash: 'seed-hash',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'bet-1',
      createdAt: NOW,
    });
    firstRefund.markProcessed('bet-1', NOW);
    transactions.seed(firstRefund);

    const result = await useCase.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'refund-2',
        idempotencyKey: 'provider-a:refund-2',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Refund,
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-1',
      },
      { correlationId: 'test' },
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  it('REFUND referencing a REJECTED transaction is rejected with REFERENCE_NOT_FOUND (never resolves)', async () => {
    seedWallet();
    const rejectedBet = WagerTransaction.create({
      id: 'bet-rejected',
      providerId: 'provider-a',
      externalTransactionId: 'bet-rejected',
      idempotencyKey: 'provider-a:bet-rejected',
      payloadHash: 'seed-hash',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      createdAt: NOW,
    });
    rejectedBet.reject(FailureCode.InsufficientBalance);
    transactions.seed(rejectedBet);

    const result = await useCase.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'refund-1',
        idempotencyKey: 'provider-a:refund-1',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Refund,
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-rejected',
      },
      { correlationId: 'test' },
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  it('REFUND referencing a BET that has not arrived yet becomes PENDING_REFERENCE', async () => {
    seedWallet();
    const result = await useCase.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'refund-1',
        idempotencyKey: 'provider-a:refund-1',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Refund,
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-not-arrived-yet',
      },
      { correlationId: 'test' },
    );
    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    expect(outbox.events.map((e) => e.eventType)).toContain('WagerTransactionPendingReference');
  });
});
