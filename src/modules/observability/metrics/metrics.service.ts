import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Métricas mínimas exigidas pela seção 12 do desafio: transações por status, duplicatas
 * detectadas, retries, mensagens em DLQ, conflitos de lock, outbox lag, latência de processamento.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly wagerTransactionsTotal = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions processadas, por kind e status final',
    labelNames: ['kind', 'status'] as const,
    registers: [this.registry],
  });

  readonly idempotentReplaysTotal = new Counter({
    name: 'wager_transactions_idempotent_replay_total',
    help: 'Requisições identificadas como replay idempotente (duplicata de negócio)',
    registers: [this.registry],
  });

  readonly inboxDuplicatesTotal = new Counter({
    name: 'inbox_duplicate_deliveries_total',
    help: 'Redeliveries do broker identificadas via inbox (duplicata de entrega, distinta de duplicata de negócio)',
    registers: [this.registry],
  });

  readonly wagerTransactionProcessingSeconds = new Histogram({
    name: 'wager_transaction_processing_seconds',
    help: 'Latência de ProcessWagerTransactionUseCase.execute()',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  readonly outboxPublishTotal = new Counter({
    name: 'outbox_publish_attempts_total',
    help: 'Tentativas de publicação da outbox, por desfecho',
    labelNames: ['outcome'] as const, // 'success' | 'retry'
    registers: [this.registry],
  });

  readonly outboxPublishLagSeconds = new Histogram({
    name: 'outbox_publish_lag_seconds',
    help: 'Tempo entre o evento ocorrer (occurred_at) e ser publicado com sucesso no SQS',
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 300],
    registers: [this.registry],
  });

  readonly sqsDlqTotal = new Counter({
    name: 'sqs_dlq_messages_total',
    help: 'Mensagens enviadas para a DLQ, por motivo',
    labelNames: ['reason'] as const, // 'malformed' | 'permanent_error'
    registers: [this.registry],
  });

  readonly sqsRetriesTotal = new Counter({
    name: 'sqs_message_retries_total',
    help: 'Mensagens SQS deixadas para retry após erro transitório',
    registers: [this.registry],
  });

  readonly infraTransientErrorsTotal = new Counter({
    name: 'infra_transient_errors_total',
    help: 'Erros transitórios de infraestrutura observados (ex.: deadlock detectado, conexão indisponível), por origem',
    labelNames: ['source'] as const, // 'http' | 'sqs_consumer' | 'outbox_worker' | 'reference_worker'
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}
