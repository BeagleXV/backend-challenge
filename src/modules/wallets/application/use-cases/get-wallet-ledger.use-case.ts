import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  type LedgerPage,
  WALLET_LEDGER_ENTRY_REPOSITORY,
  type WalletLedgerEntryRepository,
} from '../ports/wallet-ledger-entry-repository';

@Injectable()
export class GetWalletLedgerUseCase {
  constructor(
    private readonly em: EntityManager,
    @Inject(WALLET_LEDGER_ENTRY_REPOSITORY) private readonly ledger: WalletLedgerEntryRepository,
  ) {}

  async execute(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    return this.ledger.findByWalletId(this.em.fork(), walletId, { cursor, limit });
  }
}
