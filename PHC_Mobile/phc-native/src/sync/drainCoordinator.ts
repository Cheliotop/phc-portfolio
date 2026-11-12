import { syncAllPending } from './offlineSync';
import { syncPendingDrillingBars } from './drillingSync';
import { syncProductV2PreWork, syncProductV2PostWork } from './productV2Sync';
import supabase from '../lib/supabase';
import { outboxBelongsTo } from './outboxOwner';
import { reportRejectedWork } from './rejectedWorkReport';
import { notifyQueueChanged } from '../events/queueEvents';
import { SUPABASE_URL } from '../api/config';
import { expireOverdueShifts } from './shiftCutoff';

export interface DrainResult {
  synced: number;
  failed: number;
}

// Module-level in-flight guard for the full outbox drain sequence.
//
// Several places can trigger a drain: OperatorDashboard's 30s interval and its
// NetInfo reconnect listener, plus the SyncStatusIndicator "Reintentar" button.
// A double reconnect combined with a manual retry could otherwise run TWO full
// drains over the same sync_outbox rows at once — two passes reading the same
// retries<3 row, both hitting the API, both racing to delete/update the local
// row. The RPCs are idempotent per client_entry_id (the server suppresses
// duplicate submissions), but the local double-processing is still a
// correctness hazard worth preventing at the source.
//
// While a drain is in flight, additional callers AWAIT the same run rather than
// starting a second one. The guard lives at module scope (not per component),
// so it holds across every component that imports drainOutbox.
let inFlight: Promise<DrainResult> | null = null;

/**
 * How long a save waits to learn whether the server answers at all. Short on
 * purpose: this decides whether a save-triggered drain is worth starting.
 */
const REACHABILITY_TIMEOUT_MS = 3_000;

/**
 * Whether the server answers within a few seconds. Wi-Fi can be up while the
 * site uplink is down, and then the OS reports "connected", so every request
 * waits out its full deadline. Any HTTP answer, even an error status, counts as
 * reachable. Uses the plain fetch on purpose: the client's own fetch has its own
 * 15-second deadline and an offline short-circuit that this check must not depend on.
 */
export const serverReachable = async (): Promise<boolean> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
  try {
    await fetch(SUPABASE_URL, { method: 'HEAD', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const runDrainSequence = async (): Promise<DrainResult> => {
  // Refresh the auth session before touching the network. After a long offline
  // window the short-lived access token may have expired; getSession() refreshes
  // it (autoRefreshToken) so the drain's first RPC doesn't 401 on reconnect. If
  // the refresh token itself is dead (rare, e.g. very long inactivity), the drain
  // simply fails with a now-readable auth message and the queued work waits
  // until the operator logs in again — nothing is lost.
  const session = await supabase.auth.getSession().then(({ data }) => data.session).catch(() => null);

  // Queued work is uploaded only under the account that queued it; see
  // outboxOwner.ts. Another account's session leaves the queue untouched.
  if (!(await outboxBelongsTo(session?.user?.id))) {
    return { synced: 0, failed: 0 };
  }

  // The 12-hour rule runs here as well as on app foreground, so a shift that
  // crossed its cutoff is queued for verification before this pass reads the queue.
  await expireOverdueShifts().catch(() => 0);

  // Dependency order matters: a shift must exist remotely before its bars, and
  // bars must sync before the atomic shift-close package; reports / pedidos /
  // water samples drain last.
  const phases = [
    await syncProductV2PreWork().catch(() => ({ synced: 0, failed: 1 })),
    await syncPendingDrillingBars().catch(() => ({ synced: 0, failed: 1 })),
    await syncProductV2PostWork().catch(() => ({ synced: 0, failed: 1 })),
    await syncAllPending().catch(() => ({ synced: 0, failed: 1 })),
  ];
  // Last, so anything refused during this drain reaches the admin review list
  // straight away. A failure here only delays the report to the next drain.
  await reportRejectedWork().catch(() => undefined);

  return phases.reduce<DrainResult>(
    (total, phase) => ({ synced: total.synced + phase.synced, failed: total.failed + phase.failed }),
    { synced: 0, failed: 0 },
  );
};

/**
 * Run the full outbox drain sequence, guarded by a module-level in-flight lock
 * so it can never run concurrently with itself. Concurrent callers receive the
 * same in-flight promise instead of kicking off a second drain.
 */
export const drainOutbox = (): Promise<DrainResult> => {
  if (inFlight) {
    return inFlight;
  }
  inFlight = runDrainSequence().finally(() => {
    inFlight = null;
    notifyQueueChanged();
  });
  return inFlight;
};

/**
 * A drain that includes work saved just now. A drain already running read the
 * queue before that work existed, so joining it would leave the new record for
 * the next one and tell the operator "waiting" with good signal. Waits for the
 * running drain, then starts (or joins) a fresh one under the same lock.
 */
export const drainOutboxIncludingNew = async (): Promise<DrainResult> => {
  // With the server unreachable, a drain would only wait out every request's
  // deadline before failing. The record is already saved on the phone and stays
  // queued; the next drain (the 30-second loop or a reconnect) sends it.
  if (!(await serverReachable())) {
    return { synced: 0, failed: 0 };
  }
  if (inFlight) {
    await inFlight.catch(() => undefined);
  }
  return drainOutbox();
};

/** Diagnostic/test helper: whether a drain is currently running. */
export const isDrainInFlight = (): boolean => inFlight !== null;
