import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { SQS_CLIENT } from './sqs-client.provider';
import { classifyConsumerError } from './consumer-error-classifier';
import {
  ProcessWagerTransactionUseCase,
} from '../../wallets/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind } from '../../wallets/domain/wager-transaction';
import { WagerTransactionRequestedEnvelopeDto } from '../interface/dto/wager-transaction-requested.dto';
import { MetricsService } from '../../observability/metrics/metrics.service';

const CONSUMER_NAME = 'wager-transaction-consumer';
const MAX_MESSAGES_PER_POLL = 10;
const WAIT_TIME_SECONDS = 10;
const VISIBILITY_TIMEOUT_SECONDS = 30;
const POLL_ERROR_BACKOFF_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Consumidor de `wager-transactions.fifo`. Reusa o mesmo `ProcessWagerTransactionUseCase` da
 * entrada HTTP (seção 10 do desafio) — a única diferença é o `InboxContext` passado pra dedup de
 * entrega. Ack (delete) só depois do use case retornar com sucesso (ou seja, depois do commit da
 * transação SQL) — nunca antes.
 */
@Injectable()
export class SqsConsumerService implements OnModuleInit, OnModuleDestroy {
  private stopping = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly config: ConfigService,
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
    private readonly metrics: MetricsService,
    @InjectPinoLogger(SqsConsumerService.name) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.loopPromise = this.loop();
  }

  /** SIGTERM: para de puxar mensagens novas; espera o lote em andamento terminar (ack ou nack). */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.loopPromise) {
      await this.loopPromise;
    }
  }

  private async loop(): Promise<void> {
    const queueUrl = this.config.getOrThrow<string>('SQS_WAGER_TRANSACTIONS_QUEUE_URL');

    while (!this.stopping) {
      let messages: Message[];
      try {
        const result = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: MAX_MESSAGES_PER_POLL,
            WaitTimeSeconds: WAIT_TIME_SECONDS,
            VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
          }),
        );
        messages = result.Messages ?? [];
      } catch (err) {
        this.metrics.infraTransientErrorsTotal.inc({ source: 'sqs_consumer' });
        this.logger.error({ err: (err as Error).message }, 'Failed to poll SQS');
        await sleep(POLL_ERROR_BACKOFF_MS);
        continue;
      }

      if (messages.length === 0) {
        continue;
      }

      await Promise.allSettled(messages.map((message) => this.processMessage(queueUrl, message)));
    }
  }

  private async processMessage(queueUrl: string, message: Message): Promise<void> {
    const receiptHandle = message.ReceiptHandle;
    if (!receiptHandle) {
      return;
    }

    let envelope: WagerTransactionRequestedEnvelopeDto;
    try {
      envelope = await this.parseAndValidate(message.Body ?? '');
    } catch (err) {
      this.metrics.sqsDlqTotal.inc({ reason: 'malformed' });
      this.logger.error(
        { messageId: message.MessageId, err: (err as Error).message },
        'Malformed message, sending to DLQ',
      );
      await this.sendToDlqAndDelete(queueUrl, message, `malformed: ${(err as Error).message}`);
      return;
    }

    const logCtx = {
      correlationId: envelope.data.idempotencyKey,
      messageId: envelope.messageId,
      walletId: envelope.data.walletId,
      providerId: envelope.data.providerId,
    };

    try {
      await this.processWagerTransaction.execute(
        {
          providerId: envelope.data.providerId,
          externalTransactionId: envelope.data.externalTransactionId,
          idempotencyKey: envelope.data.idempotencyKey,
          playerId: envelope.data.playerId,
          walletId: envelope.data.walletId,
          roundId: envelope.data.roundId,
          gameId: envelope.data.gameId,
          kind: envelope.data.kind as unknown as WagerTransactionKind,
          money: envelope.data.money,
          referenceExternalTransactionId: envelope.data.referenceExternalTransactionId,
        },
        { correlationId: envelope.data.idempotencyKey, causationId: envelope.messageId },
        { consumerName: CONSUMER_NAME, messageId: envelope.messageId },
      );
      // PROCESSED, REJECTED e PENDING_REFERENCE são todos desfechos terminais de negócio pro
      // consumer: a mensagem foi tratada, ack incondicional.
      await this.ack(queueUrl, receiptHandle);
    } catch (err) {
      const classification = classifyConsumerError(err);
      if (classification === 'permanent') {
        this.metrics.sqsDlqTotal.inc({ reason: 'permanent_error' });
        this.logger.error(
          { ...logCtx, err: (err as Error).message },
          'Permanent error processing message, sending to DLQ',
        );
        await this.sendToDlqAndDelete(queueUrl, message, (err as Error).message);
      } else {
        this.metrics.sqsRetriesTotal.inc();
        this.logger.warn(
          { ...logCtx, err: (err as Error).message },
          'Transient error processing message, leaving for retry',
        );
        // Não deleta: o visibility timeout expira e a mensagem volta a ficar visível pra retry,
        // até o redrive policy da fila mover pra DLQ automaticamente após o limite de tentativas.
      }
    }
  }

  private async ack(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
  }

  private async sendToDlqAndDelete(queueUrl: string, message: Message, reason: string): Promise<void> {
    const dlqUrl = this.config.get<string>('SQS_WAGER_TRANSACTIONS_DLQ_URL');
    if (dlqUrl) {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: dlqUrl,
          MessageBody: message.Body ?? '',
          MessageGroupId: 'permanent-failure',
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: {
            reason: { DataType: 'String', StringValue: reason.slice(0, 250) },
          },
        }),
      );
    }
    if (message.ReceiptHandle) {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }

  private async parseAndValidate(body: string): Promise<WagerTransactionRequestedEnvelopeDto> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('invalid JSON body');
    }
    const instance = plainToInstance(WagerTransactionRequestedEnvelopeDto, parsed);
    const errors = await validate(instance);
    if (errors.length > 0) {
      const details = errors
        .flatMap((e) => Object.values(e.constraints ?? {}))
        .concat(
          errors.flatMap((e) =>
            (e.children ?? []).flatMap((c) =>
              Object.values(c.constraints ?? {}).concat(
                (c.children ?? []).flatMap((cc) => Object.values(cc.constraints ?? {})),
              ),
            ),
          ),
        )
        .join('; ');
      throw new Error(`validation failed: ${details}`);
    }
    return instance;
  }
}
