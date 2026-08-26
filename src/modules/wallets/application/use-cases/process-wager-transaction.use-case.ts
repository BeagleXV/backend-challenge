import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EntityManager } from '@mikro-orm/postgresql';
import { MetricsService } from '../../../observability/metrics/metrics.service';
import { Wallet } from '../../domain/wallet';
import {
  CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { InsufficientBalanceError } from '../../domain/errors';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected.event';
import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference.event';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.event';
import { Money, MoneyProps } from '../../../../shared/domain/money';
import { EventContext } from '../../../../shared/domain/integration-event';
import { FailureCode } from '../../../../shared/domain/failure-code';
import { newId } from '../../../../shared/infra/id';
import { computeWagerTransactionPayloadHash } from '../../../../shared/infra/canonical-hash';
import { WALLET_REPOSITORY, type WalletRepository } from '../ports/wallet-repository';
import { WAGER_TRANSACTION_REPOSITORY, type WagerTransactionRepository } from '../ports/wager-transaction-repository';
import { WALLET_LEDGER_ENTRY_REPOSITORY, type WalletLedgerEntryRepository } from '../ports/wallet-ledger-entry-repository';
import { OUTBOX_PORT, type OutboxPort } from '../ports/outbox-port';
import { INBOX_PORT, type InboxPort } from '../ports/inbox-port';
import { IdempotencyConflictError, RequestValidationError, WalletNotFoundError } from '../errors';

export interface ProcessWagerTransactionInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * Presente só quando a entrada é via SQS. Dedup de ENTREGA (consumerName+messageId) — distinto e
 * complementar à idempotência de negócio (idempotencyKey), que já é sempre aplicada de qualquer forma.
 */
export interface InboxContext {
  consumerName: string;
  messageId: string;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

type ReferenceResolution =
  | { outcome: 'ok'; transaction: WagerTransaction }
  | { outcome: 'pending' }
  | { outcome: 'rejected'; failureCode: FailureCode };

/** REFUND só referencia BET. ROLLBACK referencia BET, WIN ou REFUND (regra 3, seção 7). */
const ALLOWED_REFERENCE_KINDS: Record<string, WagerTransactionKind[]> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly em: EntityManager,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly transactions: WagerTransactionRepository,
    @Inject(WALLET_LEDGER_ENTRY_REPOSITORY) private readonly ledger: WalletLedgerEntryRepository,
    @Inject(OUTBOX_PORT) private readonly outbox: OutboxPort,
    @Inject(INBOX_PORT) private readonly inbox: InboxPort,
    private readonly metrics: MetricsService,
    @InjectPinoLogger(ProcessWagerTransactionUseCase.name) private readonly logger: PinoLogger,
  ) {}

  async execute(
    input: ProcessWagerTransactionInput,
    ctx: EventContext,
    inboxCtx?: InboxContext,
  ): Promise<ProcessWagerTransactionResult> {
    const stopTimer = this.metrics.wagerTransactionProcessingSeconds.startTimer();
    try {
      if (input.kind === WagerTransactionKind.Opening) {
        throw new RequestValidationError('OPENING is internal and cannot be submitted via API/queue');
      }

      const money = Money.from(input.money);
      const now = new Date();
      const payloadHash = computeWagerTransactionPayloadHash({
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        playerId: input.playerId,
        walletId: input.walletId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        money: money.toJSON(),
        referenceExternalTransactionId: input.referenceExternalTransactionId,
      });

      const props: CreateWagerTransactionProps = {
        id: newId(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        money,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
        createdAt: now,
      };
      // Valida a exigência de referência por kind (lança MissingReferenceError) antes de tocar o banco.
      WagerTransaction.create(props);

      let inboxDuplicate = false;

      const result = await this.em.transactional(async (tx) => {
        if (inboxCtx) {
          // Dedup de ENTREGA: se o broker reentregou uma mensagem já tratada nesta mesma
          // transação de negócio, nem tocamos no lock da wallet — devolvemos o resultado já
          // conhecido.
          const claimed = await this.inbox.tryReceive(tx, {
            consumerName: inboxCtx.consumerName,
            messageId: inboxCtx.messageId,
            payloadHash,
            receivedAt: now,
          });
          if (!claimed) {
            inboxDuplicate = true;
            return this.replayFromInboxDuplicate(tx, props.idempotencyKey, payloadHash);
          }
        }

        const r = await this.processClaim(tx, props, payloadHash, now, ctx);

        if (inboxCtx) {
          await this.inbox.markProcessed(tx, inboxCtx.consumerName, inboxCtx.messageId, now);
        }

        return r;
      });

      this.metrics.wagerTransactionsTotal.inc({ kind: input.kind, status: result.status });
      if (result.idempotentReplay) {
        this.metrics.idempotentReplaysTotal.inc();
      }
      if (inboxDuplicate) {
        this.metrics.inboxDuplicatesTotal.inc();
      }

      // Log estruturado (seção 12): só IDs e o desfecho — nunca o valor monetário da operação.
      this.logger.info(
        {
          correlationId: ctx.correlationId,
          causationId: ctx.causationId,
          messageId: inboxCtx?.messageId,
          transactionId: result.transactionId,
          walletId: input.walletId,
          providerId: input.providerId,
          kind: input.kind,
          status: result.status,
          idempotentReplay: result.idempotentReplay,
          failureCode: result.failureCode,
        },
        'wager transaction processed',
      );

      return result;
    } finally {
      stopTimer();
    }
  }

  private async replayFromInboxDuplicate(
    tx: EntityManager,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    const existing = await this.transactions.findByIdempotencyKey(tx, idempotencyKey);
    if (!existing) {
      // Não deveria acontecer: inbox e idempotencyKey participam da mesma transação, então uma
      // entrega já registrada implica a transação de negócio também já commitada.
      throw new Error(
        `Inbox reports duplicate delivery but no WagerTransaction found for idempotencyKey "${idempotencyKey}"`,
      );
    }
    const wallet = await this.wallets.findById(tx, existing.walletId);
    return wallet ? this.replay(existing, payloadHash, wallet) : this.toResult(existing, undefined, true);
  }

  private async processClaim(
    tx: EntityManager,
    props: CreateWagerTransactionProps,
    payloadHash: string,
    now: Date,
    ctx: EventContext,
  ): Promise<ProcessWagerTransactionResult> {
    // A wallet é travada (ou só lida, para LOSS) ANTES do claim — não depois. `wager_transactions`
    // tem FK para `wallets`, então o INSERT do claim já adquire um lock implícito FOR KEY SHARE
    // na linha da wallet; se essa ordem fosse invertida, duas transações concorrentes fazendo
    // claim() e só depois SELECT FOR UPDATE na mesma wallet caem num deadlock real do Postgres
    // (cada uma espera a outra soltar o FOR KEY SHARE do próprio INSERT). Travando antes, o
    // primeiro toque desta transação na linha já é o lock forte — sem ciclo possível. Efeito
    // colateral aceito: pedidos duplicados numa wallet "quente" agora serializam pelo lock da
    // wallet em vez de resolver via conflito de idempotency_key antes de tocar nela — corretude
    // em vez de uma otimização de throughput. Ver ARCHITECTURE.md.
    const needsLock = props.kind !== WagerTransactionKind.Loss;
    const wallet = needsLock
      ? await this.wallets.lockById(tx, props.walletId)
      : await this.wallets.findById(tx, props.walletId);

    if (!wallet) {
      // Sem wallet não dá pra nem reivindicar a operação (a FK do claim() falharia) — não há
      // WagerTransaction pra auditar aqui, então é um erro de request, não um REJECTED de negócio.
      throw new WalletNotFoundError(props.walletId);
    }

    const claim = await this.transactions.claim(tx, props);

    if (!claim.won) {
      return this.replay(claim.transaction, payloadHash, wallet);
    }

    const transaction = claim.transaction;
    let referenceTransaction: WagerTransaction | undefined;

    if (transaction.requiresReference()) {
      const resolution = await this.resolveReference(tx, transaction);
      if (resolution.outcome === 'pending') {
        // Primeira vez que fica pendente: marca e publica o evento uma única vez. Retries
        // subsequentes (PendingReferenceReprocessorWorker) não passam por aqui de novo — ver
        // retryPendingReference(), que trata o "ainda pendente" com scheduleReferenceRetry() em
        // vez de reemitir este evento a cada tentativa.
        transaction.markPendingReference();
        await this.transactions.update(tx, transaction);
        await this.outbox.enqueue(tx, WagerTransactionPendingReference.from(transaction, ctx));
        return this.toResult(transaction, wallet.balance.toJSON(), false);
      }
      if (resolution.outcome === 'rejected') {
        return this.rejectAndReturn(tx, transaction, resolution.failureCode, ctx, wallet.balance.toJSON());
      }
      referenceTransaction = resolution.transaction;
    }

    return this.processClaimedTransaction(tx, transaction, wallet, referenceTransaction, now, ctx);
  }

  /**
   * Reprocessamento de uma transação PENDING_REFERENCE (chamado pelo
   * PendingReferenceReprocessorWorker). Mesma ordem de lock do fluxo síncrono (wallet antes da
   * linha da própria transação) para evitar o mesmo tipo de deadlock por escalada de lock.
   */
  async retryPendingReference(transactionId: string, ctx: EventContext): Promise<void> {
    const now = new Date();
    await this.em.transactional(async (tx) => {
      const snapshot = await this.transactions.findById(tx, transactionId);
      if (!snapshot || snapshot.status !== WagerTransactionStatus.PendingReference) {
        return; // já resolvida por outra instância (ou entre a seleção do lote e agora), ou id inválido.
      }

      const wallet = await this.wallets.lockById(tx, snapshot.walletId);
      if (!wallet) {
        return;
      }

      const transaction = await this.transactions.findByIdForUpdate(tx, transactionId);
      if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference) {
        return;
      }

      const resolution = await this.resolveReference(tx, transaction);

      if (resolution.outcome === 'ok') {
        await this.processClaimedTransaction(tx, transaction, wallet, resolution.transaction, now, ctx);
        return;
      }

      if (resolution.outcome === 'rejected') {
        await this.rejectAndReturn(tx, transaction, resolution.failureCode, ctx, wallet.balance.toJSON());
        return;
      }

      if (transaction.hasExceededReferenceRetries()) {
        await this.rejectAndReturn(tx, transaction, FailureCode.ReferenceTimeoutExceeded, ctx, wallet.balance.toJSON());
        return;
      }

      transaction.scheduleReferenceRetry(now);
      await this.transactions.update(tx, transaction);
    });
  }

  private replay(
    existing: WagerTransaction,
    payloadHash: string,
    wallet: Wallet,
  ): ProcessWagerTransactionResult {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(existing.idempotencyKey);
    }
    return this.toResult(existing, wallet.balance.toJSON(), true);
  }

  /**
   * Só resolve — sem efeito colateral nenhum. O que fazer com o resultado (marcar
   * PENDING_REFERENCE na primeira vez, agendar retry, ou aplicar a reversão) é decisão de quem
   * chama, porque isso difere entre o fluxo inicial (processClaim) e o retry (retryPendingReference).
   */
  private async resolveReference(
    tx: EntityManager,
    transaction: WagerTransaction,
  ): Promise<ReferenceResolution> {
    const referenceExternalId = transaction.referenceExternalTransactionId as string;
    const reference = await this.transactions.findByProviderAndExternalId(
      tx,
      transaction.providerId,
      referenceExternalId,
    );

    const notYetResolved =
      !reference ||
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference;

    if (notYetResolved) {
      return { outcome: 'pending' };
    }

    if (
      reference.status === WagerTransactionStatus.Rejected ||
      reference.status === WagerTransactionStatus.Failed
    ) {
      // Terminal negativo: nunca vai se resolver reprocessando depois.
      return { outcome: 'rejected', failureCode: FailureCode.ReferenceNotFound };
    }

    if (
      reference.playerId !== transaction.playerId ||
      reference.walletId !== transaction.walletId ||
      reference.roundId !== transaction.roundId ||
      reference.money.currency !== transaction.money.currency
    ) {
      return { outcome: 'rejected', failureCode: FailureCode.ReferenceOwnerMismatch };
    }

    const allowedKinds = ALLOWED_REFERENCE_KINDS[transaction.kind] ?? [];
    if (!allowedKinds.includes(reference.kind)) {
      return { outcome: 'rejected', failureCode: FailureCode.ReferenceTypeInvalid };
    }

    if (!reference.money.equals(transaction.money)) {
      // regra 5, seção 7: valor de REFUND/ROLLBACK deve ser igual ao valor da referência.
      return { outcome: 'rejected', failureCode: FailureCode.ValidationError };
    }

    const alreadyReversed = await this.transactions.hasProcessedReversal(
      tx,
      reference.id,
      transaction.kind,
    );
    if (alreadyReversed) {
      return { outcome: 'rejected', failureCode: FailureCode.ReferenceAlreadyReversed };
    }

    return { outcome: 'ok', transaction: reference };
  }

  private async processClaimedTransaction(
    tx: EntityManager,
    transaction: WagerTransaction,
    wallet: Wallet,
    referenceTransaction: WagerTransaction | undefined,
    now: Date,
    ctx: EventContext,
  ): Promise<ProcessWagerTransactionResult> {
    if (wallet.currency !== transaction.money.currency) {
      return this.rejectAndReturn(
        tx,
        transaction,
        FailureCode.CurrencyMismatch,
        ctx,
        wallet.balance.toJSON(),
      );
    }

    if (transaction.kind === WagerTransactionKind.Loss) {
      transaction.markProcessed(undefined, now);
      await this.transactions.update(tx, transaction);
      await this.outbox.enqueue(tx, WagerTransactionProcessed.from(transaction, ctx));
      return this.toResult(transaction, wallet.balance.toJSON(), false);
    }

    let ledgerEntry: WalletLedgerEntry;
    try {
      ledgerEntry = this.applyMovement(wallet, transaction, referenceTransaction, now);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        const code =
          transaction.kind === WagerTransactionKind.Bet
            ? FailureCode.InsufficientBalance
            : FailureCode.NegativeBalanceOnReversal;
        return this.rejectAndReturn(tx, transaction, code, ctx, wallet.balance.toJSON());
      }
      throw err;
    }

    await this.wallets.update(tx, wallet);
    await this.ledger.insert(tx, ledgerEntry);

    transaction.markProcessed(referenceTransaction?.id, now);
    await this.transactions.update(tx, transaction);

    await this.outbox.enqueue(tx, WagerTransactionProcessed.from(transaction, ctx));
    await this.outbox.enqueue(tx, WalletBalanceChanged.from(wallet, ledgerEntry, ctx));

    return this.toResult(transaction, wallet.balance.toJSON(), false);
  }

  private applyMovement(
    wallet: Wallet,
    transaction: WagerTransaction,
    referenceTransaction: WagerTransaction | undefined,
    now: Date,
  ): WalletLedgerEntry {
    const movement = { entryId: newId(), transactionId: transaction.id, money: transaction.money, at: now };
    switch (transaction.kind) {
      case WagerTransactionKind.Bet:
        return wallet.debit(movement);
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return wallet.credit(movement);
      case WagerTransactionKind.Rollback: {
        const direction = transaction.ledgerDirectionFor(referenceTransaction);
        return direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
      }
      default:
        throw new Error(`Unexpected kind in applyMovement: ${transaction.kind}`);
    }
  }

  private async rejectAndReturn(
    tx: EntityManager,
    transaction: WagerTransaction,
    code: FailureCode,
    ctx: EventContext,
    balance: MoneyProps | undefined,
  ): Promise<ProcessWagerTransactionResult> {
    transaction.reject(code);
    await this.transactions.update(tx, transaction);
    await this.outbox.enqueue(tx, WagerTransactionRejected.from(transaction, ctx));
    return this.toResult(transaction, balance, false);
  }

  private toResult(
    transaction: WagerTransaction,
    balance: MoneyProps | undefined,
    idempotentReplay: boolean,
  ): ProcessWagerTransactionResult {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance,
      idempotentReplay,
      failureCode: transaction.failureCode,
    };
  }
}
