import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial: wallets, wager_transactions, wallet_ledger_entries.
 *
 * As invariantes do domínio (seção 5.9 do desafio) são aplicadas aqui, não só em código de
 * aplicação: unicidade de wallet por (player, moeda), saldo nunca negativo, idempotência única,
 * uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação, e imutabilidade
 * do ledger via trigger (funciona mesmo que a role da aplicação seja dona da tabela — REVOKE não
 * afeta o owner no Postgres, um trigger BEFORE UPDATE/DELETE afeta qualquer role).
 */
export class Migration20260826143806_InitialSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" uuid not null,
        "player_id" uuid not null,
        "currency" varchar(3) not null,
        "balance" numeric(19,2) not null,
        "version" integer not null,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null,
        constraint "wallets_pkey" primary key ("id"),
        constraint "wallets_player_currency_unique" unique ("player_id", "currency"),
        constraint "wallets_balance_non_negative" check ("balance" >= 0)
      );
    `);

    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" varchar(255) not null,
        "external_transaction_id" varchar(255) not null,
        "idempotency_key" varchar(512) not null,
        "payload_hash" varchar(128) not null,
        "wallet_id" uuid not null,
        "player_id" uuid not null,
        "round_id" varchar(255) not null,
        "game_id" varchar(255) not null,
        "kind" varchar(20) not null,
        "money_amount" numeric(19,2) not null,
        "money_currency" varchar(3) not null,
        "reference_external_transaction_id" varchar(255) null,
        "created_at" timestamptz not null,
        "status" varchar(20) not null,
        "reference_transaction_id" uuid null,
        "failure_code" varchar(64) null,
        "processed_at" timestamptz null,
        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_tx_idempotency_key_unique" unique ("idempotency_key"),
        constraint "wager_tx_provider_external_unique" unique ("provider_id", "external_transaction_id"),
        constraint "wager_tx_kind_check" check ("kind" in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint "wager_tx_status_check" check ("status" in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint "wager_tx_wallet_fk" foreign key ("wallet_id") references "wallets" ("id"),
        constraint "wager_tx_reference_fk" foreign key ("reference_transaction_id") references "wager_transactions" ("id")
      );
    `);

    this.addSql(`create index "wager_tx_wallet_id_index" on "wager_transactions" ("wallet_id");`);

    // Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação (regra 4, seção 7).
    // Índice parcial: só aplica a unicidade entre transações PROCESSED — REJECTED/FAILED não contam.
    this.addSql(`
      create unique index "wager_tx_reference_kind_processed_unique"
        on "wager_transactions" ("reference_transaction_id", "kind")
        where "status" = 'PROCESSED' and "reference_transaction_id" is not null;
    `);

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" varchar(10) not null,
        "money_amount" numeric(19,2) not null,
        "money_currency" varchar(3) not null,
        "balance_before_amount" numeric(19,2) not null,
        "balance_before_currency" varchar(3) not null,
        "balance_after_amount" numeric(19,2) not null,
        "balance_after_currency" varchar(3) not null,
        "created_at" timestamptz not null,
        constraint "wallet_ledger_entries_pkey" primary key ("id"),
        constraint "wallet_ledger_tx_wallet_unique" unique ("transaction_id", "wallet_id"),
        constraint "wallet_ledger_direction_check" check ("direction" in ('DEBIT','CREDIT')),
        constraint "wallet_ledger_wallet_fk" foreign key ("wallet_id") references "wallets" ("id"),
        constraint "wallet_ledger_transaction_fk" foreign key ("transaction_id") references "wager_transactions" ("id")
      );
    `);

    this.addSql(`create index "wallet_ledger_wallet_id_created_at_index" on "wallet_ledger_entries" ("wallet_id", "created_at");`);

    this.addSql(`
      create function "prevent_wallet_ledger_mutation"() returns trigger as $$
      begin
        raise exception 'wallet_ledger_entries is append-only: % on % is not allowed', tg_op, old.id;
      end;
      $$ language plpgsql;
    `);

    this.addSql(`
      create trigger "wallet_ledger_entries_immutable"
        before update or delete on "wallet_ledger_entries"
        for each row execute function "prevent_wallet_ledger_mutation"();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger if exists "wallet_ledger_entries_immutable" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists "prevent_wallet_ledger_mutation"();`);
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop table if exists "wallets" cascade;`);
  }
}
