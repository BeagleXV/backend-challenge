import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { LoggerModule } from 'nestjs-pino';
import mikroOrmConfig from './mikro-orm.config';
import { loggerModuleParams } from './shared/infra/logging.config';
import { GlobalExceptionFilter } from './shared/http/global-exception.filter';
import { WalletsModule } from './modules/wallets/wallets.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { SqsConsumerModule } from './modules/messaging/sqs-consumer.module';
import { AuthModule } from './modules/auth/auth.module';
import { MetricsModule } from './modules/observability/metrics/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot(loggerModuleParams),
    ScheduleModule.forRoot(),
    MikroOrmModule.forRoot(mikroOrmConfig),
    WalletsModule,
    ObservabilityModule,
    SqsConsumerModule,
    AuthModule,
    MetricsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: GlobalExceptionFilter }],
})
export class AppModule {}
