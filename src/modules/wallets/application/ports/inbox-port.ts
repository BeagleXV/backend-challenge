import type { EntityManager } from '@mikro-orm/postgresql';

export interface ReceiveMessageProps {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxPort {
  /**
   * Tenta reivindicar a mensagem via INSERT (PK composta consumer_name+message_id).
   * Retorna false se já existe — redelivery do broker de uma mensagem já tratada nesta transação.
   */
  tryReceive(em: EntityManager, props: ReceiveMessageProps): Promise<boolean>;

  markProcessed(em: EntityManager, consumerName: string, messageId: string, at: Date): Promise<void>;
}

export const INBOX_PORT = Symbol('INBOX_PORT');
