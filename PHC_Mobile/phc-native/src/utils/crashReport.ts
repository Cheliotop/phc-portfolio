/**
 * Crash reporting.
 *
 * The app had none. On 2026-07-31 a `String.replaceAll` call took the entire
 * Operación tab down to the error boundary on every real device — it passed
 * TypeScript, passed 272 tests, produced a correctly signed release, and was
 * found only because a person happened to open that tab. After handoff there is
 * no such person, and an operator at a well has no way to tell anyone beyond a
 * telephone call.
 *
 * Reports go to `public.client_errors` in the project's own Supabase rather than
 * a third-party service: no extra account or bill for the client, no new native
 * module days before delivery, and the same offline behaviour the app already
 * relies on for field data.
 *
 * ## The rule that matters
 *
 * **Nothing in this file may throw.** It runs inside `componentDidCatch`, which
 * is already the failure path. An exception raised while reporting a crash
 * would replace a recoverable screen with an unrecoverable one, and would do it
 * only on devices that were already having a bad time. Every operation is
 * wrapped, and every failure degrades to "keep it on the device".
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import supabase from '../lib/supabase';
import { subscribeToQueueChanges } from '../events/queueEvents';
import { createClientEntryId } from './clientId';

const QUEUE_KEY = 'phc.crashQueue';
/** Keeps a broken build from filling storage with thousands of identical rows. */
const MAX_QUEUED = 50;

export interface CrashReport {
  client_entry_id: string;
  occurred_at: string;
  profile_id: string | null;
  actor_role: string | null;
  app_version: string;
  build_number: string | null;
  platform: string;
  os_version: string | null;
  screen: string | null;
  message: string;
  stack: string | null;
  component_stack: string | null;
  is_fatal: boolean;
}

/**
 * Read from the binary rather than `process.env`.
 *
 * Expo's Gradle release bundler replaced the two shell-injected
 * `EXPO_PUBLIC_*` values with `undefined` in v2.0.40, so every crash would have
 * been attributed to `dev` with no build number. `expoConfig.version` is the
 * version embedded from app.json, and Android's native manifest supplies the
 * actual versionCode. The release gate requires app.json and Gradle's release
 * variables to agree before a build can start.
 */
const APP_VERSION = Constants.expoConfig?.version ?? 'dev';
const nativeVersionCode = Constants.platform?.android?.versionCode;
const BUILD_NUMBER = nativeVersionCode == null ? null : String(nativeVersionCode);

