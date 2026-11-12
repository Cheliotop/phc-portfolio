const mockPreWork = jest.fn();
const mockDrillingBars = jest.fn();
const mockPostWork = jest.fn();
const mockAllPending = jest.fn();

jest.mock('../src/sync/productV2Sync', () => ({
  syncProductV2PreWork: (...args: any[]) => mockPreWork(...args),
  syncProductV2PostWork: (...args: any[]) => mockPostWork(...args),
}));
jest.mock('../src/sync/drillingSync', () => ({
  syncPendingDrillingBars: (...args: any[]) => mockDrillingBars(...args),
}));
jest.mock('../src/sync/offlineSync', () => ({
  syncAllPending: (...args: any[]) => mockAllPending(...args),
}));
const mockOutboxBelongsTo = jest.fn();
jest.mock('../src/sync/outboxOwner', () => ({
  outboxBelongsTo: (...args: any[]) => mockOutboxBelongsTo(...args),
}));
jest.mock('../src/sync/rejectedWorkReport', () => ({
  reportRejectedWork: async () => undefined,
}));
jest.mock('../src/sync/shiftCutoff', () => ({
  expireOverdueShifts: async () => 0,
}));
jest.mock('../src/lib/supabase', () => ({
  __esModule: true,
  default: {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'operator-1' } } } }) },
  },
}));

import { drainOutbox, drainOutboxIncludingNew, isDrainInFlight } from '../src/sync/drainCoordinator';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

const originalFetch = global.fetch;
const mockFetch = jest.fn();

beforeEach(() => {
  jest.resetAllMocks();
  global.fetch = mockFetch;
  mockFetch.mockResolvedValue({ status: 200 });
  mockOutboxBelongsTo.mockResolvedValue(true);
  for (const worker of [mockPreWork, mockDrillingBars, mockPostWork, mockAllPending]) {
    worker.mockResolvedValue({ synced: 0, failed: 0 });
  }
});

afterAll(() => { global.fetch = originalFetch; });

// A shared phone: queued work must upload only under the account that queued
// it, never under whoever happens to be signed in now.
it('leaves the queue untouched when the session does not own the outbox', async () => {
  mockOutboxBelongsTo.mockResolvedValue(false);

  await expect(drainOutbox()).resolves.toEqual({ synced: 0, failed: 0 });

  expect(mockOutboxBelongsTo).toHaveBeenCalledWith('operator-1');
  expect(mockPreWork).not.toHaveBeenCalled();
  expect(mockAllPending).not.toHaveBeenCalled();
});

it('MEDIUM-4: runs the drain phases only once when two drains overlap', async () => {
  // Hold the first phase open so the second drainOutbox() call arrives while
  // the first drain is still in flight (the double-reconnect + manual-retry
  // race the fix is meant to prevent).
  const gate = deferred<{ synced: number; failed: number }>();
  mockPreWork.mockReturnValue(gate.promise);
  mockDrillingBars.mockResolvedValue({ synced: 0, failed: 0 });
  mockPostWork.mockResolvedValue({ synced: 1, failed: 0 });
  mockAllPending.mockResolvedValue({ synced: 0, failed: 0 });

  const first = drainOutbox();
  const second = drainOutbox();

  // The second caller must AWAIT the same in-flight run, not start a new one.
  expect(second).toBe(first);
  expect(isDrainInFlight()).toBe(true);

  gate.resolve({ synced: 0, failed: 0 });
  const [r1, r2] = await Promise.all([first, second]);

  // Every phase worker ran exactly once despite two concurrent callers.
  expect(mockPreWork).toHaveBeenCalledTimes(1);
  expect(mockDrillingBars).toHaveBeenCalledTimes(1);
  expect(mockPostWork).toHaveBeenCalledTimes(1);
  expect(mockAllPending).toHaveBeenCalledTimes(1);
  expect(r1).toEqual(r2);
  expect(r1).toEqual({ synced: 1, failed: 0 });
  // Lock released once settled, so a later drain can run again.
  expect(isDrainInFlight()).toBe(false);
});

it('MEDIUM-4: allows a fresh drain after the previous one settled', async () => {
  mockPreWork.mockResolvedValue({ synced: 0, failed: 0 });
  mockDrillingBars.mockResolvedValue({ synced: 0, failed: 0 });
  mockPostWork.mockResolvedValue({ synced: 0, failed: 0 });
  mockAllPending.mockResolvedValue({ synced: 0, failed: 0 });

  await drainOutbox();
  await drainOutbox();

  expect(mockPreWork).toHaveBeenCalledTimes(2);
});

// Code read S5: a record saved while a drain is running was read by nobody, so the
// operator was told "waiting" with good signal. The save's own drain now waits
// for the running one and then runs again.
it('runs a fresh drain after the running one, for work saved meanwhile', async () => {
  const gate = deferred<{ synced: number; failed: number }>();
  mockPreWork.mockReturnValueOnce(gate.promise).mockResolvedValue({ synced: 0, failed: 0 });
  mockDrillingBars.mockResolvedValue({ synced: 0, failed: 0 });
  mockPostWork.mockResolvedValue({ synced: 1, failed: 0 });
  mockAllPending.mockResolvedValue({ synced: 0, failed: 0 });

  const background = drainOutbox();
  await Promise.resolve();
  const fresh = drainOutboxIncludingNew();
  gate.resolve({ synced: 0, failed: 0 });
  await background;
  await expect(fresh).resolves.toEqual({ synced: 1, failed: 0 });

  expect(mockPreWork).toHaveBeenCalledTimes(2);
  expect(isDrainInFlight()).toBe(false);
});

it('leaves newly saved work queued when the server is unreachable', async () => {
  mockFetch.mockRejectedValue(new TypeError('Network request failed'));

  await expect(drainOutboxIncludingNew()).resolves.toEqual({ synced: 0, failed: 0 });

  expect(mockPreWork).not.toHaveBeenCalled();
  expect(isDrainInFlight()).toBe(false);
  // A later reconnect must still be able to drain that work.
  mockFetch.mockResolvedValue({ status: 200 });
  mockDrillingBars.mockResolvedValue({ synced: 1, failed: 0 });
  await expect(drainOutboxIncludingNew()).resolves.toEqual({ synced: 1, failed: 0 });
});

it('bounds a save-triggered reachability check when the uplink hangs', async () => {
  jest.useFakeTimers();
  try {
    mockFetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Aborted')));
    }));
    const result = drainOutboxIncludingNew();
    await jest.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toEqual({ synced: 0, failed: 0 });
    expect(mockPreWork).not.toHaveBeenCalled();
    expect(isDrainInFlight()).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});
