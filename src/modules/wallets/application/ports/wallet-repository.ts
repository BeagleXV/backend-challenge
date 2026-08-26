import type { EntityManager } from '@mikro-orm/postgresql';
import { Wallet } from '../../domain/wallet';

export interface WalletRepository {
  findByPlayerAndCurrency(
    em: EntityManager,
    playerId: string,
    currency: string,
  ): Promise<Wallet | undefined>;

  findById(em: EntityManager, id: string): Promise<Wallet | undefined>;

  /** Adquire SELECT ... FOR UPDATE na linha da wallet — serializa concorrência por walletId. */
  lockById(em: EntityManager, id: string): Promise<Wallet | undefined>;

  insert(em: EntityManager, wallet: Wallet): Promise<void>;

  /** Sincroniza os campos mutáveis de uma wallet já carregada/travada nesta transação. */
  update(em: EntityManager, wallet: Wallet): Promise<void>;
}

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');
