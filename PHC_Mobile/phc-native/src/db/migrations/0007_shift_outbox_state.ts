import type { DatabaseTransaction } from '../db';

/**
 * SQLite v7 makes the outbox the source of truth for shift synchronization.
 * The legacy shifts.sync_status column stays in place for installed databases,
 * but new code no longer reads or maintains it.
 */
export const SHIFT_OUTBOX_SCHEMA_VERSION = 7;

/**
 * Existing v6 devices may already contain a locally auto-closed shift with no
 * outbox row. Backfill one verification intent so that work cannot disappear
 * behind a stale shifts.sync_status = 'synced' value.
 *
 * The deterministic id and NOT EXISTS guard make this safe to retry if an app
 * launch is interrupted before PRAGMA user_version is committed.
 */
export const migrateV6ToV7 = async (transaction: DatabaseTransaction): Promise<void> => {
  await transaction.execute(
    `INSERT OR IGNORE INTO sync_outbox (
       id, entity, entity_id, op, payload_json, retries, created_at, updated_at
     )
     SELECT 'shift-auto-close-v7-' || s.id,
            'shift_auto_close', s.id, 'VERIFY', '{"backfilled":true}', 0,
            COALESCE(s.updated_at, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP
     FROM shifts s
     WHERE s.status = 'report_pending'
       AND s.end_type = 'auto'
       AND NOT EXISTS (
         SELECT 1 FROM sync_outbox o
         WHERE o.entity = 'shift_auto_close' AND o.entity_id = s.id
       )`,
  );

  await transaction.execute(`PRAGMA user_version = ${SHIFT_OUTBOX_SCHEMA_VERSION}`);
};
