import { Injectable } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Decimal } from 'decimal.js';
import {
  LedgerPage,
  LedgerSum,
  WalletLedgerEntryRepository,
} from '../../application/ports/wallet-ledger-entry-repository';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { LedgerDirection } from '../../domain/wallet-ledger-entry';
import { Money } from '../../../../shared/domain/money';
import { WalletEntity } from '../entities/wallet.entity';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity';
import { walletLedgerEntryToDomain, walletLedgerEntryToNewEntity } from '../mappers/wallet-ledger-entry.mapper';
import { RequestValidationError } from '../../application/errors';

interface Cursor {
  createdAt: string;
  id: string;
}

/** Cursor opaco e estável: base64(createdAt ISO + "|" + id). Ordenação: created_at desc, id desc. */
function encodeCursor(entity: WalletLedgerEntryEntity): string {
  return Buffer.from(`${entity.createdAt.toISOString()}|${entity.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): Cursor {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id) {
    throw new RequestValidationError(`Invalid ledger cursor: "${cursor}"`);
  }
  return { createdAt, id };
}

@Injectable()
export class MikroWalletLedgerEntryRepository implements WalletLedgerEntryRepository {
  async insert(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    const entity = walletLedgerEntryToNewEntity(
      entry,
      em.getReference(WalletEntity, entry.walletId),
      em.getReference(WagerTransactionEntity, entry.transactionId),
    );
    em.persist(entity);
    await em.flush();
  }

  async findByWalletId(
    em: EntityManager,
    walletId: string,
    options: { cursor?: string; limit: number },
  ): Promise<LedgerPage> {
    const qb = em.createQueryBuilder(WalletLedgerEntryEntity, 'e').where({ wallet: walletId });

    if (options.cursor) {
      const { createdAt, id } = decodeCursor(options.cursor);
      qb.andWhere('(e.created_at, e.id) < (?, ?)', [createdAt, id]);
    }

    qb.orderBy({ createdAt: 'desc', id: 'desc' }).limit(options.limit + 1);
    const entities = await qb.getResultList();

    const hasMore = entities.length > options.limit;
    const page = hasMore ? entities.slice(0, options.limit) : entities;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last) : undefined;

    return { entries: page.map(walletLedgerEntryToDomain), nextCursor };
  }

  async sumForWallet(em: EntityManager, walletId: string, currency: string): Promise<LedgerSum> {
    const rows = await em.getConnection().execute<{ direction: string; total: string; cnt: string }[]>(
      `select direction, coalesce(sum(money_amount), 0) as total, count(*) as cnt
       from wallet_ledger_entries where wallet_id = ? group by direction`,
      [walletId],
      'all',
      em.getTransactionContext(),
    );

    let balance = Money.zero(currency);
    let count = 0;
    for (const row of rows) {
      const amount = Money.from({ amount: new Decimal(row.total).toFixed(2), currency });
      balance = row.direction === LedgerDirection.Credit ? balance.add(amount) : balance.subtract(amount);
      count += Number(row.cnt);
    }
    return { balance, count };
  }
}
