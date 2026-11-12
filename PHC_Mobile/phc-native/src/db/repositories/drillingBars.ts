import { execute } from '../index';

/**
 * The ONE place that writes local `drilling_bar_entries` rows.
 *
 * Why this module exists
 * ---------------------
 * W-10 proved that duplicated SQLite statements can silently discard omitted
 * columns. A drilling bar is the well-depth audit trail: local creation, server
 * hydration, photo upload and the canonical server response must not drift on
 * identity, bar number or depth. Centralizing those writes makes every field
 * that may change after sync explicit without replacing the locally-owned row.
 *
 * Exact replay is protected by local `id` and server `client_entry_id`, while
 * `(project_id, bar_number)` rejects a reused local number. Those keys do not
 * detect a second operator submission created with a new id and next number;
 * the repository preserves that existing behavior rather than inventing a
 * duplicate heuristic that could discard a real physical bar.
 */

type SqlParameter = string | number | null;

/** A module-level execute function or a caller's transaction executor. */
export type SqlExecutor = (
  sql: string,
  params?: SqlParameter[],
) => Promise<unknown>;

export interface LocalDrillingBar {
  id: string;
  projectId: string;
  operatorId: string;
  shiftId: string;
  barNumber: number;
  depthStart: number;
  depthEnd: number;
  length: number;
  diameter: string | null;
  soilType: string;
  startTime: string;
  endTime: string;
  durationMinutes: number | null;
  waterLevel: number | null;
  notes: string | null;
  photoPaths: string;
  timestampLocal: string;
}

export interface ServerDrillingBar {
  id: number;
  client_entry_id?: string | null;
  project_id: number;
  operator_id: string;
  shift_id?: string | null;
  bar_number: number;
  depth_start: number;
  depth_end: number;
  length: number;
  diameter: string | null;
  soil_type: string;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  water_level: number | null;
  notes: string | null;
  photo_paths: string | null;
  timestamp_local: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SyncedDrillingBar {
  id: string;
  serverId: number | null;
  barNumber?: number | null;
  depthStart?: number | null;
  depthEnd?: number | null;
  length?: number | null;
  updatedAt: string;
}

/** Insert the locally-owned bar before its outbox intent is queued. */
export const createLocalDrillingBar = async (
  bar: LocalDrillingBar,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `INSERT INTO drilling_bar_entries (
            id, project_id, operator_id, shift_id, bar_number, depth_start, depth_end,
            length, diameter, soil_type, start_time, end_time, duration_minutes,
            water_level, notes, photo_paths, timestamp_local, sync_status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      bar.id, bar.projectId, bar.operatorId, bar.shiftId, bar.barNumber,
      bar.depthStart, bar.depthEnd, bar.length, bar.diameter,
      bar.soilType, bar.startTime, bar.endTime, bar.durationMinutes, bar.waterLevel,
      bar.notes, bar.photoPaths, bar.timestampLocal, bar.timestampLocal, bar.timestampLocal,
    ],
  );
};

/**
 * Hydrate an absent server bar without overwriting a locally queued row.
 *
 * This `OR IGNORE` depends on both the primary key and the schema's
 * `(project_id, bar_number)` UNIQUE constraint.
 */
export const mirrorServerDrillingBar = async (
  bar: ServerDrillingBar,
  exec: SqlExecutor = execute,
): Promise<void> => {
  const localId = bar.client_entry_id || `server_${bar.id}`;
  await moveProvisionalNumberOutOfTheWay('?', [bar.project_id], bar.bar_number, localId, exec);
  await exec(
    `INSERT OR IGNORE INTO drilling_bar_entries (
          id, server_id, project_id, operator_id, shift_id, bar_number, depth_start,
          depth_end, length, diameter, soil_type, start_time, end_time,
          duration_minutes, water_level, notes, photo_paths, timestamp_local,
          sync_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)`,
    [
      localId,
      bar.id,
      bar.project_id,
      String(bar.operator_id),
      bar.shift_id ?? null,
      bar.bar_number,
      bar.depth_start,
      bar.depth_end,
      bar.length,
      bar.diameter,
      bar.soil_type,
      bar.start_time,
      bar.end_time,
      bar.duration_minutes,
      bar.water_level,
      bar.notes,
      bar.photo_paths,
      bar.timestamp_local || bar.created_at,
      bar.created_at || new Date().toISOString(),
      bar.updated_at || new Date().toISOString(),
    ],
  );
};

/** Store uploaded photo paths without changing the bar's measurements. */
export const updateDrillingBarPhotoPaths = async (
  id: string,
  photoPaths: string,
  updatedAt: string,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE drilling_bar_entries
         SET photo_paths = ?, updated_at = ?
         WHERE id = ?`,
    [photoPaths, updatedAt, id],
  );
};

