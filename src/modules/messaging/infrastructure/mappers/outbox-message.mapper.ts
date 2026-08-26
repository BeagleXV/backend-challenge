import { OutboxMessage } from '../../domain/outbox-message';
import { OutboxMessageEntity } from '../entities/outbox-message.entity';

export function outboxMessageToDomain(entity: OutboxMessageEntity): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: entity.id,
    aggregateId: entity.aggregateId,
    eventType: entity.eventType,
    payload: entity.payload,
    occurredAt: entity.occurredAt,
    attempts: entity.attempts,
    nextAttemptAt: entity.nextAttemptAt,
    publishedAt: entity.publishedAt,
  });
}

export function outboxMessageToNewEntity(message: OutboxMessage): OutboxMessageEntity {
  const entity = new OutboxMessageEntity();
  entity.id = message.id;
  entity.aggregateId = message.aggregateId;
  entity.eventType = message.eventType;
  entity.payload = message.payload as Record<string, unknown>;
  entity.occurredAt = message.occurredAt;
  entity.attempts = message.attempts;
  entity.nextAttemptAt = message.nextAttemptAt;
  entity.publishedAt = message.publishedAt;
  return entity;
}

export function syncOutboxMessageEntity(entity: OutboxMessageEntity, message: OutboxMessage): void {
  entity.attempts = message.attempts;
  entity.nextAttemptAt = message.nextAttemptAt;
  entity.publishedAt = message.publishedAt;
}
