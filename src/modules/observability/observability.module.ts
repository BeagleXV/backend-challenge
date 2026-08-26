import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { MessagingModule } from '../messaging/messaging.module';
import { SqsHealthIndicator } from './health/sqs-health.indicator';
import { HealthController } from './health/health.controller';
import { MetricsModule } from './metrics/metrics.module';
import { MetricsController } from './metrics/metrics.controller';

@Module({
  imports: [TerminusModule, MessagingModule, MetricsModule],
  controllers: [HealthController, MetricsController],
  providers: [SqsHealthIndicator],
})
export class ObservabilityModule {}
