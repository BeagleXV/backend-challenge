import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplicationContext } from '@nestjs/common';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createTestApp, purgeQueuesDirect, randomUuid, truncateAll, waitUntil } from '../support/test-app';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/use-cases/create-wallet.use-case';

function sqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION,
    endpoint: process.env.SQS_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}

async function sendWagerTransactionRequested(
  sqs: SQSClient,
  opts: { messageId: string; dedupSuffix: string; walletId: string; playerId: string; externalTransactionId: string; amount: string },
) {
  const body = {
    messageId: opts.messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: opts.externalTransactionId,
      idempotencyKey: `provider-a:${opts.externalTransactionId}`,
      playerId: opts.playerId,
      walletId: opts.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: opts.amount, currency: 'BRL' },
    },
  };
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL,
      MessageBody: JSON.stringify(body),
      MessageGroupId: opts.walletId,
      MessageDeduplicationId: `${opts.messageId}-${opts.dedupSuffix}`,
    }),
  );
}

/**
 * Consumer SQS real (SqsConsumerService, iniciado automaticamente pelo AppModule) processando uma
 * mensagem publicada de verdade na fila, e uma redelivery da MESMA mensagem de negócio (messageId
 * igual, SQS MessageId novo) sendo deduplicada via inbox — sem efeito duplicado.
 */
describe('SQS consumer: processes real messages and deduplicates redelivery via inbox', () => {
  let app: INestApplicationContext;
  let em: EntityManager;
  let createWallet: CreateWalletUseCase;
  let sqs: SQSClient;

  beforeAll(async () => {
    app = await createTestApp();
    em = app.get(EntityManager).fork();
    createWallet = app.get(CreateWalletUseCase);
    sqs = sqsClient();
  });

  beforeEach(async () => {
    await truncateAll(app);
    await purgeQueuesDirect();
  });

  afterAll(async () => {
    sqs.destroy();
    await app.close();
  }, 20000);

  it('processes a message published on the real queue and applies the bet', async () => {
    const playerId = randomUuid();
    const wallet = await createWallet.execute(
      { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      { correlationId: 'test' },
    );

    await sendWagerTransactionRequested(sqs, {
      messageId: `msg-${randomUuid()}`,
      dedupSuffix: 'first',
      walletId: wallet.id,
      playerId,
      externalTransactionId: 'inbox-tx-1',
      amount: '25.00',
    });

    await waitUntil(async () => {
      const conn = em.getConnection();
      const rows = await conn.execute<{ status: string }[]>(
        "select status from wager_transactions where external_transaction_id = 'inbox-tx-1'",
      );
      return rows.length === 1 && rows[0]?.status === 'PROCESSED';
    });

    const conn = em.getConnection();
    const [walletRow] = await conn.execute<{ balance: string }[]>('select balance from wallets where id = ?', [
      wallet.id,
    ]);
    expect(walletRow?.balance).toBe('75.00');
  }, 20000);

  it('a redelivery of the same business message (same messageId, new SQS delivery) does not double-apply', async () => {
    const playerId = randomUuid();
    const wallet = await createWallet.execute(
      { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      { correlationId: 'test' },
    );
    const messageId = `msg-${randomUuid()}`;

    await sendWagerTransactionRequested(sqs, {
      messageId,
      dedupSuffix: 'attempt-1',
      walletId: wallet.id,
      playerId,
      externalTransactionId: 'inbox-tx-redelivery',
      amount: '40.00',
    });

    await waitUntil(async () => {
      const rows = await em
        .getConnection()
        .execute<{ status: string }[]>(
          "select status from wager_transactions where external_transaction_id = 'inbox-tx-redelivery'",
        );
      return rows.length === 1 && rows[0]?.status === 'PROCESSED';
    });

    // redelivery: mesmo messageId de negócio, novo MessageDeduplicationId (simula o broker
    // reentregando com um SQS MessageId diferente)
    await sendWagerTransactionRequested(sqs, {
      messageId,
      dedupSuffix: 'attempt-2-redelivery',
      walletId: wallet.id,
      playerId,
      externalTransactionId: 'inbox-tx-redelivery',
      amount: '40.00',
    });

    // dá tempo do consumer processar a redelivery (que deve ser deduplicada, não reaplicada)
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const conn = em.getConnection();
    const [walletRow] = await conn.execute<{ balance: string }[]>('select balance from wallets where id = ?', [
      wallet.id,
    ]);
    expect(walletRow?.balance).toBe('60.00'); // um único débito de 40.00, não dois

    const ledgerRows = await conn.execute(
      "select 1 from wallet_ledger_entries e join wager_transactions t on t.id = e.transaction_id where t.external_transaction_id = 'inbox-tx-redelivery'",
    );
    expect(ledgerRows).toHaveLength(1);

    const inboxRows = await conn.execute<{ count: string }[]>(
      "select count(*)::text as count from inbox_messages where message_id = ?",
      [messageId],
    );
    expect(inboxRows[0]?.count).toBe('1'); // uma única linha de inbox, apesar de 2 entregas
  }, 20000);
});
