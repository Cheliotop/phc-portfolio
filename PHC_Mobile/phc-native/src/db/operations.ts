import AsyncStorage from '@react-native-async-storage/async-storage';
import { execute, query, queryFirst, runInTransaction, type QueryResult } from '../db/db';
import { projectMembershipSql } from './projectMembership';

const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
const now = () => new Date().toISOString();

export interface DomainWriteStatement {
  sql: string;
  params?: any[];
}

export interface OutboxWriteEntry {
  entity: string;
  entity_id: string;
  op: string;
  payload_json: unknown;
  author_id?: string | null;
}

export interface DomainWriteWithOutboxResult {
  domainResult: QueryResult;
  outboxId: string;
}

/**
 * Persist one offline domain row and its sync intent atomically.
 *
 * This is the primitive new offline workflows should use instead of calling a
 * domain INSERT and queueOutbox separately. If either statement fails, Expo
 * SQLite rolls both back, preventing orphaned local rows or outbox entries.
 */
export async function writeDomainRowWithOutbox(
  domainWrite: DomainWriteStatement,
  outboxEntry: OutboxWriteEntry,
): Promise<DomainWriteWithOutboxResult> {
  const outboxId = generateId();
  const timestamp = now();

  return runInTransaction(async (transaction) => {
    const domainResult = await transaction.execute(domainWrite.sql, domainWrite.params ?? []);

    await transaction.execute(
      `INSERT INTO sync_outbox (id, entity, entity_id, op, payload_json, author_id, retries, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        outboxId,
        outboxEntry.entity,
        outboxEntry.entity_id,
        outboxEntry.op,
        JSON.stringify(outboxEntry.payload_json ?? null),
        outboxEntry.author_id ?? null,
        timestamp,
        timestamp,
      ],
    );

    return { domainResult, outboxId };
  });
}

/**
 * Drop a queue row. `sent` (the default) means the server took the work. If the
 * row had been refused and reported to the admin review list before a manual
 * retry got it through, its archived copy is stamped so the review list is told
 * and the admin doesn't enter it again by hand (code read S8). Pass
 * `{ sent: false }` when the row is dropped for another reason.
 */
export async function deleteOutbox(id: string, opts: { sent?: boolean } = {}) {
  if (opts.sent !== false) {
    await execute('UPDATE rejected_work SET sent_at = ? WHERE id = ? AND sent_at IS NULL', [now(), id]);
  }
  await execute('DELETE FROM sync_outbox WHERE id = ?', [id]);
}

export async function markOutboxFailed(id: string, error: string) {
  await execute(
    `UPDATE sync_outbox
     SET retries = retries + 1, last_error = ?, updated_at = ?
     WHERE id = ?`,
    [error, now(), id],
  );
}

/**
 * Terminal state for a write the server permanently rejected.
 *
 * The row is KEPT, not deleted: it is the only remaining record of what the
 * operator tried to do and why it was refused, and PozosTab surfaces it for
 * review. Retries is also pushed to the abandon threshold so any drain query
 * that filters on retries alone still refuses to pick this row up.
 */
export async function quarantineOutbox(id: string, error: string) {
  await execute(
    `UPDATE sync_outbox
     SET state = 'quarantined', retries = MAX(retries, 3), last_error = ?, updated_at = ?
     WHERE id = ?`,
    [error, now(), id],
  );
}

/** Attempts made back to back before a row falls back to the slow cadence. */
export const OUTBOX_FAST_ATTEMPTS = 3;
/** After the fast attempts, a transiently failing row is retried this often. */
export const OUTBOX_SLOW_RETRY_MS = 15 * 60 * 1000;

export interface DrainableOutboxRow {
  id: string;
  entity: string;
  entity_id: string;
  op: string;
  payload_json: string;
  retries: number;
  author_id: string | null;
}

/**
 * Rows of one entity the sync workers should attempt now, oldest first.
 *
 * A transient failure (no signal, timeout, 5xx) must never strand field work:
 * once the fast attempts are spent the row keeps retrying on a slow cadence
 * instead of waiting for the operator to notice and tap "Reintentar".
 * markOutboxFailed stamps updated_at, which is the cooldown's clock. Rows the
 * server permanently rejected stay out until a manual retry.
 */
export async function selectDrainableOutboxRows(entity: string, limit = 25) {
  const cooledDownBefore = new Date(Date.now() - OUTBOX_SLOW_RETRY_MS).toISOString();
  const operatorId = await AsyncStorage.getItem('operatorId');
  // With a signed-in operator, rows of wells they are not on are skipped below,
  // so the LIMIT is applied after that filter instead of stealing its slots.
  const rows = await query<DrainableOutboxRow>(
    `SELECT id, entity, entity_id, op, payload_json, retries, author_id
     FROM sync_outbox
     WHERE entity = ?
       AND COALESCE(state, 'pending') <> 'quarantined'
       AND (retries < ? OR updated_at <= ?)
     ORDER BY created_at ASC, rowid ASC
     ${operatorId ? '' : 'LIMIT ?'}`,
    operatorId
      ? [entity, OUTBOX_FAST_ATTEMPTS, cooledDownBefore]
      : [entity, OUTBOX_FAST_ATTEMPTS, cooledDownBefore, limit],
  );
  if (!operatorId) return rows;

  const visible: DrainableOutboxRow[] = [];
  for (const row of rows) {
    let projectId: string | number | null = null;
    try {
      const payload = JSON.parse(row.payload_json);
      projectId = payload?.projectId ?? payload?.project_id ?? null;
    } catch { /* malformed payload remains drainable and gets its normal error */ }
    if (projectId == null) {
      const source: Record<string, [string, string]> = {
        drilling_bar: ['drilling_bar_entries', 'id'], water_sample: ['water_samples', 'id'],
        shift_start: ['shifts', 'id'], shift_handover: ['shifts', 'id'],
        shift_auto_close: ['shifts', 'id'], shift_end: ['shifts', 'id'], shift_join: ['shifts', 'id'],
        material_consumption: ['material_consumption', 'client_entry_id'],
        pedido_v2: ['supply_requests', 'id'], pedido: ['supply_requests', 'client_entry_id'],
        completion_v2: ['completion_reports_local', 'id'],
        completion_v2_resubmit: ['completion_reports_local', 'id'],
        completion_report: ['completion_reports_local', 'id'],
      };
      const table = source[entity];
      if (entity === 'pedido_receipt') {
        const found = await queryFirst<{ project_id?: number }>(
          `SELECT sr.project_id FROM pedido_receipts r JOIN pedido_items i ON i.id = r.pedido_item_id JOIN supply_requests sr ON sr.id = i.pedido_id WHERE r.id = ?`,
          [row.entity_id],
        );
        projectId = found?.project_id ?? null;
      } else if (table) {
        const found = await queryFirst<{ project_id?: number }>(
          `SELECT project_id FROM ${table[0]} WHERE ${table[1]} = ? LIMIT 1`, [row.entity_id],
        );
        projectId = found?.project_id ?? null;
      }
    }
    if (projectId == null) { visible.push(row); continue; }
    const crew = await queryFirst<{ found: number }>(
      `SELECT 1 AS found FROM projects p WHERE p.id = ? AND ${projectMembershipSql('p')} LIMIT 1`,
      [projectId, operatorId, operatorId],
    );
    if (crew) visible.push(row);
    if (visible.length >= limit) break;
  }
  return visible;
}

/**
 * Operator-initiated "Reintentar": give every stuck row, including ones the
 * server rejected, a fresh set of attempts. A rejection can stop being one
 * after a server-side fix, and a row still refused simply quarantines again.
 */
export async function resetOutboxForManualRetry() {
  await execute(
    `UPDATE sync_outbox SET retries = 0, state = 'pending', updated_at = ?
     WHERE retries >= ? OR COALESCE(state, 'pending') = 'quarantined'`,
    [now(), OUTBOX_FAST_ATTEMPTS],
  );
}
