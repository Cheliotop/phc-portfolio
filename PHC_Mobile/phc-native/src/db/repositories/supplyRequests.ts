import { execute, type QueryResult } from '../index';

/**
 * The ONE place that creates a local `supply_requests` row in SQLite.
 *
 * Why this module exists
 * ---------------------
 * `supply_requests` has two identities: SQLite owns the autoincrement `id`,
 * while the backend identity belongs in `server_id`. The locally generated
 * `client_entry_id` is the idempotency key used to recover a queued legacy
 * upload. Mixing those namespaces, or replacing this 27-column row from a
 * partial server response, could overwrite an unrelated offline pedido and
 * destroy its idempotency key, child-item relationship, and unsynced state.
 *
 * Local creation therefore never writes either `id` or `server_id`, and uses
 * plain INSERT so SQLite creates a new row without REPLACE deletion semantics.
 */

/** Values captured for a new offline supply request. */
export interface LocalSupplyRequest {
  client_entry_id: string;
  project_id: number;
  operator_id: string;
  material: string;
  quantity: number;
  priority: string;
  reason: string | null;
  needed_by: string | null;
  job_site: string | null;
  pedido_type: string;
  notes: string | null;
  kind: string;
  justification: string | null;
  created_at: string;
  updated_at: string;
}

type SqlParameter = string | number | null;

/** A module-level execute function or a caller's transaction executor. */
export type SqlExecutor = (
  sql: string,
  params?: SqlParameter[],
) => Promise<QueryResult>;

/** Insert one offline pedido and return SQLite's generated local identity. */
export const insertSupplyRequest = async (
  request: LocalSupplyRequest,
  exec: SqlExecutor = execute,
): Promise<QueryResult> => exec(
  `INSERT INTO supply_requests (
             client_entry_id, project_id, operator_id, material, quantity, priority,
             reason, needed_by, job_site, pedido_type, notes, status, kind,
             justification, sync_status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pendiente', ?, ?, 'pending', ?, ?)`,
  [
    request.client_entry_id,
    request.project_id,
    request.operator_id,
    request.material,
    request.quantity,
    request.priority,
    request.reason,
    request.needed_by,
    request.job_site,
    request.pedido_type,
    request.notes,
    request.kind,
    request.justification,
    request.created_at,
    request.updated_at,
  ],
);
