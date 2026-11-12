import { projectMembershipSql } from '../db/projectMembership';
export { projectMembershipSql };
import AsyncStorage from '@react-native-async-storage/async-storage';
import { query, runInTransaction } from '../db/db';
import { mirrorProjects } from '../db/repositories/projects';
import { ensureOperatorStub, rememberSignedInOperator } from '../db/repositories/operators';
import { projectsApi } from './supabase-projects';
import { productV2Api } from './supabase-product-v2';
import { isActiveStatus } from '../domain/projectStatus';

interface SecondaryAssignment {
  project_id: number | string;
  operator_id: string;
  created_at?: string | null;
}

/**
 * Pass 3: single source of truth for loading an operator's projects.
 *
 * Previously five screens each had their own copy of `cacheServerProjects`
 * and their own SQLite query, and ProgresoTab's query intentionally leaked
 * unassigned projects (`assigned_operator_id IS NULL OR ''`). That let an
 * operator log work against wells that were not theirs. This module makes
 * "the operator only ever sees their assigned projects" true in one place.
 *
 * Offline-first is preserved: the server refresh is best-effort, and reads
 * always come from local SQLite.
 *
 * ASSIGNED MEANS TWO THINGS
 * -------------------------
 * Since the 2026-07-25 server migration a well has a responsible operator
 * (`projects.assigned_operator_id`) and any number of subcontractors
 * (`project_secondary_operators`). Only the first was ever read here, so a
 * subcontractor was told they had no wells while the row sat in local SQLite,
 * correctly mirrored, one filter away. Both are read now, and the filter that
 * keeps an operator out of wells that are not theirs is left intact — it is
 * widened to the real definition of membership rather than removed.
 */

export interface AssignedProject {
  id: string;
  name: string;
  location?: string | null;
  assigned_operator_id?: string | null;
  target_depth?: number | null;
  default_bar_length?: number | null;
  default_bar_diameter?: string | null;
  well_name?: string | null;
  progress?: number | null;
  status?: string | null;
}

/**
 * Best-effort: pull every project the server will return for this user and
 * mirror it into local SQLite. Requires a token; silently no-ops offline.
 * (Server RLS already scopes operators to their own assigned projects.)
 */
export const cacheServerProjects = async (): Promise<void> => {
  const token = await AsyncStorage.getItem('authToken');
  if (!token) return;

  const serverProjects = await projectsApi.getAll();
  const now = new Date().toISOString();
  const currentName = (await AsyncStorage.getItem('userName')) || 'Operador';
  const currentUserId = await AsyncStorage.getItem('userId');
  const currentRole = await AsyncStorage.getItem('userRole');

  // `projects.assigned_operator_id` is a real SQLite foreign key. A fresh
  // operator install has no local operator mirror yet, so inserting projects
  // first fails the entire refresh. Seed only the referenced parents and
  // mirror the project set in the same transaction. A later authoritative
  // operator refresh safely upgrades these stubs.
  // Best-effort as well, and fetched before the transaction opens so a failure
  // here costs nothing: an offline device keeps the assignments it already has
  // rather than losing access to a well mid-shift.
  let secondaryAssignments: SecondaryAssignment[] | null = null;
  try {
    secondaryAssignments = await productV2Api.getVisibleSecondaryAssignments();
  } catch (error) {
    console.warn('[PHC] Could not refresh subcontractor assignments:', error);
  }

  await runInTransaction(async (transaction) => {
    const operatorIds = new Set(
      (serverProjects || [])
        .map((project) => project.assigned_operator_id)
        .filter((id): id is string => Boolean(id)),
    );
    for (const operatorId of operatorIds) {
      await ensureOperatorStub({
        id: operatorId,
        // Only the signed-in operator's own name is known here. Another operator's
        // stub (operador 1 seen from operador 2's session) must not carry it.
        name: operatorId === currentUserId ? currentName : 'Operador',
        currentTime: now,
      }, transaction.execute);
    }
    if (currentUserId && currentRole !== 'admin') {
      await rememberSignedInOperator({ id: currentUserId, name: currentName, currentTime: now }, transaction.execute);
    }
    await mirrorProjects(serverProjects, now, transaction.execute);

    // A well still assigned to the signed-in operator on this phone, but absent from
    // the server's list (reassigned away, or closed and hidden by RLS), stops
    // listing for them. Only rows assigned to the signed-in user are touched: a
    // shared tablet also holds other operators' wells. Rows are never deleted,
    // because local field data may reference them. An EMPTY list is never trusted:
    // a request that lost its session is answered 200 with no rows by RLS, and
    // acting on it would hide every well this operator works.
    if (currentUserId && serverProjects && serverProjects.length > 0) {
      const serverIds = serverProjects.map((project) => Number(project.id));
      const placeholders = serverIds.map(() => '?').join(', ');
      await transaction.execute(
        serverIds.length
          ? `UPDATE projects SET assigned_operator_id = NULL
             WHERE assigned_operator_id = ? AND id NOT IN (${placeholders})`
          : 'UPDATE projects SET assigned_operator_id = NULL WHERE assigned_operator_id = ?',
        [currentUserId, ...serverIds],
      );
    }

    if (secondaryAssignments && currentUserId) {
      // The server exposes only this account's memberships and crew on wells
      // it leads. Replacing the whole tablet cache erases OTHER accounts' wells
      // and strands their queued work after the next offline switch.
      if (currentRole === 'admin') {
        await transaction.execute('DELETE FROM project_secondary_operators');
      } else {
        const primaryIds = serverProjects
          .filter((project) => project.assigned_operator_id === currentUserId)
          .map((project) => Number(project.id));
        await transaction.execute(
          `DELETE FROM project_secondary_operators WHERE operator_id = ?${primaryIds.length
            ? ` OR project_id IN (${primaryIds.map(() => '?').join(', ')})` : ''}`,
          [currentUserId, ...primaryIds],
        );
      }
      for (const assignment of secondaryAssignments) {
        await transaction.execute(
          `INSERT OR REPLACE INTO project_secondary_operators
             (project_id, operator_id, created_at) VALUES (?, ?, ?)`,
          [
            Number(assignment.project_id),
            String(assignment.operator_id),
            assignment.created_at ?? now,
          ],
        );
      }
    }
  });
};


/**
 * Load the projects `operatorId` is on from local SQLite — as the responsible
 * operator or as a subcontractor. Never returns unassigned projects. Set
 * `activeOnly` to restrict to in-progress wells.
 */
export const loadAssignedProjects = async (
  operatorId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<AssignedProject[]> => {
  if (!operatorId) return [];

  const rows = await query<AssignedProject>(
    `SELECT id, name, location, assigned_operator_id, target_depth,
            default_bar_length, default_bar_diameter, well_name, progress, status
     FROM projects
     WHERE ${projectMembershipSql()}
       AND (deleted = 0 OR deleted IS NULL)
     ORDER BY updated_at DESC`,
    [operatorId, operatorId],
  );

  if (opts.activeOnly) {
    return (rows || []).filter((p) => isActiveStatus(p.status));
  }
  return rows || [];
};

/**
 * Convenience: refresh from server (best-effort) then return assigned projects.
 */
export const refreshAssignedProjects = async (
  operatorId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<AssignedProject[]> => {
  await cacheServerProjects().catch((error) => {
    console.warn('[PHC] Could not refresh assigned projects from server:', error);
  });
  return loadAssignedProjects(operatorId, opts);
};
