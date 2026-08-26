import { Money } from '../../../shared/domain/money';
import { CurrencyMismatchError } from '../../../shared/domain/errors';
import { InsufficientBalanceError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  createdAt: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApplyMovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * O saldo inicial (se houver) já nasce refletido no estado da wallet — não é tratado como uma
   * "mudança" subsequente, então version permanece 1. O lançamento OPENING correspondente no ledger
   * é responsabilidade do use case (CreateWallet), não desta factory.
   */
  static open(props: OpenWalletProps): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.createdAt,
      props.createdAt,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Debita a wallet. Lança InsufficientBalanceError se o saldo resultante for negativo. */
  debit(props: ApplyMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(props.money);
    if (balanceAfter.isNegative()) {
      throw new InsufficientBalanceError(this.id);
    }
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = props.at;
    return WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Debit,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: props.at,
    });
  }

  /** Credita a wallet. Sempre bem-sucedido (crédito nunca viola saldo não-negativo). */
  credit(props: ApplyMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(props.money);
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = props.at;
    return WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: props.at,
    });
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
