import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplicationContext } from '@nestjs/common';
import { createTestApp, randomUuid, truncateAll } from '../support/test-app';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wallets/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/modules/wallets/domain/wager-transaction';

/**
 * Seção 13, cenário 5: "worker morto depois do commit e antes do ack". O `SqsConsumerService` real
 * só chama `DeleteMessageCommand` (ack) depois que `ProcessWagerTransactionUseCase.execute()`
 * retorna com sucesso — então "morrer entre o commit e o ack" é exatamente "a mensagem nunca foi
 * deletada da fila, e o broker a reentrega". Simulado chamando o use case duas vezes com o MESMO
 * InboxContext (mesmo messageId) — a segunda chamada é, por construção, indistinguível de uma
 * redelivery real do SQS depois de um crash nesse ponto exato.
 */
describe('worker killed after commit, before ack — redelivery must not duplicate the effect', () => {
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

  it('redelivering the never-acked message applies no second debit', async () => {
    const playerId = randomUuid();
    const wallet = await createWallet.execute(
      { playerId, initialBalance: { amount: '150.00', currency: 'BRL' } },
      { correlationId: 'test' },
    );

    const input = {
      providerId: 'provider-a',
      externalTransactionId: 'crash-before-ack-1',
      idempotencyKey: 'provider-a:crash-before-ack-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '45.00', currency: 'BRL' },
    };
    const ctx = { correlationId: input.idempotencyKey, causationId: 'msg-crash-1' };
    const inboxCtx = { consumerName: 'wager-transaction-consumer', messageId: 'msg-crash-1' };

    // 1a "entrega": commita tudo (wallet, ledger, transação, inbox, outbox) — e então, no mundo
    // real, o processo morreria antes de conseguir deletar a mensagem da fila.
    const first = await processTx.execute(input, ctx, inboxCtx);
    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(first.idempotentReplay).toBe(false);

    // "redelivery": o SQS reentrega a mesma mensagem (nunca foi deletada) — mesmo messageId.
    const redelivered = await processTx.execute(input, ctx, inboxCtx);
    expect(redelivered.transactionId).toBe(first.transactionId);
    expect(redelivered.status).toBe(WagerTransactionStatus.Processed);

    const conn = em.getConnection();
    const [walletRow] = await conn.execute<{ balance: string }[]>('select balance from wallets where id = ?', [
      wallet.id,
    ]);
    expect(walletRow?.balance).toBe('105.00'); // um único débito de 45.00

    const ledgerRows = await conn.execute(
      "select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
      [wallet.id],
    );
    expect(ledgerRows).toHaveLength(1);

    const [inboxRow] = await conn.execute<{ count: string }[]>(
      "select count(*)::text as count from inbox_messages where message_id = 'msg-crash-1'",
    );
    expect(inboxRow?.count).toBe('1');
  }, 20000);
});
