import { execute } from '../index';

/**
 * The ONE place that writes a server `project_materials` row into local SQLite.
 *
 * Why this module exists
 * ---------------------
 * There used to be five hand-written copies of this statement — TurnosTab,
 * MaterialesTab and three in AdminDashboard — and they had drifted apart. Two
 * live defects came out of that:
 *
 * 1. AdminDashboard's assign flow wrote its own row with a CLIENT-generated id
 *    while the server row synced down under a different id. One assignment
 *    became two local rows, and the phantom (which the server had never seen)
 *    made the operator's next shift handover fail wholesale with
 *    "A handover item is not an active material in this project (22023)" —
 *    then the outbox gave up after three tries while the UI still showed a
 *    green "Traspaso guardado". The well became undrillable.
 *
 * 2. MaterialesTab's copy listed only 10 of the 13 columns. Its destructive
 *    mirror let omitted columns fall back to defaults. Verified on-device:
 *
 *        after 13-col write:   presupuesto | 46   | 0
 *        after 10-col mirror:  extras      | NULL | 1
 *
 *    So merely opening the Materiales tab reclassified budget materials as
 *    extras, reactivated deactivated ones, and nulled `catalog_variant_id` —
 *    which is the exact phantom shape from defect 1. The tab could recreate
 *    the deadlock.
 *
 * Both classes are impossible to reintroduce by drift as long as every mirror
 * goes through here. If you need a new column, add it once, in this file.
 */

/** A `project_materials` row as returned by the server. */
export interface ServerProjectMaterial {
  id: number;
  project_id: number;
  material_name: string;
  initial_quantity?: number | null;
  current_quantity?: number | null;
  unit?: string | null;
  layer?: string | null;
  catalog_variant_id?: number | null;
  active?: boolean | null;
  assigned_date?: string | null;
  notes?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * Anything that can run a parameterised statement — the module-level `execute`
 * or a `DatabaseTransaction` from `runInTransaction`. Callers already inside a
 * transaction must pass theirs, otherwise the mirror would run outside it and
 * silently lose atomicity.
 */
export type SqlExecutor = (sql: string, params?: any[]) => Promise<unknown>;

/**
 * Mirror a server row into local SQLite, keyed on the SERVER id.
 *
 * Never invent an id here. A locally-numbered row has no server counterpart and
 * is rejected by `confirm_shift_handover`, which is how defect 1 above happened.
 */
export const mirrorProjectMaterial = async (
  material: ServerProjectMaterial,
  now: string = new Date().toISOString(),
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `INSERT INTO project_materials (
       id, project_id, material_name, initial_quantity, current_quantity,
       unit, layer, catalog_variant_id, active, assigned_date, notes,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id,
       material_name = excluded.material_name,
       initial_quantity = excluded.initial_quantity,
       -- Usage in a close still queued on this phone is already off the local
       -- balance, and the server has not applied it yet. Putting the server
       -- figure back showed too much stock until the close landed (code read S7).
       current_quantity = excluded.current_quantity - COALESCE((
         SELECT SUM(mc.quantity_used) FROM material_consumption mc
         WHERE mc.project_material_id = excluded.id
           AND mc.sync_status <> 'synced'
           AND EXISTS (SELECT 1 FROM sync_outbox o
                       WHERE o.entity = 'shift_end' AND o.entity_id = mc.shift_id
                         AND COALESCE(o.state, 'pending') <> 'quarantined')
       ), 0),
       unit = excluded.unit,
       layer = excluded.layer,
       catalog_variant_id = excluded.catalog_variant_id,
       active = excluded.active,
       assigned_date = excluded.assigned_date,
       notes = excluded.notes,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [
      material.id,
      material.project_id,
      material.material_name,
      material.initial_quantity ?? null,
      material.current_quantity ?? null,
      material.unit ?? null,
      material.layer || 'extras',
      material.catalog_variant_id ?? null,
      material.active === false ? 0 : 1,
      material.assigned_date || material.created_at || now,
      material.notes || null,
      material.created_at || now,
      material.updated_at || now,
    ],
  );
};

/** Mirror a whole server response in one pass. */
export const mirrorProjectMaterials = async (
  materials: ServerProjectMaterial[] | null | undefined,
  now: string = new Date().toISOString(),
  exec: SqlExecutor = execute,
): Promise<void> => {
  for (const material of materials || []) {
    await mirrorProjectMaterial(material, now, exec);
  }
};
