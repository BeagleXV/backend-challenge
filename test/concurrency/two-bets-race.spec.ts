import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplicationContext } from '@nestjs/common';
import { createTestApp, randomUuid, truncateAll } from '../support/test-app';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wallets/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wallets/domain/wager-transaction';
import { FailureCode } from '../../src/shared/domain/failure-code';

/**
 * Cenário obrigatório da seção 8: saldo 100.00, duas apostas de 80.00 disputando o mesmo saldo,
 * paralelismo real (Promise.all, não sequencial). Resultado esperado: exatamente uma PROCESSED, a
 * outra REJECTED por saldo insuficiente, saldo final 20.00, exatamente um lançamento de débito.
 */
describe('mandatory concurrency scenario: two 80.00 bets against a 100.00 balance', () => {
  let app: INestApplicationContext;
  let em: EntityManager;
  let createWallet: CreateWalletUseCase;
  let processTx: ProcessWagerTransactionUseCase;

  beforeAll(async () => {
    app = await createTestApp();
    em = app.get(EntityManager).fork();
    createWallet = app.get(CreateWalletUseCase);
    processTx = app.get(ProcessWagerTransactionUseCase);
  });

  beforeEach(async () => {
    await truncateAll(app);
  });

  afterAll(async () => {
    await app.close();
  }, 20000);

  it('exactly one PROCESSED, one REJECTED, final balance 20.00, exactly one debit ledger entry', async () => {
    const playerId = randomUuid();
    const wallet = await createWallet.execute(
      { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      { correlationId: 'test' },
    );

    const submit = (ext: string) =>
      processTx.execute(
        {
          providerId: 'provider-a',
          externalTransactionId: ext,
          idempotencyKey: `provider-a:${ext}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round-race',
          gameId: 'game-1',
          kind: WagerTransactionKind.Bet,
          money: { amount: '80.00', currency: 'BRL' },
        },
        { correlationId: ext },
      );

    const [a, b] = await Promise.all([submit('race-a'), submit('race-b')]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected].sort());

    const rejected = a.status === WagerTransactionStatus.Rejected ? a : b;
    expect(rejected.failureCode).toBe(FailureCode.InsufficientBalance);

    const conn = em.getConnection();
    const [walletRow] = await conn.execute<{ balance: string; version: number }[]>(
      'select balance, version from wallets where id = ?',
      [wallet.id],
    );
    expect(walletRow?.balance).toBe('20.00');
    expect(walletRow?.version).toBe(2); // só a wallet abertura(1) + 1 débito bem-sucedido

    const debitRows = await conn.execute(
      "select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
      [wallet.id],
    );
    expect(debitRows).toHaveLength(1);

    // invariante final exigida pela seção 13: saldo == saldo reconstruído pelo ledger
    const [sumRow] = await conn.execute<{ calculated: string }[]>(
      `select coalesce(sum(case when direction = 'CREDIT' then money_amount else -money_amount end), 0) as calculated
       from wallet_ledger_entries where wallet_id = ?`,
      [wallet.id],
    );
    expect(sumRow?.calculated).toBe('20.00');
  }, 20000);

  it('no retry duplicates the debit: resubmitting the losing bet with the same key stays REJECTED', async () => {
    const playerId = randomUuid();
    const wallet = await createWallet.execute(
      { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      { correlationId: 'test' },
    );

    const submit = () =>
      processTx.execute(
        {
          providerId: 'provider-a',
          externalTransactionId: 'retry-race-b',
          idempotencyKey: 'provider-a:retry-race-b',
          playerId,
          walletId: wallet.id,
          roundId: 'round-race',
          gameId: 'game-1',
          kind: WagerTransactionKind.Bet,
          money: { amount: '80.00', currency: 'BRL' },
        },
        { correlationId: 'retry-race-b' },
      );

    await processTx.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'retry-race-a',
        idempotencyKey: 'provider-a:retry-race-a',
        playerId,
        walletId: wallet.id,
        roundId: 'round-race',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      },
      { correlationId: 'retry-race-a' },
    );

    const first = await submit();
    expect(first.status).toBe(WagerTransactionStatus.Rejected);
    const retried = await submit();
    expect(retried.idempotentReplay).toBe(true);
    expect(retried.status).toBe(WagerTransactionStatus.Rejected);
    expect(retried.transactionId).toBe(first.transactionId);

    const conn = em.getConnection();
    const [walletRow] = await conn.execute<{ balance: string }[]>('select balance from wallets where id = ?', [
      wallet.id,
    ]);
    expect(walletRow?.balance).toBe('20.00');
  }, 20000);
});
