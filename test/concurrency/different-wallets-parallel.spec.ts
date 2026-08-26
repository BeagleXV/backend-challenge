import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplicationContext } from '@nestjs/common';
import { createTestApp, randomUuid, truncateAll } from '../support/test-app';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wallets/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wallets/domain/wager-transaction';

describe('different wallets processed in parallel never interfere with each other', () => {
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

  it('20 wallets, each debited in parallel, all end up correct and consistent', async () => {
    const walletCount = 20;
    const wallets = await Promise.all(
      Array.from({ length: walletCount }, () =>
        createWallet.execute(
          { playerId: randomUuid(), initialBalance: { amount: '100.00', currency: 'BRL' } },
          { correlationId: 'seed' },
        ),
      ),
    );

    const results = await Promise.all(
      wallets.map((wallet, i) =>
        processTx.execute(
          {
            providerId: 'provider-a',
            externalTransactionId: `parallel-${i}`,
            idempotencyKey: `provider-a:parallel-${i}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'round-1',
            gameId: 'game-1',
            kind: WagerTransactionKind.Bet,
            money: { amount: '30.00', currency: 'BRL' },
          },
          { correlationId: `parallel-${i}` },
        ),
      ),
    );

    expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);

    const conn = em.getConnection();
    for (const wallet of wallets) {
      const [row] = await conn.execute<{ balance: string }[]>('select balance from wallets where id = ?', [
        wallet.id,
      ]);
      expect(row?.balance).toBe('70.00');
    }
  }, 30000);
});
