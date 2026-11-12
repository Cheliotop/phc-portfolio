import { query, queryFirst } from '../db/db';
import { operatorErrorText } from '../utils/errorMessage';

/**
 * What the header badge counts.
 *
 * `waiting` is work still on its way, including rows whose last attempt failed for
 * lack of signal: they retry by themselves. `refused` is work the server turned down
 * for good that has not reached the admin's review list yet. Once it has, the admin
 * owns it, and the badge stops counting it; the queue screen still lists it.
 */
export interface QueueStatus {
  waiting: number;
  refused: number;
}

export const readQueueStatus = async (): Promise<QueueStatus> => {
  const row = await queryFirst<{ waiting: number | null; refused: number | null }>(
    `SELECT
       SUM(CASE WHEN COALESCE(o.state, 'pending') <> 'quarantined' THEN 1 ELSE 0 END) AS waiting,
       SUM(CASE WHEN o.state = 'quarantined' AND r.uploaded_at IS NULL THEN 1 ELSE 0 END) AS refused
     FROM sync_outbox o
     LEFT JOIN rejected_work r ON r.id = o.id`,
  );
  return { waiting: Number(row?.waiting || 0), refused: Number(row?.refused || 0) };
};

/** Where a shift's queued close stands, for the shift screen. */
export type ShiftCloseState =
  | { kind: 'none' }
  | { kind: 'queued'; barsWaiting: number }
  | { kind: 'refused'; reason: string };

export const readShiftCloseState = async (
  shift: { id: string; server_id?: string | null },
): Promise<ShiftCloseState> => {
  const close = await queryFirst<{ state: string | null; last_error: string | null }>(
    `SELECT state, last_error FROM sync_outbox
     WHERE entity = 'shift_end' AND entity_id = ?
     ORDER BY created_at DESC LIMIT 1`,
    [shift.id],
  );
  if (!close) return { kind: 'none' };
  if (close.state === 'quarantined') {
    return { kind: 'refused', reason: operatorErrorText(close.last_error) || 'sin motivo informado' };
  }
  // The close waits for the shift's bars; see syncPendingShiftEnds.
  const ids = new Set([shift.id, shift.server_id].filter(Boolean));
  const bars = await query<{ payload_json: string }>(
    `SELECT payload_json FROM sync_outbox
     WHERE entity = 'drilling_bar' AND COALESCE(state, 'pending') <> 'quarantined'`,
  );
  const barsWaiting = bars.filter((bar) => {
    try {
      return ids.has(JSON.parse(bar.payload_json)?.shift_id);
    } catch {
      return false;
    }
  }).length;
  return { kind: 'queued', barsWaiting };
};

/** Where one record saved on this phone stands after a drain. */
export type RecordSendState =
  | { kind: 'sent' }
  | { kind: 'waiting' }
  | { kind: 'refused'; reason: string };

/**
 * Judge a record by its own queue row, not by a sync step's totals: those count
 * every waiting record of that kind, so an older one could be blamed on this one
 * (code read O10, S5). No row left means it was sent.
 */
export const readRecordSendState = async (entity: string, entityId: string): Promise<RecordSendState> => {
  const row = await queryFirst<{ state: string | null; last_error: string | null }>(
    `SELECT state, last_error FROM sync_outbox
     WHERE entity = ? AND entity_id = ?
     ORDER BY created_at DESC LIMIT 1`,
    [entity, entityId],
  );
  if (!row) return { kind: 'sent' };
  if (row.state === 'quarantined') {
    return { kind: 'refused', reason: operatorErrorText(row.last_error) || 'sin motivo informado' };
  }
  return { kind: 'waiting' };
};
