import { Migration } from '@mikro-orm/migrations';

/**
 * Tabela da outbox transacional. ProcessWagerTransaction precisa gravar o evento de integração na
 * MESMA transação SQL da mutação financeira — o publisher que lê essa tabela e publica no SQS roda
 * de forma assíncrona e independente.
 */
export class Migration20260826145929_OutboxMessages extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "outbox_messages" (
        "id" uuid not null,
        "aggregate_id" uuid not null,
        "event_type" varchar(128) not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null,
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz null,
        "published_at" timestamptz null,
        constraint "outbox_messages_pkey" primary key ("id")
      );
    `);

    // Usado pelo publisher com SELECT ... FOR UPDATE SKIP LOCKED sobre mensagens pendentes.
    this.addSql(`
      create index "outbox_messages_pending_index"
        on "outbox_messages" ("next_attempt_at")
        where "published_at" is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "outbox_messages" cascade;`);
  }
}
