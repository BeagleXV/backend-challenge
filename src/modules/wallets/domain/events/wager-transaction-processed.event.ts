import { EventContext, IntegrationEvent } from '../../../../shared/domain/integration-event';
import { MoneyProps } from '../../../../shared/domain/money';
import { newId } from '../../../../shared/infra/id';
import { WagerTransaction } from '../wager-transaction';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  processedAt: string;
}

/** Publicado para qualquer transação aplicada com sucesso, inclusive LOSS (que não move saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    const processedAt = transaction.processedAt ?? new Date();
    return new WagerTransactionProcessed({
      eventId: newId(),
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: processedAt,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        processedAt: processedAt.toISOString(),
      },
    });
  }
}
