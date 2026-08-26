import { v7 as uuidv7 } from 'uuid';

/** UUIDv7: ordenável por tempo, bom para chaves primárias e índices B-tree. */
export function newId(): string {
  return uuidv7();
}
