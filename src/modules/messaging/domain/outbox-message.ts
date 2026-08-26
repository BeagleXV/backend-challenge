import { IntegrationEvent, IntegrationEventJSON } from '../../../shared/domain/integration-event';
import { newId } from '../../../shared/infra/id';
import { nextBackoffDelayMs } from '../../../shared/infra/backoff';

const RETRY_BACKOFF = { baseMs: 2_000, capMs: 5 * 60_000 };

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      newId(),
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Readonly<Record<string, unknown>>,
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
  }

  /** Incrementa attempts e agenda o próximo attempt com backoff exponencial. */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + nextBackoffDelayMs(this._attempts, RETRY_BACKOFF));
  }

  /** Reconstrói o envelope tal como foi gravado (para inspeção/publicação). */
  toEventJSON(): IntegrationEventJSON<unknown> {
    return this.payload as unknown as IntegrationEventJSON<unknown>;
  }
}
