import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { ReceiveMessageCommand, SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createTestApp, purgeQueuesDirect, randomUuid, truncateAll, waitUntil } from '../support/test-app';

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

describe('malformed messages go straight to the DLQ', () => {
  let app: INestApplicationContext;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll(app);
    await purgeQueuesDirect();
  });

  afterAll(async () => {
    await app.close();
  }, 20000);

  it('a malformed message on the inbound queue is sent straight to the DLQ, not retried 5x', async () => {
    const sqs = sqsClient();
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL,
          MessageBody: '{not valid json',
          MessageGroupId: 'malformed-test',
          MessageDeduplicationId: randomUuid(),
        }),
      );

      await waitUntil(
        async () => {
          const result = await sqs.send(
            new ReceiveMessageCommand({
              QueueUrl: process.env.SQS_WAGER_TRANSACTIONS_DLQ_URL,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 2,
            }),
          );
          return (result.Messages ?? []).length > 0;
        },
        { timeoutMs: 20000 },
      );
    } finally {
      sqs.destroy();
    }
  }, 25000);
});
