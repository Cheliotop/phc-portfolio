import { execute } from '../index';

/**
 * The ONE place that writes production `operators` reference rows.
 *
 * Why this module exists
 * ---------------------
 * W-10 proved that duplicated SQLite statements drift in ways that silently
 * change local state. Operators deliberately need two different conflict
 * strategies, so their intent must remain visible rather than being collapsed:
 *
 * - A server mirror uses `ON CONFLICT DO UPDATE` so the server's name and
 *   activation state win without deleting an operator row referenced by a
 *   project or field record.
 * - A foreign-key stub uses `OR IGNORE` because it exists only to ensure the
 *   referenced id is present. A stub must never replace a real mirror and
 *   clobber its authoritative name or inactive status.
 *
 * The legacy `pin` column is intentionally absent from production writes. It is
 * used only by the development seed fixture; application authentication is
 * Supabase-based and never reads it.
 */

type SqlParameter = string | number | null;

/** A module-level execute function or a caller's transaction executor. */
export type SqlExecutor = (
  sql: string,
  params?: SqlParameter[],
) => Promise<unknown>;

export interface ServerOperatorMirror {
  id: string;
  fullName?: string | null;
  username?: string | null;
  isActive?: boolean | null;
  createdAt?: string | null;
  currentTime: string;
}

export interface OperatorStub {
  id: string;
  name: string;
  currentTime: string;
}

/** Replace stale reference data with one server-authoritative operator row. */
export const mirrorOperator = async (
  operator: ServerOperatorMirror,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `INSERT INTO operators (id, name, role, status, created_at, updated_at)
                   VALUES (?, ?, 'operator', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       role = excluded.role,
       status = excluded.status,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [
      operator.id,
      operator.fullName || operator.username || `Operador ${operator.id}`,
      operator.isActive === false ? 'inactive' : 'active',
      operator.createdAt || operator.currentTime,
      operator.currentTime,
    ],
  );
};

/** Ensure an FK parent exists without replacing any real mirrored row. */
export const ensureOperatorStub = async (
  operator: OperatorStub,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `INSERT OR IGNORE INTO operators (id, name, role, status, created_at, updated_at)
                 VALUES (?, ?, 'operator', 'active', ?, ?)`,
    [operator.id, operator.name, operator.currentTime, operator.currentTime],
  );
};

/** Mirror an activation change only after the server accepts it. */
export const updateOperatorStatus = async (
  id: string,
  status: 'active' | 'inactive',
  updatedAt: string,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `
          UPDATE operators
          SET status = ?, updated_at = ?
          WHERE id = ?
        `,
    [status, updatedAt, id],
  );
};

/**
 * The signed-in operator's own row. Every record they save references it (shifts,
 * progress, consumption, samples, pedidos), and on a shared tablet operador 2 was
 * never mirrored: wells list only operador 1 as assigned. Their own name is
 * authoritative, so it replaces a stub's placeholder; nothing else is touched.
 */
export const rememberSignedInOperator = async (
  operator: OperatorStub,
  exec: SqlExecutor = execute,
): Promise<void> => {
  await exec(
    `INSERT INTO operators (id, name, role, status, created_at, updated_at)
                 VALUES (?, ?, 'operator', 'active', ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    [operator.id, operator.name, operator.currentTime, operator.currentTime],
  );
};
