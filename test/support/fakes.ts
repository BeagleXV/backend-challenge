import type { EntityManager } from '@mikro-orm/postgresql';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import {
  CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/modules/wallets/domain/wager-transaction';
import { WalletLedgerEntry } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import type { WalletRepository } from '../../src/modules/wallets/application/ports/wallet-repository';
import type {
  ClaimResult,
  WagerTransactionRepository,
} from '../../src/modules/wallets/application/ports/wager-transaction-repository';
import type {
  LedgerPage,
  LedgerSum,
  WalletLedgerEntryRepository,
} from '../../src/modules/wallets/application/ports/wallet-ledger-entry-repository';
import type { OutboxPort } from '../../src/modules/wallets/application/ports/outbox-port';
import type { InboxPort, ReceiveMessageProps } from '../../src/modules/wallets/application/ports/inbox-port';
import { IntegrationEvent } from '../../src/shared/domain/integration-event';
import { Money } from '../../src/shared/domain/money';

/**
 * `EntityManager` fake — o único método que `ProcessWagerTransactionUseCase` chama nele é
 * `.transactional()`. Executa o callback direto (síncrono, sem transação de banco de verdade); o
 * "tx" que ele recebe é o próprio fake, repassado aos repositórios fake abaixo (que o ignoram).
 */
export function fakeEntityManager(): EntityManager {
  const em = {
    transactional: async <T>(cb: (tx: EntityManager) => Promise<T>): Promise<T> => cb(em as unknown as EntityManager),
  };
  return em as unknown as EntityManager;
}

export class InMemoryWalletRepository implements WalletRepository {
  private byId = new Map<string, Wallet>();
  /** Instrumentação simples para testes que precisam distinguir "travou" de "só leu" (ex.: LOSS). */
  lockCallCount = 0;
  findCallCount = 0;

  seed(wallet: Wallet): void {
    this.byId.set(wallet.id, wallet);
  }

  async findByPlayerAndCurrency(_em: EntityManager, playerId: string, currency: string) {
    return [...this.byId.values()].find((w) => w.playerId === playerId && w.currency === currency);
  }

  async findById(_em: EntityManager, id: string) {
    this.findCallCount += 1;
    return this.byId.get(id);
  }

  async lockById(_em: EntityManager, id: string) {
    this.lockCallCount += 1;
    return this.byId.get(id);
  }

  async insert(_em: EntityManager, wallet: Wallet) {
    this.byId.set(wallet.id, wallet);
  }

  async update(_em: EntityManager, wallet: Wallet) {
    this.byId.set(wallet.id, wallet);
  }
}

export class InMemoryWagerTransactionRepository implements WagerTransactionRepository {
  private byId = new Map<string, WagerTransaction>();
  private byIdempotencyKey = new Map<string, string>();
  private byProviderExternal = new Map<string, string>();

  seed(transaction: WagerTransaction): void {
    this.byId.set(transaction.id, transaction);
    this.byIdempotencyKey.set(transaction.idempotencyKey, transaction.id);
    this.byProviderExternal.set(`${transaction.providerId}:${transaction.externalTransactionId}`, transaction.id);
  }

  async claim(_em: EntityManager, props: CreateWagerTransactionProps): Promise<ClaimResult> {
    const existingId = this.byIdempotencyKey.get(props.idempotencyKey);
    if (existingId) {
      return { won: false, transaction: this.byId.get(existingId) as WagerTransaction };
    }
    const transaction = WagerTransaction.create(props);
    this.seed(transaction);
    return { won: true, transaction };
  }

  async findById(_em: EntityManager, id: string) {
    return this.byId.get(id);
  }

  async findByIdForUpdate(_em: EntityManager, id: string) {
    return this.byId.get(id);
  }

  async findDuePendingReference(): Promise<WagerTransaction[]> {
    return [];
  }

  async findByIdempotencyKey(_em: EntityManager, idempotencyKey: string) {
    const id = this.byIdempotencyKey.get(idempotencyKey);
    return id ? this.byId.get(id) : undefined;
  }

  async findByProviderAndExternalId(_em: EntityManager, providerId: string, externalTransactionId: string) {
    const id = this.byProviderExternal.get(`${providerId}:${externalTransactionId}`);
    return id ? this.byId.get(id) : undefined;
  }

  async hasProcessedReversal(_em: EntityManager, referenceTransactionId: string, kind: WagerTransactionKind) {
    return [...this.byId.values()].some(
      (t) => t.referenceTransactionId === referenceTransactionId && t.kind === kind && t.status === 'PROCESSED',
    );
  }

  async update(_em: EntityManager, transaction: WagerTransaction) {
    this.byId.set(transaction.id, transaction);
  }
}

export class InMemoryWalletLedgerEntryRepository implements WalletLedgerEntryRepository {
  readonly entries: WalletLedgerEntry[] = [];

  async insert(_em: EntityManager, entry: WalletLedgerEntry) {
    this.entries.push(entry);
  }

  async findByWalletId(_em: EntityManager, walletId: string): Promise<LedgerPage> {
    return { entries: this.entries.filter((e) => e.walletId === walletId) };
  }

  async sumForWallet(_em: EntityManager, walletId: string, currency: string): Promise<LedgerSum> {
    let balance = Money.zero(currency);
    let count = 0;
    for (const entry of this.entries.filter((e) => e.walletId === walletId)) {
      balance = entry.direction === 'CREDIT' ? balance.add(entry.money) : balance.subtract(entry.money);
      count += 1;
    }
    return { balance, count };
  }
}

export class NoopOutboxPort implements OutboxPort {
  readonly events: IntegrationEvent<unknown>[] = [];

  async enqueue(_em: EntityManager, event: IntegrationEvent<unknown>) {
    this.events.push(event);
  }
}

export class InMemoryInboxPort implements InboxPort {
  private seen = new Set<string>();

  async tryReceive(_em: EntityManager, props: ReceiveMessageProps) {
    const key = `${props.consumerName}:${props.messageId}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  async markProcessed() {
    // no-op — só o "já visto" importa para os fakes
  }
}

/** Um logger que satisfaz a interface usada (info/warn/error/debug) sem depender do nestjs-pino real. */
export function fakeLogger() {
  return { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} };
}
