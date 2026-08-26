import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'aggregate_id' })
  aggregateId!: string;

  @Property({ type: 'string', length: 128, fieldName: 'event_type' })
  eventType!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ type: 'datetime', fieldName: 'occurred_at' })
  occurredAt!: Date;

  @Property({ type: 'integer' })
  attempts!: number;

  @Property({ type: 'datetime', fieldName: 'next_attempt_at', nullable: true })
  nextAttemptAt?: Date;

  @Property({ type: 'datetime', fieldName: 'published_at', nullable: true })
  publishedAt?: Date;
}
