import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplicationContext } from '@nestjs/common';
import { createTestApp, truncateAll } from '../support/test-app';

/**
 * Garantias que a seção 5.9 do desafio exige no SCHEMA, não só em código de aplicação. Testadas
 * com SQL bruto contra o Postgres real — sem passar pelas classes de domínio, propositalmente,
 * para provar que o banco recusa por conta própria, mesmo se a camada de aplicação tivesse um bug.
 */
describe('schema constraints (Postgres real)', () => {
  let app: INestApplicationContext;
  let em: EntityManager;

  beforeAll(async () => {
    app = await createTestApp();
    em = app.get(EntityManager).fork();
  });

  beforeEach(async () => {
    await truncateAll(app);
  });

  afterAll(async () => {
    await app.close();
  }, 20000);

  async function insertWallet(overrides: Partial<Record<string, unknown>> = {}) {
    const base = {
      id: crypto.randomUUID(),
      player_id: crypto.randomUUID(),
      currency: 'BRL',
      balance: '100.00',
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
      ...overrides,
    };
    await em
      .getConnection()
      .execute(
        `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?,?,?,?,?,?,?)`,
        [base.id, base.player_id, base.currency, base.balance, base.version, base.created_at, base.updated_at],
      );
    return base;
  }

  it('rejects a negative wallet balance', async () => {
    await expect(insertWallet({ balance: '-1.00' })).rejects.toThrow();
  });

  it('rejects a second wallet for the same player+currency', async () => {
    const playerId = crypto.randomUUID();
    await insertWallet({ player_id: playerId, currency: 'BRL' });
    await expect(insertWallet({ player_id: playerId, currency: 'BRL' })).rejects.toThrow();
  });

  it('allows the same player to have wallets in different currencies', async () => {
    const playerId = crypto.randomUUID();
    await insertWallet({ player_id: playerId, currency: 'BRL' });
    await expect(insertWallet({ player_id: playerId, currency: 'USD' })).resolves.toBeDefined();
  });

  async function insertWagerTransaction(walletId: string, overrides: Partial<Record<string, unknown>> = {}) {
    const base = {
      id: crypto.randomUUID(),
      provider_id: 'provider-a',
      external_transaction_id: crypto.randomUUID(),
      idempotency_key: crypto.randomUUID(),
      payload_hash: 'hash',
      wallet_id: walletId,
      player_id: crypto.randomUUID(),
      round_id: 'round-1',
      game_id: 'game-1',
      kind: 'BET',
      money_amount: '10.00',
      money_currency: 'BRL',
      created_at: new Date(),
      status: 'PENDING',
      ...overrides,
    };
    await em.getConnection().execute(
      `insert into wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
        player_id, round_id, game_id, kind, money_amount, money_currency, created_at, status
      ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        base.id,
        base.provider_id,
        base.external_transaction_id,
        base.idempotency_key,
        base.payload_hash,
        base.wallet_id,
        base.player_id,
        base.round_id,
        base.game_id,
        base.kind,
        base.money_amount,
        base.money_currency,
        base.created_at,
        base.status,
      ],
    );
    return base;
  }

  it('rejects a duplicate idempotency_key', async () => {
    const wallet = await insertWallet();
    const key = crypto.randomUUID();
    await insertWagerTransaction(wallet.id, { idempotency_key: key, external_transaction_id: 'ext-1' });
    await expect(
      insertWagerTransaction(wallet.id, { idempotency_key: key, external_transaction_id: 'ext-2' }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate (provider_id, external_transaction_id)', async () => {
    const wallet = await insertWallet();
    await insertWagerTransaction(wallet.id, { provider_id: 'provider-a', external_transaction_id: 'dup-1' });
    await expect(
      insertWagerTransaction(wallet.id, { provider_id: 'provider-a', external_transaction_id: 'dup-1' }),
    ).rejects.toThrow();
  });

  it('rejects reversing the same reference twice with the same kind while PROCESSED', async () => {
    const wallet = await insertWallet();
    const bet = await insertWagerTransaction(wallet.id, { kind: 'BET', status: 'PROCESSED' });
    await insertWagerTransaction(wallet.id, {
      kind: 'REFUND',
      status: 'PROCESSED',
      reference_external_transaction_id: bet.external_transaction_id,
    });
    await em
      .getConnection()
      .execute(`update wager_transactions set reference_transaction_id = ? where kind = 'REFUND'`, [bet.id]);

    // segunda tentativa de REFUND PROCESSED referenciando a mesma BET
    const secondRefund = await insertWagerTransaction(wallet.id, {
      kind: 'REFUND',
      status: 'PENDING',
      reference_external_transaction_id: bet.external_transaction_id,
    });
    await expect(
      em
        .getConnection()
        .execute(
          `update wager_transactions set status = 'PROCESSED', reference_transaction_id = ? where id = ?`,
          [bet.id, secondRefund.id],
        ),
    ).rejects.toThrow();
  });

  it('allows the same reference to be reversed by different kinds (e.g. REFUND then ROLLBACK)', async () => {
    const wallet = await insertWallet();
    const bet = await insertWagerTransaction(wallet.id, { kind: 'BET', status: 'PROCESSED' });
    const refund = await insertWagerTransaction(wallet.id, {
      kind: 'REFUND',
      status: 'PROCESSED',
      reference_external_transaction_id: bet.external_transaction_id,
    });
    await em
      .getConnection()
      .execute(`update wager_transactions set reference_transaction_id = ? where id = ?`, [bet.id, refund.id]);

    const rollback = await insertWagerTransaction(wallet.id, {
      kind: 'ROLLBACK',
      status: 'PENDING',
      reference_external_transaction_id: bet.external_transaction_id,
    });
    await expect(
      em
        .getConnection()
        .execute(
          `update wager_transactions set status = 'PROCESSED', reference_transaction_id = ? where id = ?`,
          [bet.id, rollback.id],
        ),
    ).resolves.toBeDefined();
  });

  it('ledger entries are append-only: UPDATE is rejected by the immutability trigger', async () => {
    const wallet = await insertWallet();
    const tx = await insertWagerTransaction(wallet.id);
    const entryId = crypto.randomUUID();
    await em.getConnection().execute(
      `insert into wallet_ledger_entries (
        id, wallet_id, transaction_id, direction, money_amount, money_currency,
        balance_before_amount, balance_before_currency, balance_after_amount, balance_after_currency, created_at
      ) values (?,?,?,?,?,?,?,?,?,?,?)`,
      [entryId, wallet.id, tx.id, 'DEBIT', '10.00', 'BRL', '100.00', 'BRL', '90.00', 'BRL', new Date()],
    );

    await expect(
      em.getConnection().execute(`update wallet_ledger_entries set money_amount = '999.00' where id = ?`, [entryId]),
    ).rejects.toThrow();
  });

  it('ledger entries are append-only: DELETE is rejected by the immutability trigger', async () => {
    const wallet = await insertWallet();
    const tx = await insertWagerTransaction(wallet.id);
    const entryId = crypto.randomUUID();
    await em.getConnection().execute(
      `insert into wallet_ledger_entries (
        id, wallet_id, transaction_id, direction, money_amount, money_currency,
        balance_before_amount, balance_before_currency, balance_after_amount, balance_after_currency, created_at
      ) values (?,?,?,?,?,?,?,?,?,?,?)`,
      [entryId, wallet.id, tx.id, 'DEBIT', '10.00', 'BRL', '100.00', 'BRL', '90.00', 'BRL', new Date()],
    );

    await expect(
      em.getConnection().execute(`delete from wallet_ledger_entries where id = ?`, [entryId]),
    ).rejects.toThrow();
  });

  it('rejects two ledger entries for the same (transaction_id, wallet_id)', async () => {
    const wallet = await insertWallet();
    const tx = await insertWagerTransaction(wallet.id);
    const insertEntry = (id: string) =>
      em.getConnection().execute(
        `insert into wallet_ledger_entries (
          id, wallet_id, transaction_id, direction, money_amount, money_currency,
          balance_before_amount, balance_before_currency, balance_after_amount, balance_after_currency, created_at
        ) values (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, wallet.id, tx.id, 'DEBIT', '10.00', 'BRL', '100.00', 'BRL', '90.00', 'BRL', new Date()],
      );
    await insertEntry(crypto.randomUUID());
    await expect(insertEntry(crypto.randomUUID())).rejects.toThrow();
  });

  it('rejects a wager_transaction referencing a non-existent wallet (FK)', async () => {
    await expect(insertWagerTransaction(crypto.randomUUID())).rejects.toThrow();
  });
});
