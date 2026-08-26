import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplicationContext } from '@nestjs/common';
import { createTestApp, randomUuid, truncateAll } from '../support/test-app';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wallets/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind } from '../../src/modules/wallets/domain/wager-transaction';

describe('the same bet sent 50 times in parallel results in a single debit', () => {
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

  it('49 replays + 1 real debit, final balance and ledger consistent', async () => {
    const playerId = randomUuid();
    const wallet = await createWallet.execute(
      { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } },
      { correlationId: 'test' },
    );

    const submit = () =>
      processTx.execute(
        {
          providerId: 'provider-a',
          externalTransactionId: 'dup-bet',
          idempotencyKey: 'provider-a:dup-bet',
          playerId,
          walletId: wallet.id,
          roundId: 'round-dup',
          gameId: 'game-1',
          kind: WagerTransactionKind.Bet,
          money: { amount: '10.00', currency: 'BRL' },
        },
        { correlationId: 'dup-bet' },
      );

    const results = await Promise.all(Array.from({ length: 50 }, submit));

    const realProcessing = results.filter((r) => !r.idempotentReplay);
    expect(realProcessing).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);

    const conn = em.getConnection();
    const [walletRow] = await conn.execute<{ balance: string }[]>('select balance from wallets where id = ?', [
      wallet.id,
    ]);
    expect(walletRow?.balance).toBe('990.00');

    const debitRows = await conn.execute(
      "select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
      [wallet.id],
    );
    expect(debitRows).toHaveLength(1);

    const [txCountRow] = await conn.execute<{ count: string }[]>(
      "select count(*)::text as count from wager_transactions where external_transaction_id = 'dup-bet'",
    );
    expect(txCountRow?.count).toBe('1');
  }, 30000);
});
