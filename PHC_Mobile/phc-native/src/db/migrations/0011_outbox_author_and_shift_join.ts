import type { DatabaseTransaction } from '../db';

export const OUTBOX_AUTHOR_SCHEMA_VERSION = 11;

export const migrateV10ToV11 = async (
  transaction: DatabaseTransaction,
  outboxOwnerId: string | null,
): Promise<void> => {
  const columns = await transaction.query<{ name: string }>('PRAGMA table_info(sync_outbox)');
  if (!columns.some((column) => column.name === 'author_id')) {
    await transaction.execute('ALTER TABLE sync_outbox ADD COLUMN author_id TEXT');
  }
  if (outboxOwnerId) {
    await transaction.execute(
      'UPDATE sync_outbox SET author_id = ? WHERE author_id IS NULL',
      [outboxOwnerId],
    );
  }
  await transaction.execute(`PRAGMA user_version = ${OUTBOX_AUTHOR_SCHEMA_VERSION}`);
};
