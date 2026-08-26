import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Exportados para reuso na validação de DTOs na borda HTTP (mesma fonte de verdade do formato).
export const AMOUNT_PATTERN = /^\d+\.\d{2}$/;
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /** Parses an untrusted input contract (API/message payload). Rejects negative amounts. */
  static from(props: MoneyProps): Money {
    if (!CURRENCY_PATTERN.test(props.currency)) {
      throw new InvalidMoneyError(`Invalid currency: "${props.currency}"`);
    }
    if (typeof props.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(`Invalid amount: "${props.amount}"`);
    }
    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency: "${currency}"`);
    }
    return new Money(new Decimal(0), currency);
  }

  /** Internal constructor for results of domain arithmetic, which may be negative. */
  private static ofDecimal(value: Decimal, currency: string): Money {
    return new Money(value, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofDecimal(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofDecimal(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.ofDecimal(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Does not throw on currency mismatch: different currencies are simply never equal. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
