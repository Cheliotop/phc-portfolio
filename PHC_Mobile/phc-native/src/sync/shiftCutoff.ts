import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus } from 'react-native';
import { query, runInTransaction } from '../db/db';
import { markShiftPendingReport } from '../db/repositories/shifts';
import { createClientEntryId } from '../utils/clientId';

/**
 * The 12-hour rule, applied by the sync side on app foreground and before every
 * drain. TurnosTab applies it too, but only when its screen loads, so an operator
 * who stays on Progreso past hour 12 kept saving bars the server then refused.
 *
 * Clocks: the trigger uses the device clock. `start_device_time` is the device's
 * own clock when the shift started, so a tablet whose clock is wrong still
 * measures the real elapsed time. The end time is the server's `started_at` plus
 * 12 hours, which is what the server's own rule and the VERIFY step compare
 * against. The server clock is not read here, so this does not depend on it.
 */
export const SHIFT_CUTOFF_MS = 12 * 60 * 60 * 1000;

export interface CutoffShift {
  id: string;
  project_id: number;
  operator_id: string;
  status: string;
  started_at: string;
  start_device_time?: string | null;
}

/** Milliseconds the shift has run, on the device clock. NaN when unknown. */
export const shiftElapsedMs = (shift: CutoffShift, now: number): number => {
  const started = Date.parse(shift.start_device_time ?? shift.started_at);
  return Number.isFinite(started) ? now - started : NaN;
};

export const isPastShiftCutoff = (shift: CutoffShift, now: number = Date.now()): boolean => {
  const elapsed = shiftElapsedMs(shift, now);
  return Number.isFinite(elapsed) && elapsed >= SHIFT_CUTOFF_MS;
};

/** The server's end time for a shift the 12-hour rule closes. */
const cutoffEndFor = (shift: CutoffShift): string => {
  const serverStart = Date.parse(shift.started_at);
  const base = Number.isFinite(serverStart)
    ? serverStart
    : Date.parse(shift.start_device_time ?? '');
  return new Date(base + SHIFT_CUTOFF_MS).toISOString();
};

/**
 * Moves every open shift past its 12-hour cutoff to `report_pending` and queues
 * the same VERIFY row TurnosTab queues, once per shift. Returns how many it
 * expired. Never throws for a single shift; the caller decides what to do with
 * an error from the query itself.
 */
export const expireOverdueShifts = async (now: number = Date.now()): Promise<number> => {
  const open = await query<CutoffShift>(
    `SELECT id, project_id, operator_id, status, started_at, start_device_time
     FROM shifts WHERE status = 'open'`,
  );
  const overdue = open.filter((shift) => isPastShiftCutoff(shift, now));
  if (!overdue.length) return 0;

  const authorId = (await AsyncStorage.getItem('userId')) || null;
  let expired = 0;
  for (const candidate of overdue) {
    const didExpire = await runInTransaction(async (transaction) => {
      // Re-read inside the write lock: TurnosTab or an earlier pass may have
      // already moved this shift on.
      const current = await transaction.queryFirst<CutoffShift>(
        `SELECT id, project_id, operator_id, status, started_at, start_device_time
         FROM shifts WHERE id = ?`,
        [candidate.id],
      );
      if (!current || current.status !== 'open' || !isPastShiftCutoff(current, now)) {
        return false;
      }

      const endedAt = cutoffEndFor(current);
      const stamp = new Date(now).toISOString();
      await markShiftPendingReport(current.id, endedAt, stamp, transaction.execute);
      await transaction.execute(
        `INSERT INTO sync_outbox (
           id, entity, entity_id, op, payload_json, author_id, retries, created_at, updated_at
         )
         SELECT ?, 'shift_auto_close', ?, 'VERIFY', ?, ?, 0, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM sync_outbox
           WHERE entity = 'shift_auto_close' AND entity_id = ?
         )`,
        [
          createClientEntryId('outbox'),
          current.id,
          JSON.stringify({
            shiftId: current.id,
            projectId: current.project_id,
            operatorId: current.operator_id,
            endedAt,
          }),
          authorId ?? current.operator_id,
          stamp,
          stamp,
          current.id,
        ],
      );
      return true;
    });
    if (didExpire) expired += 1;
  }
  return expired;
};

let foregroundWatchInstalled = false;

/**
 * Runs the cutoff each time the app comes to the foreground, so a tablet left
 * on a screen other than Turnos still closes the shift on time. Idempotent.
 */
export const installShiftCutoffWatch = (): void => {
  if (foregroundWatchInstalled) return;
  foregroundWatchInstalled = true;
  AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') {
      void expireOverdueShifts().catch(() => 0);
    }
  });
};
