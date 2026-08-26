export interface BackoffOptions {
  baseMs: number;
  capMs: number;
}

/** Backoff exponencial simples: baseMs * 2^(attempt-1), limitado a capMs. attempt começa em 1. */
export function nextBackoffDelayMs(attempt: number, options: BackoffOptions): number {
  const raw = options.baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, options.capMs);
}
