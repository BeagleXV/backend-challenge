import { createHash } from 'node:crypto';

/** JSON com chaves de objeto ordenadas alfabeticamente, recursivamente. Arrays preservam ordem. */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * payloadHash = sha256(JSON canônico do subconjunto de campos de negócio).
 * Não inclui: o header Idempotency-Key (é metadado de transporte/dedup, redundante com
 * providerId+externalTransactionId), nem qualquer outro campo de transporte.
 */
export interface WagerTransactionPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function computeWagerTransactionPayloadHash(fields: WagerTransactionPayloadFields): string {
  return sha256Hex(canonicalJsonStringify(fields));
}
