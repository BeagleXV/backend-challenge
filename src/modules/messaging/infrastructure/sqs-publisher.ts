import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { OutboxMessage } from '../domain/outbox-message';
import { SQS_CLIENT } from './sqs-client.provider';

@Injectable()
export class SqsPublisher {
  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly config: ConfigService,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.config.getOrThrow<string>('SQS_INTEGRATION_EVENTS_QUEUE_URL'),
        MessageBody: JSON.stringify(message.toEventJSON()),
        // FIFO: ordena eventos do mesmo agregado entre si; dedup explícito porque a fila não usa
        // ContentBasedDeduplication (o corpo pode legitimamente repetir entre eventos distintos).
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
    );
  }
}
