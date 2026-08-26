import { Injectable } from '@nestjs/common';
import { LockMode, type EntityManager } from '@mikro-orm/postgresql';
import { OutboxPort } from '../../../wallets/application/ports/outbox-port';
import { IntegrationEvent } from '../../../../shared/domain/integration-event';
import { OutboxMessage } from '../../domain/outbox-message';
import { OutboxMessageEntity } from '../entities/outbox-message.entity';
import {
  outboxMessageToDomain,
  outboxMessageToNewEntity,
  syncOutboxMessageEntity,
} from '../mappers/outbox-message.mapper';

@Injectable()
export class MikroOutboxRepository implements OutboxPort {
  async enqueue(em: EntityManager, event: IntegrationEvent<unknown>): Promise<void> {
    const message = OutboxMessage.enqueue(event);
    em.persist(outboxMessageToNewEntity(message) as OutboxMessageEntity);
    await em.flush();
  }

  /**
   * Lote de mensagens pendentes e devidas, travadas com `FOR UPDATE SKIP LOCKED` — publishers
   * concorrentes (múltiplas instâncias) pegam lotes disjuntos, sem duplicar nem travar um no outro.
   */
  async fetchDueForPublish(em: EntityManager, now: Date, limit: number): Promise<OutboxMessage[]> {
    const qb = em
      .createQueryBuilder(OutboxMessageEntity, 'o')
      .where({ publishedAt: null })
      .andWhere('("o"."next_attempt_at" is null or "o"."next_attempt_at" <= ?)', [now])
      .orderBy({ occurredAt: 'asc' })
      .limit(limit)
      .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE);

    const entities = await qb.getResultList();
    return entities.map(outboxMessageToDomain);
  }

  async update(em: EntityManager, message: OutboxMessage): Promise<void> {
    const entity = await em.findOneOrFail(OutboxMessageEntity, { id: message.id });
    syncOutboxMessageEntity(entity, message);
    await em.flush();
  }
}
