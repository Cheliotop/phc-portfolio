import type { DatabaseTransaction } from '../db';

/**
 * SQLite v9 mirrors subcontractor assignments so the operator app can see them.
 *
 * The 2026-07-25 server migration added `project_secondary_operators` and
 * widened the `projects` SELECT policy to include subcontractors. The database
 * has been returning those wells ever since, and `mirrorProjects` has been
 * writing them into SQLite ever since — but every local read filtered on
 * `assigned_operator_id = ?`, so the well arrived on the device and was then
 * discarded on the way back out. A subcontractor saw "no tenés pozos
 * asignados", and the admin's Operadores tab counted them as zero.
 *
 * That filter is not an oversight: it came from a real fix that stopped
 * operators logging work against wells that were not theirs. It simply predates
 * the subcontractor feature and was never reconciled with it. So the fix is to
 * teach the local database what a subcontractor is, not to relax the filter.
 */
export const SECONDARY_OPERATOR_ASSIGNMENTS_SCHEMA_VERSION = 9;

/**
 * `project_id` is INTEGER to match `projects.id INTEGER PRIMARY KEY`. SQLite
 * compares INTEGER 5 and TEXT '5' as unequal, so declaring this TEXT would make
 * every membership lookup return nothing — silently reproducing the exact bug
 * this table exists to end, with no error to notice.
 *
 * Deliberately no FOREIGN KEY to projects(id). An assignment for a project that
 * is missing locally is harmless: every read joins through `projects`, so an
 * orphan row is simply invisible. A foreign key would instead abort the whole
 * refresh transaction and cost the operator their other wells too.
 */
export const PROJECT_SECONDARY_OPERATORS_TABLE_SQL =
  `CREATE TABLE IF NOT EXISTS project_secondary_operators (
    project_id INTEGER NOT NULL,
    operator_id TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, operator_id)
  )`;

/** Every read is "which wells is this operator a subcontractor on?". */
export const PROJECT_SECONDARY_OPERATORS_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_project_secondary_operators_operator ON project_secondary_operators(operator_id)';

/**
 * The table itself is created by the `createTablesSQL` pass that runs before
 * every versioned migration, so this only has to add the lookup index and
 * advance the version. No field data is read, rewritten or deleted.
 */
export const migrateV8ToV9 = async (transaction: DatabaseTransaction): Promise<void> => {
  await transaction.execute(PROJECT_SECONDARY_OPERATORS_INDEX_SQL);
  await transaction.execute(
    `PRAGMA user_version = ${SECONDARY_OPERATOR_ASSIGNMENTS_SCHEMA_VERSION}`,
  );
};