/** Long stacks are useful; unbounded ones are a storage leak on a loop crash. */
const clip = (value: string | null | undefined, max: number): string | null => {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max)}\n…[truncado]` : value;
};

/**
 * First named component in the React stack — "in OperacionTab" tells an admin
 * where to look far faster than a minified frame does.
 */
const screenFrom = (componentStack?: string | null): string | null => {
  if (!componentStack) return null;
  for (const line of componentStack.split('\n')) {
    const match = line.match(/in ([A-Z][A-Za-z0-9_]+)/);
    if (match && match[1] !== 'Unknown') return match[1];
  }
  return null;
};

async function readQueue(): Promise<CrashReport[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeQueue(reports: CrashReport[]): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(reports.slice(-MAX_QUEUED)));
  } catch {
    // Storage full or unavailable. Losing a crash report is regrettable;
    // throwing from here would be worse.
  }
}

/**
 * Record a crash. Queues first, then tries to send — so a report survives the
 * app being killed immediately afterwards, which is the common case.
 */
export async function reportCrash(
  error: Error,
  componentStack?: string | null,
  isFatal = true,
): Promise<void> {
  try {
    const [profileId, actorRole] = await Promise.all([
      AsyncStorage.getItem('userId').catch(() => null),
      AsyncStorage.getItem('userRole').catch(() => null),
    ]);

    const report: CrashReport = {
      client_entry_id: createClientEntryId('crash'),
      occurred_at: new Date().toISOString(),
      profile_id: profileId || null,
      actor_role: actorRole || null,
      app_version: APP_VERSION,
      build_number: BUILD_NUMBER,
      platform: Platform.OS,
      os_version: String(Platform.Version ?? ''),
      screen: screenFrom(componentStack),
      message: clip(error?.message || String(error), 1000) ?? 'Error sin mensaje',
      stack: clip(error?.stack, 8000),
      component_stack: clip(componentStack, 4000),
      is_fatal: isFatal,
    };

    const queue = await readQueue();
    await writeQueue([...queue, report]);
    await flushCrashReports();
  } catch {
    // Reporting must never make the original failure worse.
  }
}

/**
 * Send anything queued. Safe to call on a schedule or after sign-in; a report
 * raised before the user authenticated cannot be inserted until there is a
 * session, because the table is closed to `anon` on purpose.
 */
export async function flushCrashReports(): Promise<void> {
  try {
    const queue = await readQueue();
    if (!queue.length) return;

    const { data } = await supabase.auth.getSession();
    if (!data.session) return;

    // Attributing a report to a different account than the one that hit it
    // would be worse than not sending it, and RLS would reject it anyway.
    const uid = data.session.user.id;
    const sendable = queue.map((report) => (
      report.profile_id && report.profile_id !== uid
        ? { ...report, profile_id: null }
        : report
    ));

    const { error } = await supabase
      .from('client_errors')
      .upsert(sendable, { onConflict: 'client_entry_id', ignoreDuplicates: true });

    // Only clear on a confirmed write. Anything else — offline, RLS, a bad row —
    // leaves the queue intact to try again. Remove just the reports sent: one
    // queued while the upsert was in flight must stay for the next flush.
    if (!error) {
      const sent = new Set(queue.map((report) => report.client_entry_id));
      const latest = await readQueue();
      await writeQueue(latest.filter((report) => !sent.has(report.client_entry_id)));
    }
  } catch {
    // Offline, or the session expired mid-send. The queue is untouched.
  }
}

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(typeof value === 'string' ? value : String(value));

let handlersInstalled = false;

/**
 * Catches what the error boundary cannot: errors thrown in event handlers,
 * async work (saves, sync, login) and unhandled promise rejections. Also
 * sends anything still queued at startup and whenever the network comes back,
 * so a report waits for signal instead of waiting for the next crash.
 *
 * Call once from the app entry. Idempotent. Never throws.
 */
export function installCrashReporting(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  try {
    const errorUtils = (globalThis as { ErrorUtils?: {
      setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
      getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
    } }).ErrorUtils;
    if (errorUtils?.setGlobalHandler) {
      const previous = errorUtils.getGlobalHandler?.();
      errorUtils.setGlobalHandler((error, isFatal) => {
        void reportCrash(asError(error), null, Boolean(isFatal));
        // Keep the default behaviour (red box in dev, normal crash in release).
        previous?.(error, isFatal);
      });
    }
  } catch {
    // Without the global handler the error boundary still reports render errors.
  }

  try {
    // Hermes tracks promise rejections natively; this is the supported hook.
    // Without it (other engines, tests) unhandled rejections go unreported,
    // which is no worse than before.
    const hermes = (globalThis as { HermesInternal?: {
      enablePromiseRejectionTracker?: (options: {
        allRejections: boolean;
        onUnhandled: (id: number, error: unknown) => void;
        onHandled: (id: number) => void;
      }) => void;
    } }).HermesInternal;
    hermes?.enablePromiseRejectionTracker?.({
      allRejections: true,
      onUnhandled: (_id, error) => {
        void reportCrash(asError(error), null, false);
      },
      onHandled: () => undefined,
    });
  } catch {
    // Reporting must never break startup.
  }

  try {
    NetInfo.addEventListener((state) => {
      if (state.isConnected === true) void flushCrashReports();
    });
  } catch {
    // No connectivity events: reports still go out at the next drain.
  }

  // Every drain ends with a queue-change notification, so this sends queued
  // reports whenever the phone has just finished talking to the server.
  subscribeToQueueChanges(() => {
    void flushCrashReports();
  });

  void flushCrashReports();
}
