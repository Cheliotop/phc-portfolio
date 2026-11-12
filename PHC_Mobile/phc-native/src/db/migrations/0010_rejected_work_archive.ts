import type { DatabaseTransaction } from '../db';

/**
 * SQLite v10 keeps field work the server rejected after a phone changes hands.
 *
 * Handing a phone to another operator used to delete the previous operator's
 * rejected outbox rows, because a retry under the new session would have filed
 * that work under the wrong name. Deleting them also destroyed the only copy of
 * work the server never accepted: reproduced on 2026-11-05 with two bars from a
 * deactivated operator, which left the server with nothing and no warning.
 *
 * Moving the rows here keeps the original operator attached and takes them out
 * of reach of every drain and of the manual retry, which only read sync_outbox.
 * `uploaded_at` is for the admin review list, which reads this table next.
 */
export const REJECTED_WORK_SCHEMA_VERSION = 10;

export const REJECTED_WORK_TABLE_SQL =
  `CREATE TABLE IF NOT EXISTS rejected_work (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    entity TEXT,
    entity_id TEXT,
    op TEXT,
    payload_json TEXT,
    last_error TEXT,
    created_at TEXT,
    rejected_at TEXT,
    archived_at TEXT NOT NULL,
    uploaded_at TEXT,
    sent_at TEXT,
    sent_reported_at TEXT
  )`;

/**
 * The table itself is created by the `createTablesSQL` pass that runs before
 * every versioned migration, so this only advances the version. No field data
 * is read, rewritten or deleted.
 */
export const migrateV9ToV10 = async (transaction: DatabaseTransaction): Promise<void> => {
  await transaction.execute(`PRAGMA user_version = ${REJECTED_WORK_SCHEMA_VERSION}`);
};
