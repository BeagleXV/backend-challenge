import type { EntityManager } from '@mikro-orm/postgresql';
import { IntegrationEvent } from '../../../../shared/domain/integration-event';

/** Grava o evento na outbox dentro da transação SQL corrente (`em`). Nunca publica diretamente. */
export interface OutboxPort {
  enqueue(em: EntityManager, event: IntegrationEvent<unknown>): Promise<void>;
}

export const OUTBOX_PORT = Symbol('OUTBOX_PORT');
