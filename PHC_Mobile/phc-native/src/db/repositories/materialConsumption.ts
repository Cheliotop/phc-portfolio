import { execute } from '../index';
import { storedDateOf } from '../../utils/dateFormat';

/**
 * The ONE place that writes a server `material_consumption` row into SQLite.
 *
 * Why this module exists
 * ---------------------
 * The admin mirror used the server's id as SQLite's autoincrement `id`, even
 * though the schema already had `server_id` for that identity. Server and local
 * ids therefore occupied the same primary-key namespace. `INSERT OR REPLACE`
 * could delete an unrelated offline row and reinsert only 9 of 19 columns,
 * destroying its client idempotency key, shift and reconciliation links,
 * approximation/anomaly evidence, and sync state. Without a collision, the
 * same logical consumption could instead appear twice under two local ids.
 *
 * This mirror never writes local `id`. It upserts on the partial unique
 * `server_id` index and updates only server-owned display fields, so a refresh
 * cannot overwrite locally captured audit or synchronization state.
 */

/** A `material_consumption` row as returned by the server. */
export interface ServerMaterialConsumption {
  id: number;
  project_id: number;
  operator_id: string;
  material_name: string;
  quantity_used: number;
  unit?: string | null;
  date?: string | null;
  notes?: string | null;
  created_at?: string | null;
}

type SqlParameter = string | number | null;

/** A module-level execute function or a caller's transaction executor. */
export type SqlExecutor = (
  sql: string,
  params?: SqlParameter[],
) => Promise<unknown>;

/** Mirror one server row without taking ownership of its local-only fields. */
export const mirrorMaterialConsumption = async (
  consumption: ServerMaterialConsumption,
  currentTime: string = new Date().toISOString(),
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `INSERT INTO material_consumption (
       server_id, project_id, operator_id, material_name, quantity_used,
       unit, date, notes, created_at, updated_at, sync_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(server_id) WHERE server_id IS NOT NULL DO UPDATE SET
       project_id = excluded.project_id,
       operator_id = excluded.operator_id,
       material_name = excluded.material_name,
       quantity_used = excluded.quantity_used,
       unit = excluded.unit,
       date = excluded.date,
       notes = excluded.notes,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [
      consumption.id,
      consumption.project_id,
      consumption.operator_id,
      consumption.material_name,
      consumption.quantity_used,
      consumption.unit ?? '',
      consumption.date || storedDateOf(consumption.created_at || currentTime),
      consumption.notes || null,
      consumption.created_at || currentTime,
      currentTime,
    ],
  );
};

/** Mirror a whole server response through one canonical identity mapping. */
export const mirrorMaterialConsumptions = async (
  consumptions: ServerMaterialConsumption[] | null | undefined,
  currentTime: string = new Date().toISOString(),
  exec: SqlExecutor = execute,
): Promise<void> => {
  for (const consumption of consumptions || []) {
    await mirrorMaterialConsumption(consumption, currentTime, exec);
  }
};
