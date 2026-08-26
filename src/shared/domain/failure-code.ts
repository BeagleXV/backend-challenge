/**
 * Códigos de falha estáveis e legíveis por máquina para transições REJECTED/FAILED.
 * O provedor usa este código para decidir se reenvia, corrige o payload ou desiste.
 */
export enum FailureCode {
  /** BET sem saldo suficiente na wallet. */
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  /** Moeda da operação difere da moeda da wallet. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** referenceExternalTransactionId não corresponde a nenhuma transação conhecida (após esgotar retries). */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** A referência já foi revertida por uma operação do mesmo tipo. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Kind da referência não é compatível com a operação (ex.: REFUND referenciando um REFUND). */
  ReferenceTypeInvalid = 'REFERENCE_TYPE_INVALID',
  /** A referência não pertence ao mesmo provider/player/wallet/moeda/rodada. */
  ReferenceOwnerMismatch = 'REFERENCE_OWNER_MISMATCH',
  /** REFUND/ROLLBACK produziria saldo negativo — distinto de saldo insuficiente numa BET. */
  NegativeBalanceOnReversal = 'NEGATIVE_BALANCE_ON_REVERSAL',
  /** PENDING_REFERENCE esgotou o limite de tentativas de reprocessamento. */
  ReferenceTimeoutExceeded = 'REFERENCE_TIMEOUT_EXCEEDED',
  /** Payload estruturalmente válido mas violando uma regra de validação de domínio não coberta acima. */
  ValidationError = 'VALIDATION_ERROR',
}
