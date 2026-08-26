import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplicationContext } from '@nestjs/common';
import { createTestApp, randomUuid, truncateAll } from '../support/test-app';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wallets/application/use-cases/process-wager-transaction.use-case';
import { PendingReferenceReprocessorWorker } from '../../src/modules/wallets/infrastructure/workers/pending-reference-reprocessor.worker';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wallets/domain/wager-transaction';
import { FailureCode } from '../../src/shared/domain/failure-code';

/**
 * Seção 7.1 + cenário obrigatório da seção 13 (item 7): ROLLBACK/REFUND entregue antes da
 * referência. O worker é chamado diretamente (em vez de esperar o @Interval de 5s) para o teste
 * ser determinístico — a lógica exercitada é a mesma.
 */
describe('ROLLBACK/REFUND delivered before its reference exists', () => {
  let app: INestApplicationContext;
  let em: EntityManager;
  let createWallet: CreateWalletUseCase;
  let processTx: ProcessWagerTransactionUseCase;
  let worker: PendingReferenceReprocessorWorker;

  beforeAll(async () => {
    app = await createTestApp();
    em = app.get(EntityManager).fork();
    createWallet = app.get(CreateWalletUseCase);
    processTx = app.get(ProcessWagerTransactionUseCase);
    worker = app.get(PendingReferenceReprocessorWorker);
  });

  beforeEach(async () => {
    await truncateAll(app);
  });

  afterAll(async () => {
    await app.close();
  }, 20000);

  it('ROLLBACK arriving first becomes PENDING_REFERENCE, then resolves once the BET arrives', async () => {
    const playerId = randomUuid();
    const wallet = await createWallet.execute(
      { playerId, initialBalance: { amount: '200.00', currency: 'BRL' } },
      { correlationId: 'test' },
    );

    const rollback = await processTx.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'race-rollback-1',
        idempotencyKey: 'provider-a:race-rollback-1',
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Rollback,
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: 'race-bet-1',
      },
      { correlationId: 'race-rollback-1' },
    );
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);

    // Nenhum efeito no saldo enquanto pendente.
    const conn = em.getConnection();
    const [beforeRow] = await conn.execute<{ balance: string }[]>('select balance from wallets where id = ?', [
      wallet.id,
    ]);
    expect(beforeRow?.balance).toBe('200.00');

    // agora a BET referenciada chega
    await processTx.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'race-bet-1',
        idempotencyKey: 'provider-a:race-bet-1',
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '40.00', currency: 'BRL' },
      },
      { correlationId: 'race-bet-1' },
    );

    // worker resolve o ROLLBACK pendente
    await worker.run();

    const [txRow] = await conn.execute<{ status: string; reference_transaction_id: string }[]>(
      'select status, reference_transaction_id from wager_transactions where id = ?',
      [rollback.transactionId],
    );
    expect(txRow?.status).toBe('PROCESSED');
    expect(txRow?.reference_transaction_id).toBeTruthy();

    const [afterRow] = await conn.execute<{ balance: string }[]>('select balance from wallets where id = ?', [
      wallet.id,
    ]);
    // BET debita 40, ROLLBACK reverte (credita 40 de volta) -> saldo volta a 200.00
    expect(afterRow?.balance).toBe('200.00');
  }, 20000);

  it('REFUND arriving before its BET, referencing a BET that never arrives, exhausts retries and gets REJECTED', async () => {
    const playerId = randomUuid();
    const wallet = await createWallet.execute(
      { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      { correlationId: 'test' },
    );

    const refund = await processTx.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'orphan-refund-1',
        idempotencyKey: 'provider-a:orphan-refund-1',
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Refund,
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-that-never-arrives',
      },
      { correlationId: 'orphan-refund-1' },
    );
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    // Esgota as tentativas manualmente chamando retryPendingReference direto (sem esperar o
    // backoff real de ~25min): a checagem de limite acontece ANTES de incrementar o contador, e
    // PENDING_REFERENCE_MAX_ATTEMPTS é 10 — então a 11a chamada é a que efetivamente rejeita.
    for (let i = 0; i < 11; i++) {
      await processTx.retryPendingReference(refund.transactionId, { correlationId: 'orphan-refund-1' });
    }

    const conn = em.getConnection();
    const [txRow] = await conn.execute<{ status: string; failure_code: string }[]>(
      'select status, failure_code from wager_transactions where id = ?',
      [refund.transactionId],
    );
    expect(txRow?.status).toBe('REJECTED');
    expect(txRow?.failure_code).toBe(FailureCode.ReferenceTimeoutExceeded);
  }, 20000);
});
