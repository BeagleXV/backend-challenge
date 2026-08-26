import { EventContext, IntegrationEvent } from '../../../../shared/domain/integration-event';
import { MoneyProps } from '../../../../shared/domain/money';
import { FailureCode } from '../../../../shared/domain/failure-code';
import { newId } from '../../../../shared/infra/id';
import { WagerTransaction } from '../wager-transaction';

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  money: MoneyProps;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!transaction.failureCode) {
      throw new Error('Cannot build WagerTransactionRejected for a transaction without a failureCode');
    }
    return new WagerTransactionRejected({
      eventId: newId(),
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        failureCode: transaction.failureCode,
      },
    });
  }
}
