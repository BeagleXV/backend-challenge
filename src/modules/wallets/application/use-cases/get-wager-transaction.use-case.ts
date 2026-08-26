import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransaction } from '../../domain/wager-transaction';
import { WAGER_TRANSACTION_REPOSITORY, type WagerTransactionRepository } from '../ports/wager-transaction-repository';

@Injectable()
export class GetWagerTransactionUseCase {
  constructor(
    private readonly em: EntityManager,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly transactions: WagerTransactionRepository,
  ) {}

  async byId(transactionId: string): Promise<WagerTransaction | undefined> {
    return this.transactions.findById(this.em.fork(), transactionId);
  }

  async byProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.transactions.findByProviderAndExternalId(this.em.fork(), providerId, externalTransactionId);
  }
}
