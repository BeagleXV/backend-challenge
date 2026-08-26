export abstract class ApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** HTTP 409 — mesmo playerId+currency já tem uma wallet. */
export class WalletAlreadyExistsError extends ApplicationError {
  constructor(playerId: string, currency: string) {
    super(`Wallet already exists for player "${playerId}" in currency "${currency}"`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor(walletId: string) {
    super(`Wallet "${walletId}" not found`);
  }
}

/** HTTP 409 — mesma Idempotency-Key com payload diferente: conflito, não replay. */
export class IdempotencyConflictError extends ApplicationError {
  constructor(idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" was already used with a different payload`);
  }
}

/** HTTP 400 — payload estruturalmente válido mas violando uma regra que o use case valida cedo. */
export class RequestValidationError extends ApplicationError {}
