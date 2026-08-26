import { afterAll, describe, expect, it } from 'bun:test';
import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplicationContext } from '@nestjs/common';
import { createTestApp, randomUuid, truncateAll } from '../support/test-app';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wallets/application/use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from '../../src/modules/wallets/application/use-cases/reconcile-wallet.use-case';
import { OutboxPublisherWorker } from '../../src/modules/messaging/infrastructure/outbox-publisher.worker';
import { WagerTransactionKind } from '../../src/modules/wallets/domain/wager-transaction';

/**
 * Cenário da seção 11: o processo morre antes de publicar a outbox; outra instância assume o
 * trabalho depois. `app1` commita tudo mas nunca chega a rodar seu OutboxPublisherWorker (o
 * @Interval de 5s não teve tempo de disparar) — simula fielmente "morreu antes de publicar", sem
 * depender do tempo de `close()` (que só serve para liberar recursos no fim do teste, não faz
 * parte da simulação). `app2` ("outra instância") publica o que ficou pendente.
 */
describe('recovery after restart', () => {
  let app1: INestApplicationContext;
  let app2: INestApplicationContext;

  afterAll(async () => {
    await Promise.all([app1?.close(), app2?.close()].filter(Boolean));
  }, 20000);

  it('an outbox message left unpublished by a dead instance gets published by a new one', async () => {
    app1 = await createTestApp();
    await truncateAll(app1);

    const playerId = randomUuid();
    const createWallet = app1.get(CreateWalletUseCase);
    const processTx = app1.get(ProcessWagerTransactionUseCase);
    const wallet = await createWallet.execute(
      { playerId, initialBalance: { amount: '200.00', currency: 'BRL' } },
      { correlationId: 'test' },
    );
    await processTx.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'restart-bet-1',
        idempotencyKey: 'provider-a:restart-bet-1',
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '60.00', currency: 'BRL' },
      },
      { correlationId: 'test' },
    );

    // "morre" antes do worker (@Interval 5s) ter tido qualquer chance de rodar — checagem
    // imediata, sem esperar/fechar app1 (que não faz parte do cenário sendo simulado).
    const em = app1.get(EntityManager).fork();
    const [pendingBefore] = await em
      .getConnection()
      .execute<{ count: string }[]>('select count(*)::text as count from outbox_messages where published_at is null');
    expect(Number(pendingBefore?.count)).toBeGreaterThan(0);

    // "outra instância assume o trabalho"
    app2 = await createTestApp();
    const worker = app2.get(OutboxPublisherWorker);
    await worker.run();

    const [pendingAfter] = await em
      .getConnection()
      .execute<{ count: string }[]>('select count(*)::text as count from outbox_messages where published_at is null');
    expect(Number(pendingAfter?.count)).toBe(0);

    // consistência final: saldo == ledger reconstruído, mesmo depois do "crash"
    const reconcile = app2.get(ReconcileWalletUseCase);
    const report = await reconcile.execute(wallet.id);
    expect(report.consistent).toBe(true);
    expect(report.storedBalance.amount).toBe('140.00');
  }, 15000);
});
