import { Module } from '@nestjs/common';
import { MessagingModule } from './messaging.module';
import { WalletsModule } from '../wallets/wallets.module';
import { SqsConsumerService } from './infrastructure/sqs-consumer.service';
import { MetricsModule } from '../observability/metrics/metrics.module';

/**
 * Módulo de composição: liga o consumer SQS (infraestrutura de mensageria) ao
 * ProcessWagerTransactionUseCase (aplicação de wallets) — mesmo use case da entrada HTTP. Vive
 * separado de MessagingModule e WalletsModule de propósito, para não criar um ciclo de import
 * (WalletsModule já depende de MessagingModule para OUTBOX_PORT/INBOX_PORT).
 */
@Module({
  imports: [MessagingModule, WalletsModule, MetricsModule],
  providers: [SqsConsumerService],
})
export class SqsConsumerModule {}
