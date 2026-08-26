import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Wallet } from '../../domain/wallet';
import { WALLET_REPOSITORY, type WalletRepository } from '../ports/wallet-repository';

@Injectable()
export class GetWalletUseCase {
  constructor(
    private readonly em: EntityManager,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
  ) {}

  async execute(walletId: string): Promise<Wallet | undefined> {
    return this.wallets.findById(this.em.fork(), walletId);
  }
}
