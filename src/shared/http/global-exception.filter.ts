import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Response } from 'express';
import { DomainError } from '../domain/errors';
import { InsufficientBalanceError, InvalidTransactionStateError, MissingReferenceError, UnbalancedLedgerEntryError } from '../../modules/wallets/domain/errors';
import { WalletAlreadyExistsError, WalletNotFoundError, IdempotencyConflictError, RequestValidationError } from '../../modules/wallets/application/errors';
import { MetricsService } from '../../modules/observability/metrics/metrics.service';

/**
 * Mapeamento de status HTTP (ver ARCHITECTURE.md seção 6): a API precisa distinguir com clareza,
 * e de forma consistente entre endpoints, payload inválido / conflito de idempotência / rejeição de
 * negócio / aceite pendente / falha transitória — nunca colapsar tudo em um único código.
 */
const STATUS_BY_ERROR = new Map<Function, number>([
  [WalletAlreadyExistsError, HttpStatus.CONFLICT],
  [IdempotencyConflictError, HttpStatus.CONFLICT],
  [WalletNotFoundError, HttpStatus.NOT_FOUND],
  [RequestValidationError, HttpStatus.BAD_REQUEST],
  [MissingReferenceError, HttpStatus.BAD_REQUEST],
  [InvalidTransactionStateError, HttpStatus.BAD_REQUEST],
  [UnbalancedLedgerEntryError, HttpStatus.BAD_REQUEST],
  // InsufficientBalanceError nunca deveria escapar do use case (é convertida em REJECTED); se
  // escapar mesmo assim, é mais seguro tratar como payload/estado inválido do que como 5xx.
  [InsufficientBalanceError, HttpStatus.BAD_REQUEST],
]);

@Injectable()
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly metrics: MetricsService,
    @InjectPinoLogger(GlobalExceptionFilter.name) private readonly logger: PinoLogger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    const status = this.statusFor(exception);
    if (status) {
      const err = exception as Error;
      response.status(status).json({ statusCode: status, error: err.name, message: err.message });
      return;
    }

    this.metrics.infraTransientErrorsTotal.inc({ source: 'http' });
    this.logger.error(
      {
        err: exception instanceof Error ? exception.message : String(exception),
        stack: exception instanceof Error ? exception.stack : undefined,
      },
      'Unhandled error — treating as transient infrastructure failure',
    );
    response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      error: 'ServiceUnavailable',
      message: 'Temporarily unavailable, safe to retry',
    });
  }

  private statusFor(exception: unknown): number | undefined {
    for (const [errorClass, status] of STATUS_BY_ERROR) {
      if (exception instanceof errorClass) {
        return status;
      }
    }
    // Qualquer outro erro de domínio não catalogado acima: trata como payload/regra inválida (400)
    // em vez de cair no 503 genérico — é mais informativo pro provedor decidir se pode reenviar.
    if (exception instanceof DomainError) {
      return HttpStatus.BAD_REQUEST;
    }
    return undefined;
  }
}
