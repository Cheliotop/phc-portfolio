import { execute, query } from '../db/db';
import { rejectedWorkApi } from '../api/supabase-rejected-work';
import { archiveRejectedRows, getOutboxOwner } from './outboxOwner';

interface RejectedWorkRow {
  id: string;
  owner_id: string;
  entity: string | null;
  entity_id: string | null;
  op: string | null;
  payload_json: string | null;
  last_error: string | null;
  rejected_at: string | null;
}

const parsePayload = (raw: string | null): Record<string, unknown> => {
  try {
    const value = JSON.parse(raw || 'null');
    return value && typeof value === 'object' ? value : { value };
  } catch {
    // Unreadable to the app, but the admin should still see what was stored.
    return { unreadable: raw };
  }
};

/**
 * Send refused work to the admin review list.
 *
 * Rejected rows are copied to `rejected_work` first, so there is one place to
 * read from whether the row is still in this operator's queue or was archived
 * when the phone changed hands. A row stays unmarked until the server has it, so
 * a failed upload is simply tried again on the next drain. The server ignores a
 * repeat, so a lost response cannot create a second report.
 */
export const reportRejectedWork = async (): Promise<number> => {
  const owner = await getOutboxOwner();
  if (owner) {
    await archiveRejectedRows(owner, execute);
  }

  const rows = await query<RejectedWorkRow>(
    `SELECT id, owner_id, entity, entity_id, op, payload_json, last_error, rejected_at
     FROM rejected_work
     WHERE uploaded_at IS NULL
       -- A retry got it through before the report went out: nothing to review.
       AND sent_at IS NULL
     ORDER BY archived_at ASC
     LIMIT 25`,
  );

  let reported = 0;
  for (const row of rows) {
    try {
      await rejectedWorkApi.report({
        clientEntryId: row.id,
        operatorId: row.owner_id,
        entity: row.entity || 'unknown',
        entityId: row.entity_id,
        op: row.op,
        payload: parsePayload(row.payload_json),
        rejectionReason: row.last_error,
        rejectedAt: row.rejected_at,
      });
      await execute('UPDATE rejected_work SET uploaded_at = ? WHERE id = ?', [
        new Date().toISOString(),
        row.id,
      ]);
      reported += 1;
    } catch (error) {
      console.warn('[PHC] Rejected work report failed, will retry:', error);
    }
  }

  // Reported, then a manual retry got it through: tell the review list, so the
  // admin doesn't enter it again by hand (code read S8).
  const sentLater = await query<{ id: string }>(
    `SELECT id FROM rejected_work
     WHERE uploaded_at IS NOT NULL AND sent_at IS NOT NULL AND sent_reported_at IS NULL
     LIMIT 25`,
  );
  for (const row of sentLater) {
    try {
      await rejectedWorkApi.markSent(row.id);
      await execute('UPDATE rejected_work SET sent_reported_at = ? WHERE id = ?', [
        new Date().toISOString(),
        row.id,
      ]);
    } catch (error) {
      console.warn('[PHC] Could not tell the review list that work got through, will retry:', error);
    }
  }
  return reported;
};
