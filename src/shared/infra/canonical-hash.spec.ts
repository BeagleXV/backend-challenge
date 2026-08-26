import { describe, expect, it } from 'bun:test';
import { computeWagerTransactionPayloadHash } from './canonical-hash';

describe('computeWagerTransactionPayloadHash', () => {
  const base = {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  it('is stable regardless of key order in the input object', () => {
    const a = computeWagerTransactionPayloadHash(base);
    const b = computeWagerTransactionPayloadHash({
      kind: 'BET',
      money: { currency: 'BRL', amount: '25.00' },
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    });
    expect(a).toBe(b);
  });

  it('changes when a business field changes', () => {
    const a = computeWagerTransactionPayloadHash(base);
    const b = computeWagerTransactionPayloadHash({ ...base, money: { amount: '30.00', currency: 'BRL' } });
    expect(a).not.toBe(b);
  });

  it('produces a 64-char hex string (sha256)', () => {
    expect(computeWagerTransactionPayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
