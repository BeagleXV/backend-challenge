import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, MikroOrmHealthIndicator } from '@nestjs/terminus';
import { ApiTags } from '@nestjs/swagger';
import { SqsHealthIndicator } from './sqs-health.indicator';
import { Public } from '../../auth/public.decorator';

/** Endpoints de health não exigem autenticação (seção 9 do desafio). */
@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: MikroOrmHealthIndicator,
    private readonly sqs: SqsHealthIndicator,
  ) {}

  /** Processo vivo — nunca depende de dependências externas. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** PostgreSQL e SQS alcançáveis. */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.db.pingCheck('postgres'),
      () => this.sqs.check('sqs'),
    ]);
  }
}
