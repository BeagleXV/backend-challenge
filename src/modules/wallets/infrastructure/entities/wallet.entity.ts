import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';

/**
 * Entidade de persistência — não é o agregado de domínio. `balance` é sempre expresso na moeda
 * `currency` desta wallet (invariante garantida pelo agregado `Wallet`), então não há uma coluna
 * de moeda separada para o saldo.
 */
@Entity({ tableName: 'wallets' })
@Unique({ name: 'wallets_player_currency_unique', properties: ['playerId', 'currency'] })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'player_id' })
  playerId!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'decimal', precision: 19, scale: 2 })
  balance!: string;

  @Property({ type: 'integer' })
  version!: number;

  @Property({ type: 'datetime', fieldName: 'created_at' })
  createdAt!: Date;

  @Property({ type: 'datetime', fieldName: 'updated_at' })
  updatedAt!: Date;
}
