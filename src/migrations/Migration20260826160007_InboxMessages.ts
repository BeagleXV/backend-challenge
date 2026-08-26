import { Migration } from '@mikro-orm/migrations';

/** Dedup de entrega de mensageria: PK composta (consumer_name, message_id), seção 6.5 do desafio. */
export class Migration20260826160007_InboxMessages extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "inbox_messages" (
        "consumer_name" varchar(128) not null,
        "message_id" varchar(255) not null,
        "payload_hash" varchar(128) not null,
        "received_at" timestamptz not null,
        "processed_at" timestamptz null,
        constraint "inbox_messages_pkey" primary key ("consumer_name", "message_id")
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "inbox_messages" cascade;`);
  }
}
