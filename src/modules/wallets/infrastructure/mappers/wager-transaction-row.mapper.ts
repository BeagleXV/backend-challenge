import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { Money } from '../../../../shared/domain/money';
import { FailureCode } from '../../../../shared/domain/failure-code';

/** Linha crua retornada por SQL manual (INSERT ... ON CONFLICT ... RETURNING), colunas em snake_case. */
export interface WagerTransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  money_amount: string;
  money_currency: string;
  reference_external_transaction_id: string | null;
  created_at: Date;
  status: string;
  reference_transaction_id: string | null;
  failure_code: string | null;
  processed_at: Date | null;
  reference_retry_count: number;
  next_reference_check_at: Date | null;
}

export function wagerTransactionRowToDomain(row: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind as WagerTransactionKind,
    money: Money.from({ amount: row.money_amount, currency: row.money_currency }),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    createdAt: row.created_at,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    failureCode: (row.failure_code as FailureCode | null) ?? undefined,
    processedAt: row.processed_at ?? undefined,
    referenceRetryCount: row.reference_retry_count,
    nextReferenceCheckAt: row.next_reference_check_at ?? undefined,
  });
}
