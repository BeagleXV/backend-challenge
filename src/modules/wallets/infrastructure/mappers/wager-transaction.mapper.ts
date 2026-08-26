import { WagerTransaction } from '../../domain/wager-transaction';
import { Money } from '../../../../shared/domain/money';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity';

export function wagerTransactionToDomain(entity: WagerTransactionEntity): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: entity.id,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    idempotencyKey: entity.idempotencyKey,
    payloadHash: entity.payloadHash,
    walletId: entity.wallet.id,
    playerId: entity.playerId,
    roundId: entity.roundId,
    gameId: entity.gameId,
    kind: entity.kind,
    money: Money.from({ amount: entity.moneyAmount, currency: entity.moneyCurrency }),
    referenceExternalTransactionId: entity.referenceExternalTransactionId ?? undefined,
    createdAt: entity.createdAt,
    status: entity.status,
    referenceTransactionId: entity.referenceTransaction?.id ?? undefined,
    failureCode: entity.failureCode ?? undefined,
    processedAt: entity.processedAt ?? undefined,
    referenceRetryCount: entity.referenceRetryCount,
    nextReferenceCheckAt: entity.nextReferenceCheckAt ?? undefined,
  });
}

/**
 * Constrói a entidade a persistir. `walletRef`/`referenceTransactionRef` são referências do
 * EntityManager (`em.getReference(...)`) — evita um round-trip só para popular a FK.
 */
export function wagerTransactionToNewEntity(
  transaction: WagerTransaction,
  walletRef: WagerTransactionEntity['wallet'],
  referenceTransactionRef?: WagerTransactionEntity['referenceTransaction'],
): WagerTransactionEntity {
  const entity = new WagerTransactionEntity();
  entity.id = transaction.id;
  entity.providerId = transaction.providerId;
  entity.externalTransactionId = transaction.externalTransactionId;
  entity.idempotencyKey = transaction.idempotencyKey;
  entity.payloadHash = transaction.payloadHash;
  entity.wallet = walletRef;
  entity.playerId = transaction.playerId;
  entity.roundId = transaction.roundId;
  entity.gameId = transaction.gameId;
  entity.kind = transaction.kind;
  entity.moneyAmount = transaction.money.toJSON().amount;
  entity.moneyCurrency = transaction.money.currency;
  entity.referenceExternalTransactionId = transaction.referenceExternalTransactionId;
  entity.createdAt = transaction.createdAt;
  entity.referenceRetryCount = transaction.referenceRetryCount;
  entity.nextReferenceCheckAt = transaction.nextReferenceCheckAt;
  syncWagerTransactionMutableFields(entity, transaction, referenceTransactionRef);
  return entity;
}

/** Sincroniza os campos que mudam ao longo do ciclo de vida (status/referência/falha/processedAt/retry). */
export function syncWagerTransactionMutableFields(
  entity: WagerTransactionEntity,
  transaction: WagerTransaction,
  referenceTransactionRef?: WagerTransactionEntity['referenceTransaction'],
): void {
  entity.status = transaction.status;
  entity.referenceTransaction = referenceTransactionRef;
  entity.failureCode = transaction.failureCode;
  entity.processedAt = transaction.processedAt;
  entity.referenceRetryCount = transaction.referenceRetryCount;
  entity.nextReferenceCheckAt = transaction.nextReferenceCheckAt;
}
