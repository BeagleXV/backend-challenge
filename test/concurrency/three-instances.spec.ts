import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplicationContext } from '@nestjs/common';
import { createTestApp, randomUuid, truncateAll } from '../support/test-app';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wallets/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wallets/domain/wager-transaction';
import { WalletEntity } from '../../src/modules/wallets/infrastructure/entities/wallet.entity';

/**
 * Simula 3 instâncias reais da aplicação com 3 app contexts NestJS separados (cada um com seu
 * próprio pool de conexão, EntityManager, etc.) apontando para o MESMO Postgres — não é uma
 * simplificação "3 chamadas no mesmo processo", é genuinamente 3 processos de aplicação
 * independentes do ponto de vista do Nest/MikroORM, só compartilhando a infraestrutura (que é
 * exatamente a garantia que a seção 8 do desafio pede: "a solução deve estar correta com múltiplas
 * instâncias").
 */
describe('correctness holds with 3+ concurrent application instances', () => {
  let instances: INestApplicationContext[];
  let em: EntityManager;

  beforeAll(async () => {
    instances = await Promise.all([createTestApp(), createTestApp(), createTestApp()]);
    em = instances[0]!.get(EntityManager).fork();
  });

  beforeEach(async () => {
    await truncateAll(instances[0]!);
  });

  afterAll(async () => {
    await Promise.all(instances.map((app) => app.close()));
  }, 20000);

  it('two instances racing BETs on the same wallet: still exactly one PROCESSED, one REJECTED', async () => {
    const [instanceA, instanceB, instanceC] = instances;
    const playerId = randomUuid();
    const wallet = await instanceA!.get(CreateWalletUseCase).execute(
      { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      { correlationId: 'test' },
    );

    const submitFrom = (app: INestApplicationContext, ext: string) =>
      app.get(ProcessWagerTransactionUseCase).execute(
        {
          providerId: 'provider-a',
          externalTransactionId: ext,
          idempotencyKey: `provider-a:${ext}`,
          playerId,
          walletId: wallet.id,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: WagerTransactionKind.Bet,
          money: { amount: '80.00', currency: 'BRL' },
        },
        { correlationId: ext },
      );

    const [a, b] = await Promise.all([
      submitFrom(instanceA!, 'multi-inst-a'),
      submitFrom(instanceB!, 'multi-inst-b'),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected].sort());

    const conn = em.getConnection();
    const [row] = await conn.execute<{ balance: string }[]>('select balance from wallets where id = ?', [wallet.id]);
    expect(row?.balance).toBe('20.00');

    // uma 3a instância consegue ler o mesmo estado final consistente
    const readBack = await instanceC!.get(EntityManager).fork().findOne(WalletEntity, { id: wallet.id });
    expect(readBack).toBeTruthy();
  }, 20000);

  it('3 instances processing 30 different wallets concurrently, all correct', async () => {
    const [instanceA, instanceB, instanceC] = instances;
    const wallets = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        instances[i % 3]!.get(CreateWalletUseCase).execute(
          { playerId: randomUuid(), initialBalance: { amount: '50.00', currency: 'BRL' } },
          { correlationId: 'seed' },
        ),
      ),
    );

    const results = await Promise.all(
      wallets.map((wallet, i) => {
        const app = [instanceA, instanceB, instanceC][i % 3]!;
        return app.get(ProcessWagerTransactionUseCase).execute(
          {
            providerId: 'provider-a',
            externalTransactionId: `multi-inst-parallel-${i}`,
            idempotencyKey: `provider-a:multi-inst-parallel-${i}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'round-1',
            gameId: 'game-1',
            kind: WagerTransactionKind.Bet,
            money: { amount: '15.00', currency: 'BRL' },
          },
          { correlationId: `multi-inst-parallel-${i}` },
        );
      }),
    );

    expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);

    const conn = em.getConnection();
    for (const wallet of wallets) {
      const [row] = await conn.execute<{ balance: string }[]>('select balance from wallets where id = ?', [
        wallet.id,
      ]);
      expect(row?.balance).toBe('35.00');
    }
  }, 30000);
});
