import { Migration } from '@mikro-orm/migrations';

/** Campos de bookkeeping do reprocessamento de PENDING_REFERENCE (worker com backoff exponencial). */
export class Migration20260826161858_PendingReferenceRetry extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "reference_retry_count" integer not null default 0,
        add column "next_reference_check_at" timestamptz null;
    `);

    // Usado pelo worker com FOR UPDATE SKIP LOCKED — só transações PENDING_REFERENCE importam aqui.
    this.addSql(`
      create index "wager_tx_pending_reference_due_index"
        on "wager_transactions" ("next_reference_check_at")
        where "status" = 'PENDING_REFERENCE';
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "wager_tx_pending_reference_due_index";`);
    this.addSql(`
      alter table "wager_transactions"
        drop column "reference_retry_count",
        drop column "next_reference_check_at";
    `);
  }
}
