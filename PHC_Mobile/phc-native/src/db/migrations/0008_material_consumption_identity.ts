import type { DatabaseTransaction } from '../db';

/** SQLite v8 separates local material-consumption ids from server ids. */
export const MATERIAL_CONSUMPTION_IDENTITY_SCHEMA_VERSION = 8;

export const MATERIAL_CONSUMPTION_SERVER_ID_INDEX_SQL =
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_material_consumption_server_id ON material_consumption(server_id) WHERE server_id IS NOT NULL';

interface DuplicateServerIdCount {
  duplicate_count: number;
}

/**
 * Add the server identity constraint without deleting or rewriting field data.
 *
 * A legacy database may contain duplicate non-null server ids. Creating the
 * unique index would abort the whole app upgrade, while choosing a duplicate
 * to delete would silently discard consumption evidence. In that exceptional
 * state v8 leaves every row untouched, skips only the index, and still advances
 * the schema version so the device remains usable and available for review.
 */
export const migrateV7ToV8 = async (transaction: DatabaseTransaction): Promise<void> => {
  const duplicateServerIds = await transaction.queryFirst<DuplicateServerIdCount>(
    `SELECT COUNT(*) AS duplicate_count
       FROM (
         SELECT server_id
         FROM material_consumption
         WHERE server_id IS NOT NULL
         GROUP BY server_id
         HAVING COUNT(*) > 1
       )`,
  );

  if ((duplicateServerIds?.duplicate_count ?? 0) === 0) {
    await transaction.execute(MATERIAL_CONSUMPTION_SERVER_ID_INDEX_SQL);
  }

  await transaction.execute(
    `PRAGMA user_version = ${MATERIAL_CONSUMPTION_IDENTITY_SCHEMA_VERSION}`,
  );
};
