import type { EntityManager } from '@mikro-orm/postgresql';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { Money } from '../../../../shared/domain/money';

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
}

export interface LedgerSum {
  balance: Money;
  count: number;
}

export interface WalletLedgerEntryRepository {
  insert(em: EntityManager, entry: WalletLedgerEntry): Promise<void>;

  findByWalletId(
    em: EntityManager,
    walletId: string,
    options: { cursor?: string; limit: number },
  ): Promise<LedgerPage>;

  /** Recalcula o saldo a partir do ledger inteiro — usado pela reconciliação (seção 9 do desafio). */
  sumForWallet(em: EntityManager, walletId: string, currency: string): Promise<LedgerSum>;
}

export const WALLET_LEDGER_ENTRY_REPOSITORY = Symbol('WALLET_LEDGER_ENTRY_REPOSITORY');
