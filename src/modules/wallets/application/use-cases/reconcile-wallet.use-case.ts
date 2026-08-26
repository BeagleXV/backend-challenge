import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { MoneyProps } from '../../../../shared/domain/money';
import { WALLET_REPOSITORY, type WalletRepository } from '../ports/wallet-repository';
import { WALLET_LEDGER_ENTRY_REPOSITORY, type WalletLedgerEntryRepository } from '../ports/wallet-ledger-entry-repository';
import { WalletNotFoundError } from '../errors';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(
    private readonly em: EntityManager,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(WALLET_LEDGER_ENTRY_REPOSITORY) private readonly ledger: WalletLedgerEntryRepository,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const em = this.em.fork();
    const wallet = await this.wallets.findById(em, walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    const { balance: calculated, count } = await this.ledger.sumForWallet(
      em,
      walletId,
      wallet.currency,
    );
    const difference = wallet.balance.subtract(calculated);
    const consistent = difference.isZero();

    if (!consistent) {
      // Divergências não são corrigidas silenciosamente — apenas logadas e sinalizadas na resposta.
      this.logger.error(
        `Balance divergence for wallet ${walletId}: stored=${wallet.balance.toString()} calculated=${calculated.toString()}`,
      );
    }

    return {
      walletId,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: count,
    };
  }
}
