import AsyncStorage from '@react-native-async-storage/async-storage';
import { queryFirst, runInTransaction } from '../db/db';

/** Legacy device owner key is retained only to attribute pre-v11 outbox rows. */
const OWNER_KEY = 'phc.outboxOwnerId';

/** Rows still headed for the server (permanently rejected ones excluded). */
export const countUnsentOutboxRows = async (): Promise<number> => {
  const row = await queryFirst<{ count: number }>(
    `SELECT COUNT(*) AS count FROM sync_outbox
     WHERE COALESCE(state, 'pending') <> 'quarantined'`,
  );
  return Number(row?.count || 0);
};

/** Rows the server permanently rejected, still in this operator's queue. */
export const countRejectedOutboxRows = async (): Promise<number> => {
  const row = await queryFirst<{ count: number }>(
    `SELECT COUNT(*) AS count FROM sync_outbox
     WHERE COALESCE(state, 'pending') = 'quarantined'`,
  );
  return Number(row?.count || 0);
};

/** Who the queued work belongs to, or null before anyone has signed in. */
export const getOutboxOwner = (): Promise<string | null> => AsyncStorage.getItem(OWNER_KEY);

/**
 * Copy rejected outbox rows with their original author; `ownerId` is only the
 * fallback for legacy rows without authorship. Safe to repeat:
 * a row already copied keeps its first copy.
 */
export const archiveRejectedRows = async (
  ownerId: string,
  exec: (sql: string, params?: any[]) => Promise<unknown>,
): Promise<void> => {
  await exec(
    `INSERT OR IGNORE INTO rejected_work (
       id, owner_id, entity, entity_id, op, payload_json, last_error,
       created_at, rejected_at, archived_at
     )
     SELECT id, COALESCE(author_id, ?), entity, entity_id, op, payload_json, last_error,
            created_at, updated_at, ?
     FROM sync_outbox
     WHERE COALESCE(state, 'pending') = 'quarantined'`,
    [ownerId, new Date().toISOString()],
  );
};

export interface OutboxClaim {
  ok: boolean;
  unsent: number;
}

/**
 * Operator switching never archives or removes any queued work.
 */
export const claimOutbox = async (userId: string): Promise<OutboxClaim> => {
  await AsyncStorage.setItem(OWNER_KEY, userId);
  return { ok: true, unsent: 0 };
};

/**
 * Any signed-in crew member can drain; row authorship is enforced per RPC.
 */
export const outboxBelongsTo = async (userId: string | null | undefined): Promise<boolean> => {
  if (!userId) return false;
  return true;
};
