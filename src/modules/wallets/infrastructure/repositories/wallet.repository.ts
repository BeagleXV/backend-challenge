import { Injectable } from '@nestjs/common';
import { LockMode, type EntityManager } from '@mikro-orm/postgresql';
import { WalletRepository } from '../../application/ports/wallet-repository';
import { Wallet } from '../../domain/wallet';
import { WalletEntity } from '../entities/wallet.entity';
import { syncWalletEntity, walletToDomain, walletToNewEntity } from '../mappers/wallet.mapper';

@Injectable()
export class MikroWalletRepository implements WalletRepository {
  async findByPlayerAndCurrency(
    em: EntityManager,
    playerId: string,
    currency: string,
  ): Promise<Wallet | undefined> {
    const entity = await em.findOne(WalletEntity, { playerId, currency });
    return entity ? walletToDomain(entity) : undefined;
  }

  async findById(em: EntityManager, id: string): Promise<Wallet | undefined> {
    const entity = await em.findOne(WalletEntity, { id });
    return entity ? walletToDomain(entity) : undefined;
  }

  async lockById(em: EntityManager, id: string): Promise<Wallet | undefined> {
    const entity = await em.findOne(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return entity ? walletToDomain(entity) : undefined;
  }

  async insert(em: EntityManager, wallet: Wallet): Promise<void> {
    em.persist(walletToNewEntity(wallet));
    await em.flush();
  }

  async update(em: EntityManager, wallet: Wallet): Promise<void> {
    const entity = await em.findOneOrFail(WalletEntity, { id: wallet.id });
    syncWalletEntity(entity, wallet);
    await em.flush();
  }
}
