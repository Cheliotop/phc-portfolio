import { query } from '../db/db';
import { applyServerClosedShift } from '../db/repositories/shifts';
import { notifyOperatorDataChanged } from '../events/operatorDataEvents';
import { shiftsApi } from '../api/supabase-shifts';

/**
 * Catch up with shifts the server has closed without this phone.
 *
 * The shift screen asks the server about a shift only when the phone holds none of
 * its own. A shift an admin force-closed (audit H4) would stay active on the
 * operator's phone for good, and they could never start another. Runs on every
 * drain, so the phone catches up as soon as it has signal.
 *
 * Throws when the server can't be reached. The caller carries on, and the next
 * drain asks again.
 */
export const reconcileServerClosedShifts = async (): Promise<number> => {
  const local = await query<{ server_id: string }>(
    `SELECT server_id FROM shifts
     WHERE server_id IS NOT NULL AND status IN ('open', 'report_pending')`,
  );
  if (local.length === 0) return 0;

  const closed = await shiftsApi.getClosedAmong(local.map((shift) => shift.server_id));
  const now = new Date().toISOString();
  for (const shift of closed) {
    await applyServerClosedShift(shift, now);
  }
  // Nothing was uploaded, so the dashboard's own refresh after a drain will not
  // fire, and the screen would keep showing this shift as active.
  if (closed.length > 0) notifyOperatorDataChanged();
  return closed.length;
};
