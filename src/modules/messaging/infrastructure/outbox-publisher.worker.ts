import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Interval } from '@nestjs/schedule';
import { EntityManager } from '@mikro-orm/postgresql';
import { MikroOutboxRepository } from './repositories/outbox.repository';
import { SqsPublisher } from './sqs-publisher';
import { MetricsService } from '../../observability/metrics/metrics.service';

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 20;

/**
 * Publica mensagens pendentes da outbox no SQS. Roda em toda instância da aplicação — a
 * concorrência entre publishers de instâncias diferentes é resolvida por `FOR UPDATE SKIP LOCKED`
 * (MikroOutboxRepository.fetchDueForPublish), então cada rodada pega um lote disjunto sem duplicar
 * nem travar em outra instância.
 */
@Injectable()
export class OutboxPublisherWorker {
  private running = false;

  constructor(
    private readonly em: EntityManager,
    private readonly outbox: MikroOutboxRepository,
    private readonly publisher: SqsPublisher,
    private readonly metrics: MetricsService,
    @InjectPinoLogger(OutboxPublisherWorker.name) private readonly logger: PinoLogger,
  ) {}

  @Interval(POLL_INTERVAL_MS)
  async run(): Promise<void> {
    if (this.running) {
      // Uma rodada anterior ainda não terminou (ex.: SQS lento) — não sobrepõe.
      return;
    }
    this.running = true;
    try {
      await this.publishBatch();
    } catch (err) {
      this.metrics.infraTransientErrorsTotal.inc({ source: 'outbox_worker' });
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Outbox publish batch failed',
      );
    } finally {
      this.running = false;
    }
  }

  private async publishBatch(): Promise<void> {
    const now = new Date();
    await this.em.transactional(async (tx) => {
      const messages = await this.outbox.fetchDueForPublish(tx, now, BATCH_SIZE);
      for (const message of messages) {
        try {
          await this.publisher.publish(message);
          const publishedAt = new Date();
          message.markPublished(publishedAt);
          this.metrics.outboxPublishTotal.inc({ outcome: 'success' });
          this.metrics.outboxPublishLagSeconds.observe(
            (publishedAt.getTime() - message.occurredAt.getTime()) / 1000,
          );
          this.logger.info(
            { eventId: message.id, eventType: message.eventType, aggregateId: message.aggregateId },
            'outbox message published',
          );
        } catch (err) {
          this.metrics.outboxPublishTotal.inc({ outcome: 'retry' });
          this.logger.warn(
            {
              eventId: message.id,
              eventType: message.eventType,
              attempts: message.attempts,
              err: (err as Error).message,
            },
            'outbox message publish failed, scheduling retry',
          );
          message.scheduleRetry(new Date());
        }
        await this.outbox.update(tx, message);
      }
    });
  }
}
