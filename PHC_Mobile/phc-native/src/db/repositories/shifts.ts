import { execute, query, queryFirst } from '../index';
import type { Shift, ShiftStatus } from '../../types/productV2';

/**
 * The ONE place that writes local `shifts` and `shift_handovers` lifecycle rows.
 *
 * Why this module exists
 * ---------------------
 * W-17 proved that a shift is not one syncable value: start, handover, end and
 * the 12-hour auto-close are independent changes. Their canonical SQL must not
 * drift back toward maintaining the legacy `shifts.sync_status` column.
 *
 * W-10 proved that duplicated `INSERT OR REPLACE` statements silently erase
 * omitted columns. Handover retry used that pattern while omitting `server_id`,
 * `photo_path` and `last_error`. The first two are currently unused, but could
 * become locally-owned state later; the third is intentionally cleared for a
 * fresh retry. The explicit conflict update below preserves identity, server
 * identity, photos and creation time while making that error reset visible.
 */

type SqlParameter = string | number | null;

/** A module-level execute function or a caller's transaction executor. */
export type SqlExecutor = (
  sql: string,
  params?: SqlParameter[],
) => Promise<unknown>;

export interface LocalShiftHandover {
  id: string;
  clientEntryId: string;
  shiftId: string;
  projectMaterialId: number;
  status: 'confirmed' | 'flagged';
  expectedQuantity: number;
  observedQuantity: number | null;
  note: string | null;
  confirmedBy: string;
  now: string;
}

export interface LocalShiftEnd {
  shiftId: string;
  endedAt: string;
  deviceEndedAt: string;
  endType: 'manual' | 'auto';
  notes: string | null;
  updatedAt: string;
}

export interface SyncedShiftStart {
  shiftId: string;
  serverId: string;
  status: ShiftStatus;
  startedAt: string;
  endedAt: string | null;
  endType: 'manual' | 'auto' | 'admin' | null;
  deviceTimeFlag: number;
  updatedAt: string;
}

export interface SyncedShiftEnd {
  shiftId: string;
  serverId: string;
  endedAt: string;
  endType: 'manual' | 'auto';
  deviceTimeFlag: number;
  updatedAt: string;
}

/** Apply the local half of the 12-hour auto-close transition. */
export const markShiftPendingReport = async (
  shiftId: string,
  endedAt: string,
  updatedAt: string,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE shifts
         SET status = 'report_pending', ended_at = ?, end_type = 'auto',
             device_time_flag = 1, updated_at = ?
         WHERE id = ?`,
    [endedAt, updatedAt, shiftId],
  );
};

/** Hydrate a server shift that is absent from local unresolved rows. */
export const mirrorUnresolvedShift = async (
  shift: Shift,
  updatedAt: string,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `INSERT OR REPLACE INTO shifts (
                   id, server_id, client_entry_id, project_id, operator_id, status,
                   started_at, ended_at, start_device_time, end_device_time, end_type,
                   usage_report_submitted, handover_confirmed, device_time_flag, notes,
                   last_error, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      shift.id,
      shift.id,
      shift.client_entry_id ?? null,
      shift.project_id,
      shift.operator_id,
      shift.status,
      shift.started_at,
      shift.ended_at ?? null,
      shift.start_device_time ?? null,
      shift.end_device_time ?? null,
      shift.end_type ?? null,
      shift.usage_report_submitted ? 1 : 0,
      shift.handover_confirmed ? 1 : 0,
      shift.device_time_flag ? 1 : 0,
      shift.notes ?? null,
      shift.started_at,
      updatedAt,
    ],
  );
};

/**
 * Insert a handover observation or refresh only the retry-owned fields.
 *
 * `server_id` and `photo_path` were previously omitted from REPLACE and would
 * have been erased if populated. `last_error` was also omitted, but clearing it
 * is intentional for a new attempt, so the conflict update says that directly.
 */
export const upsertShiftHandover = async (
  handover: LocalShiftHandover,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `INSERT INTO shift_handovers (
               id, client_entry_id, shift_id, project_material_id, status,
               expected_quantity, observed_quantity, note, confirmed_by,
               sync_status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
             ON CONFLICT(shift_id, project_material_id) DO UPDATE SET
               status = excluded.status,
               expected_quantity = excluded.expected_quantity,
               observed_quantity = excluded.observed_quantity,
               note = excluded.note,
               confirmed_by = excluded.confirmed_by,
               sync_status = excluded.sync_status,
               updated_at = excluded.updated_at,
               last_error = NULL`,
    [
      handover.id,
      handover.clientEntryId,
      handover.shiftId,
      handover.projectMaterialId,
      handover.status,
      handover.expectedQuantity,
      handover.observedQuantity,
      handover.note,
      handover.confirmedBy,
      handover.now,
      handover.now,
    ],
  );
};

/** Mark the shift-level handover flag after local observations are stored. */
export const confirmShiftHandoverLocally = async (
  shiftId: string,
  updatedAt: string,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE shifts SET handover_confirmed = 1, updated_at = ? WHERE id = ?`,
    [updatedAt, shiftId],
  );
};

/** Store report/end fields without claiming the server has closed the shift. */
export const recordLocalShiftEnd = async (
  shift: LocalShiftEnd,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE shifts
           SET ended_at = ?, end_device_time = ?, end_type = ?,
               usage_report_submitted = 1, notes = ?, updated_at = ?
           WHERE id = ?`,
    [
      shift.endedAt,
      shift.deviceEndedAt,
      shift.endType,
      shift.notes,
      shift.updatedAt,
      shift.shiftId,
    ],
  );
};

