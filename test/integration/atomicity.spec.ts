import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplicationContext } from '@nestjs/common';
import { createTestApp, randomUuid, truncateAll } from '../support/test-app';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wallets/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wallets/domain/wager-transaction';
import { FailureCode } from '../../src/shared/domain/failure-code';

/**
 * Atomicidade entre wallet, ledger, wager_transaction e outbox — seção 11 do desafio: tudo
 * commitado junto ou nada. Testado observando o estado final real no Postgres depois do use case
 * rodar, não mockando nenhuma das peças.
 */
describe('atomicity: wallet + ledger + wager_transaction + outbox', () => {
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

  it('a successful BET commits wallet update + ledger entry + transaction + 2 outbox events together', async () => {
    const playerId = randomUuid();
    const wallet = await createWallet.execute(
      { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      { correlationId: 'test' },
    );

    const result = await processTx.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'atomic-bet-1',
        idempotencyKey: 'provider-a:atomic-bet-1',
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '30.00', currency: 'BRL' },
      },
      { correlationId: 'test' },
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);

    const conn = em.getConnection();
    const [walletRow] = await conn.execute<{ balance: string; version: number }[]>(
      'select balance, version from wallets where id = ?',
      [wallet.id],
    );
    expect(walletRow?.balance).toBe('70.00');
    expect(walletRow?.version).toBe(2);

    const ledgerRows = await conn.execute<{ direction: string; money_amount: string }[]>(
      'select direction, money_amount from wallet_ledger_entries where transaction_id = ?',
      [result.transactionId],
    );
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.direction).toBe('DEBIT');
    expect(ledgerRows[0]?.money_amount).toBe('30.00');

    const txRows = await conn.execute<{ status: string }[]>(
      'select status from wager_transactions where id = ?',
      [result.transactionId],
    );
    expect(txRows[0]?.status).toBe('PROCESSED');

    // aggregate_id não basta para isolar os eventos desta transação: WalletBalanceChanged do
    // OPENING (na criação da wallet) também usa wallet.id como aggregate_id. Filtra pelo
    // transactionId dentro do payload, que é específico desta operação.
    const outboxRows = await conn.execute<{ event_type: string }[]>(
      `select event_type from outbox_messages where payload->'data'->>'transactionId' = ? order by occurred_at`,
      [result.transactionId],
    );
    const eventTypes = outboxRows.map((r) => r.event_type).sort();
    expect(eventTypes).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged'].sort());
  });

  it('a REJECTED transaction (insufficient balance) has no ledger entry and no WalletBalanceChanged event', async () => {
    const playerId = randomUuid();
    const wallet = await createWallet.execute(
      { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } },
      { correlationId: 'test' },
    );

    const result = await processTx.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'atomic-bet-insufficient',
        idempotencyKey: 'provider-a:atomic-bet-insufficient',
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '999.00', currency: 'BRL' },
      },
      { correlationId: 'test' },
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientBalance);

    const conn = em.getConnection();
    const ledgerRows = await conn.execute('select 1 from wallet_ledger_entries where transaction_id = ?', [
      result.transactionId,
    ]);
    expect(ledgerRows).toHaveLength(0);

    const [walletRow] = await conn.execute<{ balance: string; version: number }[]>(
      'select balance, version from wallets where id = ?',
      [wallet.id],
    );
    expect(walletRow?.balance).toBe('10.00');
    expect(walletRow?.version).toBe(1); // rejeição não incrementa version

    const outboxRows = await conn.execute<{ event_type: string }[]>(
      'select event_type from outbox_messages where aggregate_id = ?',
      [result.transactionId],
    );
    expect(outboxRows.map((r) => r.event_type)).toEqual(['WagerTransactionRejected']);
  });

  it('wallet.balance always equals the balance reconstructed from the ledger', async () => {
    const playerId = randomUuid();
    const wallet = await createWallet.execute(
      { playerId, initialBalance: { amount: '500.00', currency: 'BRL' } },
      { correlationId: 'test' },
    );

    const ops: Array<[WagerTransactionKind, string, string]> = [
      [WagerTransactionKind.Bet, 'a-1', '50.00'],
      [WagerTransactionKind.Win, 'a-2', '20.00'],
      [WagerTransactionKind.Bet, 'a-3', '100.00'],
      [WagerTransactionKind.Loss, 'a-4', '5.00'],
    ];
    for (const [kind, ext, amount] of ops) {
      await processTx.execute(
        {
          providerId: 'provider-a',
          externalTransactionId: ext,
          idempotencyKey: `provider-a:${ext}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round-1',
          gameId: 'game-1',
          kind,
          money: { amount, currency: 'BRL' },
        },
        { correlationId: 'test' },
      );
    }

    const conn = em.getConnection();
    const [walletRow] = await conn.execute<{ balance: string }[]>('select balance from wallets where id = ?', [
      wallet.id,
    ]);
    // 500 - 50 + 20 - 100 = 370.00 (LOSS não move saldo)
    expect(walletRow?.balance).toBe('370.00');

    const [sumRow] = await conn.execute<{ calculated: string }[]>(
      `select coalesce(sum(case when direction = 'CREDIT' then money_amount else -money_amount end), 0) as calculated
       from wallet_ledger_entries where wallet_id = ?`,
      [wallet.id],
    );
    expect(Number(sumRow?.calculated)).toBeCloseTo(Number(walletRow?.balance), 2);
  });
});
