import { Injectable } from '@nestjs/common';
import { LockMode, type EntityManager } from '@mikro-orm/postgresql';
import {
  ClaimResult,
  WagerTransactionRepository,
} from '../../application/ports/wager-transaction-repository';
import {
  CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity';
import {
  syncWagerTransactionMutableFields,
  wagerTransactionToDomain,
} from '../mappers/wager-transaction.mapper';
import { WagerTransactionRow, wagerTransactionRowToDomain } from '../mappers/wager-transaction-row.mapper';

const CLAIM_SQL = `
  insert into wager_transactions (
    id, provider_id, external_transaction_id, idempotency_key, payload_hash,
    wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
    reference_external_transaction_id, created_at, status
  ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  on conflict (idempotency_key) do nothing
  returning *
`;

@Injectable()
export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  async claim(em: EntityManager, props: CreateWagerTransactionProps): Promise<ClaimResult> {
    const rows = await em.getConnection().execute<WagerTransactionRow[]>(
      CLAIM_SQL,
      [
        props.id,
        props.providerId,
        props.externalTransactionId,
        props.idempotencyKey,
        props.payloadHash,
        props.walletId,
        props.playerId,
        props.roundId,
        props.gameId,
        props.kind,
        props.money.toJSON().amount,
        props.money.currency,
        props.referenceExternalTransactionId ?? null,
        props.createdAt,
        WagerTransactionStatus.Pending,
      ],
      'all',
      em.getTransactionContext(),
    );

    const [row] = rows;
    if (row) {
      return { won: true, transaction: wagerTransactionRowToDomain(row) };
    }

    const existing = await this.findByIdempotencyKey(em, props.idempotencyKey);
    if (!existing) {
      // Sob READ COMMITTED, um conflito de unique index bloqueia até a outra transação
      // commitar/abortar — então a linha deveria estar visível aqui. Se não está, é um estado
      // que não deveria acontecer; melhor falhar alto (erro transitório, seguro para retry) do
      // que devolver um resultado inconsistente.
      throw new Error(
        `Idempotency claim conflicted but no row found for key "${props.idempotencyKey}"`,
      );
    }
    return { won: false, transaction: existing };
  }

  async findById(em: EntityManager, id: string): Promise<WagerTransaction | undefined> {
    const entity = await em.findOne(WagerTransactionEntity, { id });
    return entity ? wagerTransactionToDomain(entity) : undefined;
  }

  async findByIdForUpdate(em: EntityManager, id: string): Promise<WagerTransaction | undefined> {
    const entity = await em.findOne(WagerTransactionEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return entity ? wagerTransactionToDomain(entity) : undefined;
  }

  async findDuePendingReference(
    em: EntityManager,
    now: Date,
    limit: number,
  ): Promise<WagerTransaction[]> {
    const qb = em
      .createQueryBuilder(WagerTransactionEntity, 'w')
      .where({ status: WagerTransactionStatus.PendingReference })
      .andWhere('("w"."next_reference_check_at" is null or "w"."next_reference_check_at" <= ?)', [now])
      .orderBy({ createdAt: 'asc' })
      .limit(limit)
      .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE);

    const entities = await qb.getResultList();
    return entities.map(wagerTransactionToDomain);
  }

  async findByProviderAndExternalId(
    em: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const entity = await em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    return entity ? wagerTransactionToDomain(entity) : undefined;
  }

  async hasProcessedReversal(
    em: EntityManager,
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<boolean> {
    const count = await em.count(WagerTransactionEntity, {
      referenceTransaction: referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async update(em: EntityManager, transaction: WagerTransaction): Promise<void> {
    const entity = await em.findOneOrFail(WagerTransactionEntity, { id: transaction.id });
    const referenceTransactionRef = transaction.referenceTransactionId
      ? em.getReference(WagerTransactionEntity, transaction.referenceTransactionId)
      : undefined;
    syncWagerTransactionMutableFields(entity, transaction, referenceTransactionRef);
    await em.flush();
  }

  async findByIdempotencyKey(
    em: EntityManager,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    const entity = await em.findOne(WagerTransactionEntity, { idempotencyKey });
    return entity ? wagerTransactionToDomain(entity) : undefined;
  }
}
