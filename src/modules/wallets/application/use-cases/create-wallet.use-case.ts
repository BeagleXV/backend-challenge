import { Inject, Injectable } from '@nestjs/common';
import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/postgresql';
import { Wallet } from '../../domain/wallet';
import { WagerTransactionKind } from '../../domain/wager-transaction';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed.event';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.event';
import { Money, MoneyProps } from '../../../../shared/domain/money';
import { EventContext } from '../../../../shared/domain/integration-event';
import { newId } from '../../../../shared/infra/id';
import { computeWagerTransactionPayloadHash } from '../../../../shared/infra/canonical-hash';
import { WALLET_REPOSITORY, type WalletRepository } from '../ports/wallet-repository';
import { WAGER_TRANSACTION_REPOSITORY, type WagerTransactionRepository } from '../ports/wager-transaction-repository';
import { WALLET_LEDGER_ENTRY_REPOSITORY, type WalletLedgerEntryRepository } from '../ports/wallet-ledger-entry-repository';
import { OUTBOX_PORT, type OutboxPort } from '../ports/outbox-port';
import { WalletAlreadyExistsError } from '../errors';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    private readonly em: EntityManager,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly transactions: WagerTransactionRepository,
    @Inject(WALLET_LEDGER_ENTRY_REPOSITORY) private readonly ledger: WalletLedgerEntryRepository,
    @Inject(OUTBOX_PORT) private readonly outbox: OutboxPort,
  ) {}

  async execute(input: CreateWalletInput, ctx: EventContext): Promise<CreateWalletResult> {
    const initialBalance = Money.from(input.initialBalance);
    const now = new Date();

    return this.em.transactional(async (tx) => {
      const existing = await this.wallets.findByPlayerAndCurrency(
        tx,
        input.playerId,
        initialBalance.currency,
      );
      if (existing) {
        throw new WalletAlreadyExistsError(input.playerId, initialBalance.currency);
      }

      const wallet = Wallet.open({
        id: newId(),
        playerId: input.playerId,
        initialBalance,
        createdAt: now,
      });

      try {
        await this.wallets.insert(tx, wallet);
      } catch (err) {
        if (err instanceof UniqueConstraintViolationException) {
          // corrida entre dois CreateWallet concorrentes pro mesmo player+moeda — o check acima
          // não é suficiente sozinho, a constraint do banco é a garantia final.
          throw new WalletAlreadyExistsError(input.playerId, initialBalance.currency);
        }
        throw err;
      }

      if (initialBalance.isPositive()) {
        await this.recordOpening(tx, wallet, initialBalance, now, ctx);
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }

  private async recordOpening(
    tx: EntityManager,
    wallet: Wallet,
    initialBalance: Money,
    now: Date,
    ctx: EventContext,
  ): Promise<void> {
    const payloadHash = computeWagerTransactionPayloadHash({
      providerId: 'internal',
      externalTransactionId: wallet.id,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'internal',
      gameId: 'internal',
      kind: WagerTransactionKind.Opening,
      money: initialBalance.toJSON(),
    });

    const claim = await this.transactions.claim(tx, {
      id: newId(),
      providerId: 'internal',
      externalTransactionId: wallet.id,
      idempotencyKey: `internal:opening:${wallet.id}`,
      payloadHash,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'internal',
      gameId: 'internal',
      kind: WagerTransactionKind.Opening,
      money: initialBalance,
      createdAt: now,
    });

    const openingTx = claim.transaction;
    openingTx.markProcessed(undefined, now);
    await this.transactions.update(tx, openingTx);

    const entry = WalletLedgerEntry.create({
      id: newId(),
      walletId: wallet.id,
      transactionId: openingTx.id,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: now,
    });
    await this.ledger.insert(tx, entry);

    await this.outbox.enqueue(tx, WagerTransactionProcessed.from(openingTx, ctx));
    await this.outbox.enqueue(tx, WalletBalanceChanged.from(wallet, entry, ctx));
  }
}
