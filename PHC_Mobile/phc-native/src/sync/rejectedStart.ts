import { query, queryFirst, runInTransaction } from '../db/db';
import { recordDrillingBarSyncError } from '../db/repositories/drillingBars';
import { markShiftHandoversFailed, markShiftRejected } from '../db/repositories/shifts';
import { notifyOperatorDataChanged } from '../events/operatorDataEvents';

/**
 * Stop work waiting on a shift start the server has refused for good.
 *
 * Handovers, bars and closes wait for their shift to get a server id. A refused
 * start never gets one, so that work waited forever and looked merely queued,
 * which also held the phone: nobody else could log in, and the operator could not
 * start another shift (audit B2). Marking it rejected sends it to the admin review
 * list through reportRejectedWork, and the operator can start again.
 *
 * Runs on every drain rather than when the start is refused, so a phone already
 * stuck when the app updates recovers too, and so does a manual "Reintentar" that
 * is refused again. Only starts queued by an app before vc46 can get here, because
 * the app no longer queues starts. Remove this when no phone can still hold one.
 */
export const releaseWorkBehindRejectedStarts = async (): Promise<number> => {
  const refused = await query<{ entity_id: string; last_error: string | null }>(
    `SELECT entity_id, last_error FROM sync_outbox
     WHERE entity = 'shift_start' AND state = 'quarantined'`,
  );

  let released = 0;
  for (const start of refused) {
    const shift = await queryFirst<{ server_id: string | null; status: string }>(
      'SELECT server_id, status FROM shifts WHERE id = ?',
      [start.entity_id],
    );
    if (!shift || shift.server_id) continue;

    const reason = `El servidor rechazó el inicio de este turno: ${start.last_error || 'sin motivo informado'}`;
    const queuedBars = await query<{ id: string; entity_id: string; payload_json: string }>(
      `SELECT id, entity_id, payload_json FROM sync_outbox
       WHERE entity = 'drilling_bar' AND COALESCE(state, 'pending') <> 'quarantined'`,
    );
    const bars = queuedBars.filter((bar) => {
      try {
        return JSON.parse(bar.payload_json).shift_id === start.entity_id;
      } catch {
        return false;
      }
    });

    const now = new Date().toISOString();
    await runInTransaction(async (transaction) => {
      await transaction.execute(
        `UPDATE sync_outbox
         SET state = 'quarantined', retries = MAX(retries, 3), last_error = ?, updated_at = ?
         WHERE entity IN ('shift_handover', 'shift_auto_close', 'shift_end')
           AND entity_id = ?
           AND COALESCE(state, 'pending') <> 'quarantined'`,
        [reason, now, start.entity_id],
      );
      for (const bar of bars) {
        await transaction.execute(
          `UPDATE sync_outbox
           SET state = 'quarantined', retries = MAX(retries, 3), last_error = ?, updated_at = ?
           WHERE id = ?`,
          [reason, now, bar.id],
        );
        await recordDrillingBarSyncError(bar.entity_id, reason, now, transaction.execute);
      }
      await markShiftHandoversFailed(start.entity_id, reason, now, transaction.execute);
      await markShiftRejected(start.entity_id, reason, now, transaction.execute);
    });
    if (shift.status !== 'rejected') released += 1;
  }
  // Nothing was uploaded, so the dashboard's own refresh after a drain will not
  // fire, and the screen would keep showing this shift as active.
  if (released > 0) notifyOperatorDataChanged();
  return released;
};
