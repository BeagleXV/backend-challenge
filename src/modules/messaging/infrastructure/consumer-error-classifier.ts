import { InvalidMoneyError, CurrencyMismatchError } from '../../../shared/domain/errors';
import { MissingReferenceError } from '../../wallets/domain/errors';
import { IdempotencyConflictError, RequestValidationError } from '../../wallets/application/errors';

export type ConsumerErrorClass = 'permanent' | 'transient';

/**
 * Erros permanentes: o payload em si está errado e nenhuma retentativa vai mudar isso — manda
 * direto pra DLQ em vez de queimar as tentativas do redrive policy. Qualquer outra coisa (infra,
 * deadlock, wallet momentaneamente inexistente por uma corrida de criação) é tratada como
 * transitória — não deleta a mensagem, deixa o visibility timeout expirar e tenta de novo.
 */
export function classifyConsumerError(err: unknown): ConsumerErrorClass {
  if (
    err instanceof RequestValidationError ||
    err instanceof IdempotencyConflictError ||
    err instanceof MissingReferenceError ||
    err instanceof InvalidMoneyError ||
    err instanceof CurrencyMismatchError
  ) {
    return 'permanent';
  }
  return 'transient';
}
