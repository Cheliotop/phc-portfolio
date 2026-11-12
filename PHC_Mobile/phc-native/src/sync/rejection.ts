import { markOutboxFailed, quarantineOutbox } from '../db/operations';
import { hasUsableSession } from './sessionValidity';

/**
 * Tell a permanent server rejection apart from a transient failure.
 *
 * The outbox retries three times and then abandons the row forever. For a
 * business-rule rejection — "A handover item is not an active material in this
 * project (22023)" — those three attempts are pure waste: the answer will never
 * change. For a lost signal on a drilling site they are the entire point.
 *
 * Bias deliberately toward TRANSIENT when the error shape is unrecognisable. A
 * wrongly retried row costs three requests. A wrongly quarantined row strands
 * an operator's work behind a manual review it never needed.
 */

// SQLSTATE classes that mean "the server understood you and said no".
// https://www.postgresql.org/docs/current/errcodes-appendix.html
const PERMANENT_SQLSTATE_CLASSES = [
  '22', // data exception — where our business-rule raises live since the
  //       ERRCODE-55000/PostgREST-accents migration (2026-07-24)
  '23', // integrity constraint violation
  '42', // syntax error or access rule violation (includes RLS denials)
];

const PERMANENT_SQLSTATES = [
  '55000', // object not in prerequisite state — 40 live raises still use it
  '21000', // cardinality violation
  'P0001', // plpgsql RAISE EXCEPTION default
  'P0002', // no_data_found
];

// Codes inside an otherwise-permanent class that are actually worth retrying.
// Checked before the class prefixes above.
const TRANSIENT_SQLSTATE_CLASSES = [
  '08', // connection exception
  '40', // transaction rollback: serialization failure, deadlock
  '53', // insufficient resources
  '57', // operator intervention (admin shutdown, query cancelled)
  '58', // system error
];

// 4xx statuses that are retryable despite being client-class.
const TRANSIENT_HTTP_STATUSES = [408, 425, 429];

const asStatusNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  return null;
};

const startsWithAny = (value: string, prefixes: string[]) =>
  prefixes.some((prefix) => value.startsWith(prefix));

/**
 * True when retrying this error can never change the outcome.
 */
export const isPermanentRejection = (error: unknown): boolean => {
  if (error == null || typeof error !== 'object') return false;

  const obj = error as Record<string, unknown>;
  const code = typeof obj.code === 'string' ? obj.code.trim() : '';

  if (code) {
    // PostgREST/GoTrue infrastructure codes (PGRST301 expired JWT, PGRST002
    // schema cache not loaded) resolve on their own once auth refreshes or the
    // cache reloads. Never quarantine those.
    if (code.toUpperCase().startsWith('PGRST')) return false;
    if (startsWithAny(code, TRANSIENT_SQLSTATE_CLASSES)) return false;
    if (PERMANENT_SQLSTATES.includes(code)) return true;
    if (startsWithAny(code, PERMANENT_SQLSTATE_CLASSES)) return true;
  }

  // Supabase Storage and Functions errors carry an HTTP status instead of a
  // SQLSTATE. "Bucket not found" (W-13) arrives this way — a configuration
  // error that no amount of waiting fixes.
  const status = asStatusNumber(obj.status) ?? asStatusNumber(obj.statusCode);
  if (status !== null) {
    if (TRANSIENT_HTTP_STATUSES.includes(status)) return false;
    // 401/403 included on purpose: the operator's session cannot be repaired by
    // the outbox, and silently retrying hides a real permissions problem.
    if (status >= 400 && status < 500) return true;
  }

  return false;
};

/**
 * Single policy for "this sync attempt failed": burn a retry, or quarantine.
 *
 * Callers keep owning the entity-specific part — reverting an optimistic flag,
 * writing last_error onto the local row — because only they know which columns
 * were the operator's data and which were an unverified claim.
 *
 * Local rows stay on sync_status = 'failed' either way, deliberately. Adding a
 * third value would have to be taught to every consumer, and WaterSamplesTab
 * maps anything it does not recognise back to 'pending' — which would reinstate
 * the "se sincronizará cuando haya conexión" lie that W-11(a) removed.
 */
/**
 * A refusal that also comes back when the request went out without a valid session:
 * an RLS denial, or Storage's 401/403. When the token had expired, or a failed
 * refresh left supabase-js sending the anon key, the refusal says nothing about the
 * work itself (code read S2, S3).
 */
const isAuthRefusal = (error: unknown): boolean => {
  if (error == null || typeof error !== 'object') return false;
  const obj = error as Record<string, unknown>;
  const code = typeof obj.code === 'string' ? obj.code.trim() : '';
  const status = asStatusNumber(obj.status) ?? asStatusNumber(obj.statusCode);
  return code === '42501' || status === 401 || status === 403;
};

export const recordSyncFailure = async (
  outboxId: string,
  error: unknown,
  message: string,
): Promise<'quarantined' | 'retryable'> => {
  if (isPermanentRejection(error) && !(isAuthRefusal(error) && !(await hasUsableSession()))) {
    await quarantineOutbox(outboxId, message);
    return 'quarantined';
  }
  await markOutboxFailed(outboxId, message);
  return 'retryable';
};
