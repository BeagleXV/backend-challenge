import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplicationContext } from '@nestjs/common';
import { createTestApp, purgeQueuesDirect, randomUuid, truncateAll } from '../support/test-app';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/use-cases/create-wallet.use-case';
import { OutboxPublisherWorker } from '../../src/modules/messaging/infrastructure/outbox-publisher.worker';

/**
 * Cenário 6 da seção 13 (concorrência): dois publishers concorrentes sobre a mesma outbox. Duas
 * instâncias de app **separadas** (dois `NestFactory.createApplicationContext`), cada uma com seu
 * próprio `OutboxPublisherWorker`, disputando o mesmo lote de mensagens pendentes no mesmo Postgres
 * — não é uma simulação, é o mecanismo real de `FOR UPDATE SKIP LOCKED` sob paralelismo de verdade.
 */
describe('outbox publisher: concurrent publishers do not duplicate nor lose messages', () => {
  let appA: INestApplicationContext;
  let appB: INestApplicationContext;
  let em: EntityManager;

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    em = appA.get(EntityManager).fork();
  });

  beforeEach(async () => {
    await truncateAll(appA);
    await purgeQueuesDirect();
  });

  afterAll(async () => {
    await appA.close();
    await appB.close();
  }, 20000);

  it('two publisher instances racing over the same batch publish every message exactly once', async () => {
    const playerId = randomUuid();
    const createWallet = appA.get(CreateWalletUseCase);
    // Cada CreateWallet enfileira 2 eventos na outbox (WagerTransactionProcessed + WalletBalanceChanged)
    const walletCount = 8;
    for (let i = 0; i < walletCount; i++) {
      await createWallet.execute(
        { playerId: randomUuid(), initialBalance: { amount: '10.00', currency: 'BRL' } },
        { correlationId: `seed-${i}` },
      );
    }

    const conn = em.getConnection();
    const [beforeRow] = await conn.execute<{ count: string }[]>(
      'select count(*)::text as count from outbox_messages where published_at is null',
    );
    expect(Number(beforeRow?.count)).toBe(walletCount * 2);

    const workerA = appA.get(OutboxPublisherWorker);
    const workerB = appB.get(OutboxPublisherWorker);

    // Dispara as duas rodadas em paralelo de verdade — é exatamente o cenário de FOR UPDATE SKIP
    // LOCKED que estamos validando (ARCHITECTURE.md, seção 6.2).
    await Promise.all([workerA.run(), workerB.run()]);
    // Uma segunda rodada garante que sobras também sejam publicadas.
    await Promise.all([workerA.run(), workerB.run()]);

    const [afterRow] = await conn.execute<{ count: string }[]>(
      'select count(*)::text as count from outbox_messages where published_at is null',
    );
    expect(Number(afterRow?.count)).toBe(0);

    const [publishedRow] = await conn.execute<{ count: string }[]>(
      'select count(*)::text as count from outbox_messages where published_at is not null',
    );
    expect(Number(publishedRow?.count)).toBe(walletCount * 2);
  }, 30000);
});
