import { statusLabel } from '../../domain/projectStatus';
import { execute } from '../index';

/**
 * The ONE place that writes a server `projects` row into local SQLite.
 *
 * Why this module exists
 * ---------------------
 * Defect A from the 2026-07-26 local-data-layer audit proved that the admin
 * mirror listed only 13 of the table's 14 columns. It omitted `created_at` from
 * a destructive mirror, so SQLite could lose server timestamps. This uses a
 * real UPSERT: unlike `INSERT OR REPLACE`, it does not delete the parent row
 * before inserting it again (which would fail as soon as shifts or field rows
 * reference the project).
 *
 * Three other copies also replaced the server `updated_at` with device refresh
 * time. A bulk refresh then stamped every row identically; the audit observed a
 * real 22-project ordering tie. Keeping the complete statement here prevents
 * either timestamp from drifting or disappearing again.
 */

/** A `projects` row as returned by the server. */
export interface ServerProject {
  id: number;
  name: string;
  location?: string | null;
  assigned_operator_id?: string | null;
  target_depth?: number | null;
  default_bar_length?: number | null;
  default_bar_diameter?: string | null;
  coordinates?: string | null;
  well_name?: string | null;
  progress_percentage?: number | null;
  status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

type SqlParameter = string | number | null;

/** A module-level execute function or a caller's transaction executor. */
export type SqlExecutor = (
  sql: string,
  params?: SqlParameter[],
) => Promise<unknown>;

/** Mirror one server row, keyed on its server id. */
export const mirrorProject = async (
  project: ServerProject,
  currentTime: string = new Date().toISOString(),
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `INSERT INTO projects (
        id, name, location, assigned_operator_id, target_depth,
        default_bar_length, default_bar_diameter, coordinates, well_name,
        progress, status, created_at, updated_at, deleted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        location = excluded.location,
        assigned_operator_id = excluded.assigned_operator_id,
        target_depth = excluded.target_depth,
        default_bar_length = excluded.default_bar_length,
        default_bar_diameter = excluded.default_bar_diameter,
        coordinates = excluded.coordinates,
        well_name = excluded.well_name,
        progress = excluded.progress,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        deleted = 0`,
    [
      project.id,
      project.name,
      project.location || '',
      // Generated production types proved the legacy server aliases do not
      // exist. SQLite still legitimately stores its own `progress` column.
      project.assigned_operator_id || null,
      project.target_depth ?? null,
      project.default_bar_length ?? 3,
      project.default_bar_diameter ?? null,
      project.coordinates ?? null,
      project.well_name ?? null,
      project.progress_percentage ?? 0,
      statusLabel(project.status),
      project.created_at || currentTime,
      project.updated_at || currentTime,
    ],
  );
};

/** Mirror a whole server response in one pass. */
export const mirrorProjects = async (
  projects: ServerProject[] | null | undefined,
  currentTime: string = new Date().toISOString(),
  exec: SqlExecutor = execute,
): Promise<void> => {
  for (const project of projects || []) {
    await mirrorProject(project, currentTime, exec);
  }
};
