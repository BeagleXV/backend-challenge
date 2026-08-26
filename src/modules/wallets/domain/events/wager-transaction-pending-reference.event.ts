import { EventContext, IntegrationEvent } from '../../../../shared/domain/integration-event';
import { newId } from '../../../../shared/infra/id';
import { WagerTransaction } from '../wager-transaction';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (!transaction.referenceExternalTransactionId) {
      throw new Error(
        'Cannot build WagerTransactionPendingReference without a referenceExternalTransactionId',
      );
    }
    return new WagerTransactionPendingReference({
      eventId: newId(),
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      },
    });
  }
}
