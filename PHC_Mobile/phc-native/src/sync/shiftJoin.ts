import { query, queryFirst, runInTransaction } from '../db/db';
import { projectMembershipSql } from '../db/projectMembership';
import { createClientEntryId } from '../utils/clientId';

/**
 * A crew member's claim on a well's open shift. The server records who was on
 * each shift (`shift_participants`) through `join_shift`; this device queues that
 * call once per (shift, operator), so the record exists even when the partner
 * never starts or ends the shift.
 */
export const queueShiftJoin = async (
  shift: { id: string; project_id: number; status: string },
  operatorId: string,
): Promise<boolean> => {
  if (!operatorId || shift.status !== 'open') return false;

  const crew = await queryFirst<{ found: number }>(
    `SELECT 1 AS found FROM projects p WHERE p.id = ? AND ${projectMembershipSql('p')} LIMIT 1`,
    [shift.project_id, operatorId, operatorId],
  );
  if (!crew) return false;

  const now = new Date().toISOString();
  return runInTransaction(async (transaction) => {
    const inserted = await transaction.execute(
      'INSERT OR IGNORE INTO shift_joined_local (shift_id, operator_id, joined_at) VALUES (?, ?, ?)',
      [shift.id, operatorId, now],
    );
    if (inserted.changes === 0) return false;
    await transaction.execute(
      `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, author_id, retries, created_at, updated_at)
       VALUES (?, 'shift_join', ?, 'INSERT', ?, ?, 0, ?, ?)`,
      [
        createClientEntryId('outbox'),
        shift.id,
        JSON.stringify({ shiftId: shift.id, projectId: shift.project_id }),
        operatorId,
        now,
        now,
      ],
    );
    return true;
  });
};

/** Rows of the joins still waiting, for tests and the queue. */
export const pendingShiftJoins = (shiftId: string) => query<{ id: string; author_id: string | null }>(
  `SELECT id, author_id FROM sync_outbox
   WHERE entity = 'shift_join' AND entity_id = ? AND COALESCE(state, 'pending') <> 'quarantined'`,
  [shiftId],
);
