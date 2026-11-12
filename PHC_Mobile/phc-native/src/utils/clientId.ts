// Shared client-side id generator for offline-created records
// (drilling bars, pedidos, material consumption, completion reports).
// Used as the idempotency key (client_entry_id) so a queued sync_outbox
// entry can be safely retried without creating duplicates server-side.
export const createClientEntryId = (prefix: string) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Create a standards-shaped UUID for records whose server primary key is a
 * Postgres `uuid`.  The value is generated before a network call so the same
 * identity survives offline retries.  This is an idempotency identifier, not
 * an authentication secret, so React Native's portable PRNG is sufficient.
 */
export const createClientUuid = (): string =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const random = Math.floor(Math.random() * 16);
    const value = token === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
