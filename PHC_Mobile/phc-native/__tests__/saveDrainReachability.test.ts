/**
 * A save triggers a drain and waits for it. With Wi-Fi up but the site uplink
 * down, every request in that drain waits out its deadline, so the screen sat on
 * "Guardando…" for minutes (SYNC-9). Before a save-triggered drain, the server is
 * probed quickly; when it does not answer, the save returns at once and the record
 * stays queued on the phone.
 */
const mockPreWork = jest.fn();

jest.mock('../src/sync/productV2Sync', () => ({
  syncProductV2PreWork: (...args: any[]) => mockPreWork(...args),
  syncProductV2PostWork: jest.fn(async () => ({ synced: 0, failed: 0 })),
}));
jest.mock('../src/sync/drillingSync', () => ({
  syncPendingDrillingBars: jest.fn(async () => ({ synced: 0, failed: 0 })),
}));
jest.mock('../src/sync/offlineSync', () => ({
  syncAllPending: jest.fn(async () => ({ synced: 0, failed: 0 })),
}));
jest.mock('../src/sync/outboxOwner', () => ({
  outboxBelongsTo: jest.fn(async () => true),
}));
jest.mock('../src/sync/rejectedWorkReport', () => ({
  reportRejectedWork: jest.fn().mockResolvedValue(undefined),
}));
const mockExpire = jest.fn(async () => 0);
jest.mock('../src/sync/shiftCutoff', () => ({
  expireOverdueShifts: (...args: any[]) => mockExpire(...args),
}));
jest.mock('../src/utils/crashReport', () => ({
  flushCrashReports: jest.fn(async () => undefined),
}));
jest.mock('../src/lib/supabase', () => ({
  __esModule: true,
  default: {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'operator-1' } } } }) },
  },
}));

import { drainOutbox, drainOutboxIncludingNew, serverReachable } from '../src/sync/drainCoordinator';

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockPreWork.mockResolvedValue({ synced: 1, failed: 0 });
});

afterEach(() => {
  global.fetch = originalFetch;
});

it('does not start a drain when the server does not answer', async () => {
  global.fetch = jest.fn(async () => { throw new TypeError('Network request failed'); }) as any;

  await expect(drainOutboxIncludingNew()).resolves.toEqual({ synced: 0, failed: 0 });

  expect(mockPreWork).not.toHaveBeenCalled();
});

it('drains as before when the server answers, even with an error status', async () => {
  global.fetch = jest.fn(async () => new Response(null, { status: 404 })) as any;

  await expect(drainOutboxIncludingNew()).resolves.toEqual({ synced: 1, failed: 0 });

  expect(mockPreWork).toHaveBeenCalledTimes(1);
});

it('gives up on an unanswered server after a few seconds, not the full request deadline', async () => {
  global.fetch = jest.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('Aborted')));
  })) as any;

  const started = Date.now();
  expect(await serverReachable()).toBe(false);
  const elapsed = Date.now() - started;

  expect(elapsed).toBeGreaterThanOrEqual(2900);
  expect(elapsed).toBeLessThan(10000);
}, 15000);

it('runs the 12-hour cutoff before it reads the queue, so an overdue shift is verified in the same pass', async () => {
  const order: string[] = [];
  mockExpire.mockImplementation(async () => { order.push('cutoff'); return 1; });
  mockPreWork.mockImplementation(async () => { order.push('drain'); return { synced: 0, failed: 0 }; });

  await drainOutbox();

  expect(order).toEqual(['cutoff', 'drain']);
});
