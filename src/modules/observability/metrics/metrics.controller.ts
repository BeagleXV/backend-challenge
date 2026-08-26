import { Controller, Get, Header } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { Public } from '../../auth/public.decorator';

/**
 * Exposição no formato texto do Prometheus. Público por convenção operacional (scraping não passa
 * por fluxo de usuário/provider) — em produção, restrito por rede/allowlist, não por este guard.
 */
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async index(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
