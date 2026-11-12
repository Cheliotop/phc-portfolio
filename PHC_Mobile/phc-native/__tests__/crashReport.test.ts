/**
 * Crash reporting rules.
 *
 * This code runs inside `componentDidCatch`, which is already the failure path.
 * The property that matters more than any feature is that it cannot make things
 * worse: an exception raised while reporting a crash would turn a recoverable
 * screen into an unrecoverable one, and only on devices already in trouble.
 *
 * The second property is that a report is never lost quietly. It is queued
 * before any send is attempted, and the queue is cleared only on a confirmed
 * write — so being offline at a well, which is the normal case, costs nothing.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: { version: '2.0.41' },
    platform: { android: { versionCode: 43 } },
  },
}));

const mockUpsert = jest.fn();
const mockGetSession = jest.fn();

jest.mock('../src/lib/supabase', () => ({
  __esModule: true,
  default: {
    auth: { getSession: (...a: unknown[]) => mockGetSession(...a) },
    from: () => ({ upsert: (...a: unknown[]) => mockUpsert(...a) }),
  },
}));

import { flushCrashReports, reportCrash } from '../src/utils/crashReport';

const QUEUE_KEY = 'phc.crashQueue';
const readQueue = async () => JSON.parse((await AsyncStorage.getItem(QUEUE_KEY)) ?? '[]');

describe('crash reporting', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    mockGetSession.mockResolvedValue({ data: { session: null } });
    mockUpsert.mockResolvedValue({ error: null });
  });

  it('queues a crash with enough context to act on', async () => {
    await AsyncStorage.multiSet([['userId', 'op-1'], ['userRole', 'operator']]);

    await reportCrash(new Error('e.replaceAll is not a function'), '\n    in OperacionTab\n    in RCTView');

    const [report] = await readQueue();
    expect(report.message).toBe('e.replaceAll is not a function');
    expect(report.profile_id).toBe('op-1');
    expect(report.actor_role).toBe('operator');
    expect(report.is_fatal).toBe(true);
    expect(report.app_version).toBe('2.0.41');
    expect(report.build_number).toBe('43');
    expect(report.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('names the screen so an admin knows where to look', async () => {
    // A minified stack frame says nothing; "OperacionTab" says everything.
    await reportCrash(new Error('boom'), '\n    in Unknown\n    in CatalogoTab\n    in RCTView');

    const [report] = await readQueue();
    expect(report.screen).toBe('CatalogoTab');
  });

  it('never throws, even when storage is broken', async () => {
    // AsyncStorage is already a jest mock here, so spyOn/mockRestore does not
    // reliably put the original back — swap the implementation and restore it
    // by hand, or every later test inherits a rejecting store.
    const original = AsyncStorage.getItem;
    (AsyncStorage as { getItem: unknown }).getItem = jest.fn().mockRejectedValue(new Error('storage gone'));
    try {
      await expect(reportCrash(new Error('boom'), null)).resolves.toBeUndefined();
    } finally {
      (AsyncStorage as { getItem: unknown }).getItem = original;
    }
  });

  it('never throws when the error itself is malformed', async () => {
    // componentDidCatch does not guarantee a real Error instance.
    await expect(reportCrash(undefined as never, undefined)).resolves.toBeUndefined();
    const queued = await readQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0].message).toBeTruthy();
  });

  it('keeps the report when there is no session to send it under', async () => {
    // A crash on the login screen, or offline before first sign-in. The table
    // is closed to anon on purpose, so this waits rather than being dropped.
    await reportCrash(new Error('boom'), null);
    await flushCrashReports();

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(await readQueue()).toHaveLength(1);
  });

  it('sends and clears once a session exists', async () => {
    mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'op-1' } } } });
    await AsyncStorage.setItem('userId', 'op-1');

    await reportCrash(new Error('boom'), null);

    expect(mockUpsert).toHaveBeenCalled();
    expect(await readQueue()).toHaveLength(0);
  });

  it('keeps a report queued while the send was in flight', async () => {
    // Queued with no session, so it waits for the flush below.
    await reportCrash(new Error('first'), null);
    // Only that flush has a session; the second crash's own flush does not.
    mockGetSession.mockResolvedValueOnce({ data: { session: { user: { id: 'op-1' } } } });
    mockUpsert.mockImplementationOnce(async () => {
      // A second crash lands while the first one is on its way to the server.
      await reportCrash(new Error('second'), null);
      return { error: null };
    });

    await flushCrashReports();

    expect((await readQueue()).map((r: { message: string }) => r.message)).toEqual(['second']);
  });

  it('keeps the queue when the write fails', async () => {
    // Offline, RLS refusal, or a bad row. Clearing here would lose the only
    // record that the crash happened at all.
    mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'op-1' } } } });
    mockUpsert.mockResolvedValue({ error: { message: 'network' } });

    await reportCrash(new Error('boom'), null);

    expect(await readQueue()).toHaveLength(1);
  });

  it('does not attribute a report to whoever happens to be signed in now', async () => {
    // The crash was hit by one operator; a different one signed in before the
    // queue drained. RLS would reject it, and a wrong attribution is worse than
    // an anonymous one.
    await AsyncStorage.setItem('userId', 'op-1');
    await reportCrash(new Error('boom'), null);

    mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'op-2' } } } });
    await flushCrashReports();

    expect(mockUpsert.mock.calls[mockUpsert.mock.calls.length - 1][0][0].profile_id).toBeNull();
  });

  it('caps the queue so a crash loop cannot fill storage', async () => {
    for (let i = 0; i < 60; i += 1) {
      await reportCrash(new Error(`boom ${i}`), null);
    }
    expect((await readQueue()).length).toBeLessThanOrEqual(50);
  });
});
