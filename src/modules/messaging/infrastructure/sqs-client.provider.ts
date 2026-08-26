import { SQSClient } from '@aws-sdk/client-sqs';
import { ConfigService } from '@nestjs/config';
import type { Provider } from '@nestjs/common';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

/**
 * Cliente SQS bruto — usado por enquanto só pelo health check. O publisher/consumer completos
 * (com retry, DLQ, ack-after-commit) chegam na Fase 5; aqui é só a conectividade.
 */
export const sqsClientProvider: Provider = {
  provide: SQS_CLIENT,
  useFactory: (config: ConfigService): SQSClient =>
    new SQSClient({
      region: config.get<string>('AWS_REGION', 'us-east-1'),
      endpoint: config.get<string>('SQS_ENDPOINT'),
      credentials: {
        accessKeyId: config.get<string>('AWS_ACCESS_KEY_ID', 'test'),
        secretAccessKey: config.get<string>('AWS_SECRET_ACCESS_KEY', 'test'),
      },
    }),
  inject: [ConfigService],
};
