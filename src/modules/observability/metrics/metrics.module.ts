import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/** Sem dependências de outros módulos de domínio — evita ciclos (wallets/messaging usam isso). */
@Module({
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
