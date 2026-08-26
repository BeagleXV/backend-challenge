import { Entity, PrimaryKeyProp, Property } from '@mikro-orm/core';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  [PrimaryKeyProp]?: ['consumerName', 'messageId'];

  @Property({ type: 'string', length: 128, primary: true, fieldName: 'consumer_name' })
  consumerName!: string;

  @Property({ type: 'string', length: 255, primary: true, fieldName: 'message_id' })
  messageId!: string;

  @Property({ type: 'string', length: 128, fieldName: 'payload_hash' })
  payloadHash!: string;

  @Property({ type: 'datetime', fieldName: 'received_at' })
  receivedAt!: Date;

  @Property({ type: 'datetime', fieldName: 'processed_at', nullable: true })
  processedAt?: Date;
}
