import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { OutboxMessageEntity } from './infrastructure/entities/outbox-message.entity';
import { InboxMessageEntity } from './infrastructure/entities/inbox-message.entity';
import { MikroOutboxRepository } from './infrastructure/repositories/outbox.repository';
import { MikroInboxRepository } from './infrastructure/repositories/inbox.repository';
import { OUTBOX_PORT } from '../wallets/application/ports/outbox-port';
import { INBOX_PORT } from '../wallets/application/ports/inbox-port';
import { SQS_CLIENT, sqsClientProvider } from './infrastructure/sqs-client.provider';
import { SqsPublisher } from './infrastructure/sqs-publisher';
import { OutboxPublisherWorker } from './infrastructure/outbox-publisher.worker';
import { MetricsModule } from '../observability/metrics/metrics.module';

@Module({
  imports: [MikroOrmModule.forFeature([OutboxMessageEntity, InboxMessageEntity]), MetricsModule],
  providers: [
    MikroOutboxRepository,
    MikroInboxRepository,
    { provide: OUTBOX_PORT, useExisting: MikroOutboxRepository },
    { provide: INBOX_PORT, useExisting: MikroInboxRepository },
    sqsClientProvider,
    SqsPublisher,
    OutboxPublisherWorker,
  ],
  exports: [OUTBOX_PORT, INBOX_PORT, SQS_CLIENT],
})
export class MessagingModule {}