/** Preserve a shift synchronization failure for operator recovery. */
export const recordShiftSyncError = async (
  shiftId: string,
  message: string,
  updatedAt: string,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE shifts SET last_error = ?, updated_at = ? WHERE id = ?`,
    [message, updatedAt, shiftId],
  );
};

/** Apply the server-authoritative start response to its local row. */
export const applySyncedShiftStart = async (
  shift: SyncedShiftStart,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE shifts SET server_id = ?, status = ?, started_at = ?, ended_at = ?,
           end_type = ?, device_time_flag = ?,
           last_error = NULL, updated_at = ? WHERE id = ?`,
    [
      shift.serverId,
      shift.status,
      shift.startedAt,
      shift.endedAt,
      shift.endType,
      shift.deviceTimeFlag,
      shift.updatedAt,
      shift.shiftId,
    ],
  );
};

/**
 * The server closed this shift without this phone, as an admin's force-close does,
 * so it must stop showing as active. A close the phone had queued stays queued, and
 * is refused by the server, which sends its usage figures to the admin review list.
 */
export const applyServerClosedShift = async (
  shift: Pick<Shift, 'id' | 'ended_at' | 'end_type' | 'usage_report_submitted' | 'device_time_flag' | 'notes'>,
  updatedAt: string,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE shifts SET status = 'closed', ended_at = ?, end_type = ?,
           usage_report_submitted = ?, device_time_flag = ?, notes = ?,
           last_error = NULL, updated_at = ?
           WHERE server_id = ? AND status IN ('open', 'report_pending')`,
    [
      shift.ended_at ?? null,
      shift.end_type ?? null,
      shift.usage_report_submitted ? 1 : 0,
      shift.device_time_flag ? 1 : 0,
      shift.notes ?? null,
      updatedAt,
      shift.id,
    ],
  );
};

/**
 * This operator's unresolved shifts on a well. Only their own count: another
 * operator's stale row on this phone must not block their Ficha (audit H5), and the
 * server checks every shift on the well when the Ficha arrives.
 */
export const countOwnUnresolvedShifts = async (
  projectId: number | string,
  operatorId: string,
): Promise<number> => {
  const row = await queryFirst<{ count: number }>(
    `SELECT COUNT(*) AS count FROM shifts
     WHERE project_id = ? AND operator_id = ? AND status IN ('open', 'report_pending')`,
    [projectId, operatorId],
  );
  return Number(row?.count || 0);
};

/**
 * Every operator with an unresolved shift on this well, as the server will see it:
 * a shift that is open or waiting for its report, or closed on this phone while
 * its end (or auto-close) has not reached the server yet. The server refuses a
 * Ficha while any shift on the well is unresolved, whoever opened it, so the
 * phone checks the same set before sending. A refused queue row does not count.
 */
export const unresolvedShiftOperatorsOnWell = async (
  projectId: number | string,
): Promise<Array<{ operator_id: string; name: string | null }>> => {
  return query<{ operator_id: string; name: string | null }>(
    `SELECT DISTINCT s.operator_id AS operator_id, o.name AS name
     FROM shifts s
     LEFT JOIN operators o ON o.id = s.operator_id
     WHERE s.project_id = ?
       AND (
         s.status IN ('open', 'report_pending')
         OR EXISTS (
           SELECT 1 FROM sync_outbox q
           WHERE q.entity_id = s.id
             AND q.entity IN ('shift_start', 'shift_end', 'shift_auto_close')
             AND COALESCE(q.state, 'pending') <> 'quarantined'
         )
       )`,
    [projectId],
  );
};

/**
 * The server refused this shift's start, so it must stop blocking a new one.
 * 'rejected' exists only on the phone. A retry the server accepts restores the
 * real status through applySyncedShiftStart.
 */
export const markShiftRejected = async (
  shiftId: string,
  message: string,
  updatedAt: string,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE shifts SET status = 'rejected', last_error = ?, updated_at = ?
           WHERE id = ? AND status IN ('open', 'report_pending')`,
    [message, updatedAt, shiftId],
  );
};

/** Mark local handover observations synced after server confirmation. */
export const markShiftHandoversSynced = async (
  shiftId: string,
  updatedAt: string,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE shift_handovers SET sync_status = 'synced', last_error = NULL, updated_at = ? WHERE shift_id = ?`,
    [updatedAt, shiftId],
  );
};

/** Revert the optimistic shift flag after permanent server rejection. */
export const markShiftHandoverUnconfirmed = async (
  shiftId: string,
  message: string,
  updatedAt: string,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE shifts SET handover_confirmed = 0, last_error = ?, updated_at = ? WHERE id = ?`,
    [message, updatedAt, shiftId],
  );
};

/** Retain permanently rejected handover observations and their evidence. */
export const markShiftHandoversFailed = async (
  shiftId: string,
  message: string,
  updatedAt: string,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE shift_handovers SET sync_status = 'failed', last_error = ?, updated_at = ?
           WHERE shift_id = ?`,
    [message, updatedAt, shiftId],
  );
};

/** Apply the server-authoritative end response and close the local row. */
export const applySyncedShiftEnd = async (
  shift: SyncedShiftEnd,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE shifts SET server_id = ?, status = 'closed', ended_at = ?, end_type = ?,
           usage_report_submitted = 1, device_time_flag = ?,
           last_error = NULL, updated_at = ? WHERE id = ?`,
    [
      shift.serverId,
      shift.endedAt,
      shift.endType,
      shift.deviceTimeFlag,
      shift.updatedAt,
      shift.shiftId,
    ],
  );
};
