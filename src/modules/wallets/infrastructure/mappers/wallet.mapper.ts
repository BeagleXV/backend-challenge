import { Wallet } from '../../domain/wallet';
import { Money } from '../../../../shared/domain/money';
import { WalletEntity } from '../entities/wallet.entity';

export function walletToDomain(entity: WalletEntity): Wallet {
  return Wallet.rehydrate({
    id: entity.id,
    playerId: entity.playerId,
    currency: entity.currency,
    balance: Money.from({ amount: entity.balance, currency: entity.currency }),
    version: entity.version,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  });
}

export function walletToNewEntity(wallet: Wallet): WalletEntity {
  const entity = new WalletEntity();
  entity.id = wallet.id;
  syncWalletEntity(entity, wallet);
  return entity;
}

/** Sincroniza os campos mutáveis de uma entidade já rastreada pelo Unit of Work. */
export function syncWalletEntity(entity: WalletEntity, wallet: Wallet): void {
  entity.playerId = wallet.playerId;
  entity.currency = wallet.currency;
  entity.balance = wallet.balance.toJSON().amount;
  entity.version = wallet.version;
  entity.createdAt = wallet.createdAt;
  entity.updatedAt = wallet.updatedAt;
}
