import { describe, expect, it } from 'bun:test';
import { Money } from './money';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

describe('Money', () => {
  it('parses a valid decimal string with scale 2', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('creates zero for a currency', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
  });

  it.each([
    ['NaN', 'BRL'],
    ['Infinity', 'BRL'],
    ['1e10', 'BRL'],
    ['', 'BRL'],
    ['25', 'BRL'],
    ['25.0', 'BRL'],
    ['25.000', 'BRL'],
    ['-25.00', 'BRL'],
    ['25.00', 'brl'],
    ['25.00', 'US'],
  ])('rejects invalid input amount=%s currency=%s', (amount: string, currency: string) => {
    expect(() => Money.from({ amount, currency })).toThrow(InvalidMoneyError);
  });

  it('adds money of the same currency', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '5.50', currency: 'BRL' });
    expect(a.add(b).toJSON().amount).toBe('15.50');
  });

  it('subtracts money of the same currency, allowing negative results', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '15.00', currency: 'BRL' });
    const result = a.subtract(b);
    expect(result.toJSON().amount).toBe('-5.00');
    expect(result.isNegative()).toBe(true);
  });

  it('negates a value', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(a.negate().toJSON().amount).toBe('-10.00');
  });

  it('throws CurrencyMismatchError when adding different currencies', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
  });

  it('throws CurrencyMismatchError when subtracting different currencies', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
  });

  it('throws CurrencyMismatchError on isLessThan across currencies', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  it('isLessThan compares magnitudes correctly', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '20.00', currency: 'BRL' });
    expect(a.isLessThan(b)).toBe(true);
    expect(b.isLessThan(a)).toBe(false);
  });

  it('equals does not throw across currencies, just returns false', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(brl.equals(usd)).toBe(false);
  });

  it('equals returns true for same amount and currency', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(a.equals(b)).toBe(true);
  });

  it('toString includes amount and currency', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(a.toString()).toBe('10.00 BRL');
  });
});
