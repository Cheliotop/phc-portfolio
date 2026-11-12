const mockExecute = jest.fn();
const mockQuery = jest.fn();

jest.mock('../src/db/db', () => ({
  execute: (...args: any[]) => mockExecute(...args),
  query: (...args: any[]) => mockQuery(...args),
}));

import {
  OUTBOX_FAST_ATTEMPTS,
  OUTBOX_SLOW_RETRY_MS,
  resetOutboxForManualRetry,
  selectDrainableOutboxRows,
} from '../src/db/operations';

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue([]);
  mockExecute.mockResolvedValue({ changes: 0 });
});

// A lost signal at a rig must never strand field work: after the fast attempts
// a row keeps being retried on a slow cadence instead of being abandoned until
// the operator happens to tap "Reintentar".
it('keeps retrying a transiently failing row after the fast attempts, on a cooldown', async () => {
  const before = Date.now();
  await selectDrainableOutboxRows('drilling_bar');

  const [sql, params] = mockQuery.mock.calls[0];
  expect(sql).toMatch(/retries < \? OR updated_at <= \?/);
  expect(sql).toMatch(/COALESCE\(state, 'pending'\) <> 'quarantined'/);
  expect(params[0]).toBe('drilling_bar');
  expect(params[1]).toBe(OUTBOX_FAST_ATTEMPTS);
  const cutoff = new Date(params[2]).getTime();
  expect(cutoff).toBeLessThanOrEqual(before - OUTBOX_SLOW_RETRY_MS + 1000);
  expect(cutoff).toBeGreaterThanOrEqual(before - OUTBOX_SLOW_RETRY_MS - 1000);
});

it('manual retry also re-sends rows the server rejected', async () => {
  await resetOutboxForManualRetry();

  const [sql, params] = mockExecute.mock.calls[0];
  expect(sql).toMatch(/SET retries = 0, state = 'pending'/);
  expect(sql).toMatch(/OR COALESCE\(state, 'pending'\) = 'quarantined'/);
  expect(params[1]).toBe(OUTBOX_FAST_ATTEMPTS);
});
