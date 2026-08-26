import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';

/**
 * Exposição no formato texto do Prometheus. Protegido pelo mesmo KeycloakJwtGuard global dos demais
 * endpoints — um scraper precisa de um token válido (client_credentials), igual qualquer outro
 * client autenticado. Excluído do Swagger: não é um endpoint JSON, formato Prometheus não se presta
 * a doc OpenAPI.
 */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async index(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
