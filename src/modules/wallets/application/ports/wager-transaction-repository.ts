import type { EntityManager } from '@mikro-orm/postgresql';
import { CreateWagerTransactionProps, WagerTransaction, WagerTransactionKind } from '../../domain/wager-transaction';

export interface ClaimResult {
  /** true: esta chamada reivindicou a operação (linha recém-inserida, PENDING). */
  won: boolean;
  transaction: WagerTransaction;
}

export interface WagerTransactionRepository {
  /**
   * Tenta inserir a transação via `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`.
   * Quem ganha a corrida (won=true) processa; os demais recebem a transação já existente
   * (won=false) para tratar como replay ou conflito de payload.
   */
  claim(em: EntityManager, props: CreateWagerTransactionProps): Promise<ClaimResult>;

  findById(em: EntityManager, id: string): Promise<WagerTransaction | undefined>;

  /** Adquire SELECT ... FOR UPDATE na linha da transação — usado pelo retry de PENDING_REFERENCE. */
  findByIdForUpdate(em: EntityManager, id: string): Promise<WagerTransaction | undefined>;

  /** PENDING_REFERENCE devidas (next_reference_check_at <= now), travadas com FOR UPDATE SKIP LOCKED. */
  findDuePendingReference(em: EntityManager, now: Date, limit: number): Promise<WagerTransaction[]>;

  findByIdempotencyKey(em: EntityManager, idempotencyKey: string): Promise<WagerTransaction | undefined>;

  findByProviderAndExternalId(
    em: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;

  /** true se já existe uma reversão PROCESSED do mesmo kind para esta referência. */
  hasProcessedReversal(
    em: EntityManager,
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<boolean>;

  /** Persiste as mudanças de estado (status/referência/failureCode/processedAt). */
  update(em: EntityManager, transaction: WagerTransaction): Promise<void>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');
