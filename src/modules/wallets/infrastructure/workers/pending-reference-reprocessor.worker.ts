import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Interval } from '@nestjs/schedule';
import { EntityManager } from '@mikro-orm/postgresql';
import { WAGER_TRANSACTION_REPOSITORY, type WagerTransactionRepository } from '../../application/ports/wager-transaction-repository';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import { MetricsService } from '../../../observability/metrics/metrics.service';

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 20;

/**
 * Reprocessa transações PENDING_REFERENCE devidas (seção 7.1 do desafio). Roda em toda instância;
 * a seleção do lote usa FOR UPDATE SKIP LOCKED (WagerTransactionRepository.findDuePendingReference)
 * para publishers concorrentes de instâncias diferentes pegarem lotes disjuntos.
 *
 * Design em duas fases deliberado: (1) seleciona os IDs elegíveis numa transação curta que é
 * commitada antes de processar qualquer um — evita depender de `em.transactional()` aninhado
 * (não testado neste código; `retryPendingReference` abre sua própria transação). (2) processa cada
 * id em sua própria transação, sequencialmente. Uma pequena janela existe entre as duas fases onde
 * outra instância poderia, em teoria, pegar a mesma linha — inofensivo: `retryPendingReference`
 * re-trava a linha e verifica o status atual antes de agir, então uma segunda tentativa concorrente
 * simplesmente não encontra mais nada pendente ali e não faz nada.
 */
@Injectable()
export class PendingReferenceReprocessorWorker {
  private running = false;

  constructor(
    private readonly em: EntityManager,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly transactions: WagerTransactionRepository,
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
    private readonly metrics: MetricsService,
    @InjectPinoLogger(PendingReferenceReprocessorWorker.name) private readonly logger: PinoLogger,
  ) {}

  @Interval(POLL_INTERVAL_MS)
  async run(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.reprocessBatch();
    } catch (err) {
      this.metrics.infraTransientErrorsTotal.inc({ source: 'reference_worker' });
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Pending-reference reprocess batch failed',
      );
    } finally {
      this.running = false;
    }
  }

  private async reprocessBatch(): Promise<void> {
    const now = new Date();
    const dueIds = await this.em.transactional(async (tx) => {
      const due = await this.transactions.findDuePendingReference(tx, now, BATCH_SIZE);
      return due.map((transaction) => transaction.id);
    });

    for (const id of dueIds) {
      try {
        await this.processWagerTransaction.retryPendingReference(id, { correlationId: id });
      } catch (err) {
        this.logger.warn(
          { transactionId: id, err: (err as Error).message },
          'Failed to retry pending-reference transaction',
        );
      }
    }
  }
}
