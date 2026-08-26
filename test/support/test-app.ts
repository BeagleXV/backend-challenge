import 'reflect-metadata';
import { INestApplicationContext, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient, PurgeQueueCommand } from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module';

/**
 * Bootstrap de app real para testes de integração/concorrência — mesmo AppModule da produção,
 * incluindo SqsConsumerService e os workers agendados (@Interval). Isso é deliberado: queremos
 * exercitar o sistema real, não uma versão fatiada só para teste (a seção 13 do desafio proíbe
 * testes que substituem Postgres/SQS por mocks).
 */
export async function createTestApp(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(AppModule, { logger: false });
}

export function get<T>(app: INestApplicationContext, token: Type<T> | symbol): T {
  return app.get(token);
}

/** Limpa todas as tabelas de negócio — usar entre testes que não podem compartilhar estado. */
export async function truncateAll(app: INestApplicationContext): Promise<void> {
  const em = app.get(EntityManager).fork();
  await em
    .getConnection()
    .execute(
      'truncate table wallet_ledger_entries, wager_transactions, outbox_messages, inbox_messages, wallets restart identity cascade',
    );
}

/** Purga as filas via um client SQS avulso (evita depender de resolver o provider do Nest por token). */
export async function purgeQueuesDirect(): Promise<void> {
  const sqs = new SQSClient({
    region: process.env.AWS_REGION,
    endpoint: process.env.SQS_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  const queues = [
    process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL,
    process.env.SQS_WAGER_TRANSACTIONS_DLQ_URL,
    process.env.SQS_INTEGRATION_EVENTS_QUEUE_URL,
  ].filter((url): url is string => Boolean(url));

  for (const queueUrl of queues) {
    try {
      await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
    } catch {
      // PurgeQueue só pode rodar 1x a cada 60s por fila no SQS real; no LocalStack isso não é
      // imposto, mas ignoramos qualquer erro aqui mesmo assim — purge é limpeza best-effort entre
      // testes, não uma asserção.
    }
  }
  sqs.destroy();
}

export function randomUuid(): string {
  return crypto.randomUUID();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll com timeout — para esperar efeitos assíncronos (outbox, workers) sem sleep fixo. */
export async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}
