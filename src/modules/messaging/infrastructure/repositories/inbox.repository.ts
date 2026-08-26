import { Injectable } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';
import { InboxPort, ReceiveMessageProps } from '../../../wallets/application/ports/inbox-port';

const TRY_RECEIVE_SQL = `
  insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
  values (?, ?, ?, ?)
  on conflict (consumer_name, message_id) do nothing
  returning consumer_name
`;

@Injectable()
export class MikroInboxRepository implements InboxPort {
  async tryReceive(em: EntityManager, props: ReceiveMessageProps): Promise<boolean> {
    const rows = await em
      .getConnection()
      .execute<unknown[]>(
        TRY_RECEIVE_SQL,
        [props.consumerName, props.messageId, props.payloadHash, props.receivedAt],
        'all',
        em.getTransactionContext(),
      );
    return rows.length > 0;
  }

  async markProcessed(em: EntityManager, consumerName: string, messageId: string, at: Date): Promise<void> {
    await em
      .getConnection()
      .execute(
        `update inbox_messages set processed_at = ? where consumer_name = ? and message_id = ?`,
        [at, consumerName, messageId],
        'run',
        em.getTransactionContext(),
      );
  }
}