/**
 * Make room for a number the server has given out.
 *
 * Bars recorded offline get a provisional local number. When a teammate's bar took
 * that number on the server first, the server's number is the real one, and the
 * local UNIQUE (project_id, bar_number) refused it: the phone showed the SQL error,
 * and the bar could not finish syncing until a later bar freed the number (audit,
 * "crew bar numbering collision"). Bars now upload strictly in order, so that later
 * bar waits behind this one and nothing would ever free it. A provisional holder
 * moves to the end of the list until its own upload gives it its real number.
 */
const moveProvisionalNumberOutOfTheWay = async (
  projectSql: string,
  projectParams: SqlParameter[],
  barNumber: number,
  exceptId: string,
  exec: SqlExecutor,
): Promise<void> => {
  await exec(
    `UPDATE drilling_bar_entries
         SET bar_number = (SELECT MAX(b.bar_number) + 1 FROM drilling_bar_entries b
                           WHERE b.project_id = drilling_bar_entries.project_id)
         WHERE server_id IS NULL
           AND bar_number = ?
           AND id <> ?
           AND project_id = ${projectSql}`,
    [barNumber, exceptId, ...projectParams],
  );
};

/** Apply the locked server depth chain to the existing local identity. */
export const applySyncedDrillingBar = async (
  bar: SyncedDrillingBar,
  exec: SqlExecutor = execute,
): Promise<void> => {
  if (bar.serverId !== null && bar.serverId !== undefined) {
    // A copy of this same server bar, mirrored under another id before this
    // phone's own row learned its server id.
    await exec(
      'DELETE FROM drilling_bar_entries WHERE server_id = ? AND id <> ?',
      [bar.serverId, bar.id],
    );
  }
  if (bar.barNumber !== null && bar.barNumber !== undefined) {
    await moveProvisionalNumberOutOfTheWay(
      '(SELECT project_id FROM drilling_bar_entries WHERE id = ?)', [bar.id], bar.barNumber, bar.id, exec,
    );
  }
  await exec(
    `UPDATE drilling_bar_entries
         SET sync_status = 'synced',
             server_id = ?,
             bar_number = COALESCE(?, bar_number),
             depth_start = COALESCE(?, depth_start),
             depth_end = COALESCE(?, depth_end),
             length = COALESCE(?, length),
             last_error = NULL,
             updated_at = ?
         WHERE id = ?`,
    [
      bar.serverId,
      bar.barNumber ?? null,
      bar.depthStart ?? null,
      bar.depthEnd ?? null,
      bar.length ?? null,
      bar.updatedAt,
      bar.id,
    ],
  );
};

/** Preserve a rejected bar and its measurements for a later retry. */
export const recordDrillingBarSyncError = async (
  id: string,
  message: string,
  updatedAt: string,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `UPDATE drilling_bar_entries
         SET sync_status = 'failed', last_error = ?, updated_at = ?
         WHERE id = ?`,
    [message, updatedAt, id],
  );
};
