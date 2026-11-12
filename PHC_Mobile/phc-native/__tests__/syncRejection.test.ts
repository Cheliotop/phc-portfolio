const mockMarkOutboxFailed = jest.fn();
const mockQuarantineOutbox = jest.fn();

let mockSessionUsable = true;
jest.mock('../src/sync/sessionValidity', () => ({ hasUsableSession: async () => mockSessionUsable }));

jest.mock('../src/db/operations', () => ({
  markOutboxFailed: (...args: any[]) => mockMarkOutboxFailed(...args),
  quarantineOutbox: (...args: any[]) => mockQuarantineOutbox(...args),
}));

import { isPermanentRejection, recordSyncFailure } from '../src/sync/rejection';

beforeEach(() => {
  jest.clearAllMocks();
  mockSessionUsable = true;
  mockMarkOutboxFailed.mockResolvedValue(undefined);
  mockQuarantineOutbox.mockResolvedValue(undefined);
});

describe('isPermanentRejection', () => {
  // Supabase RPC errors are plain objects carrying the SQLSTATE in `code`
  // (supabase-shifts.ts and friends do a bare `throw error`), so these are the
  // real shapes, not test conveniences.
  it.each([
    ['the handover business rule that started W-11', { code: '22023', message: 'A handover item is not an active material in this project' }],
    ['the 40 raises still on 55000', { code: '55000', message: 'El proyecto no admite reconciliación' }],
    ['a unique violation', { code: '23505', message: 'duplicate key value' }],
    ['an RLS denial', { code: '42501', message: 'new row violates row-level security policy' }],
    ['a plpgsql RAISE without an explicit errcode', { code: 'P0001', message: 'no se puede' }],
    ['Storage "Bucket not found" (W-13)', { message: 'Bucket not found', status: 400 }],
    ['a 404 from Storage', { status: 404, message: 'Not Found' }],
    ['a string statusCode, as StorageApiError reports it', { statusCode: '403', message: 'Forbidden' }],
  ])('quarantines %s', (_label, error) => {
    expect(isPermanentRejection(error)).toBe(true);
  });

  it.each([
    ['a lost signal on a drilling site', new Error('Network request failed')],
    ['a serialization failure', { code: '40001', message: 'could not serialize access' }],
    ['a dropped connection', { code: '08006', message: 'connection failure' }],
    ['an expired JWT, which refreshes itself', { code: 'PGRST301', message: 'JWT expired' }],
    ['a schema cache that has not loaded yet', { code: 'PGRST002', message: 'schema cache' }],
    ['a server fault', { status: 500, message: 'Internal Server Error' }],
    ['rate limiting', { status: 429, message: 'Too Many Requests' }],
    ['a request timeout', { status: 408, message: 'Request Timeout' }],
    ['insufficient resources', { code: '53300', message: 'too many connections' }],
    ['an unrecognisable object', { message: 'algo salió mal' }],
    ['a bare string', 'boom'],
    ['nothing at all', null],
  ])('keeps retrying %s', (_label, error) => {
    expect(isPermanentRejection(error)).toBe(false);
  });
});

describe('recordSyncFailure', () => {
  it('quarantines a permanent rejection instead of burning three retries on it', async () => {
    const outcome = await recordSyncFailure(
      'outbox-1',
      { code: '22023', message: 'not an active material' },
      'not an active material (22023)',
    );

    expect(outcome).toBe('quarantined');
    expect(mockQuarantineOutbox).toHaveBeenCalledWith('outbox-1', 'not an active material (22023)');
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('still counts a retry for a transient failure, which is the whole point of the outbox', async () => {
    const outcome = await recordSyncFailure(
      'outbox-2',
      new Error('Network request failed'),
      'Network request failed',
    );

    expect(outcome).toBe('retryable');
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-2', 'Network request failed');
    expect(mockQuarantineOutbox).not.toHaveBeenCalled();
  });
});

describe('a refusal that only means the session lapsed (code read S2, S3)', () => {
  it.each([
    ['an RLS denial', { code: '42501', message: 'new row violates row-level security policy' }],
    ['a Storage 403', { statusCode: '403', message: 'Forbidden' }],
    ['a Storage 401', { status: 401, message: 'Unauthorized' }],
  ])('retries %s sent without a usable session', async (_label, error) => {
    mockSessionUsable = false;

    expect(await recordSyncFailure('outbox-3', error, 'denied')).toBe('retryable');
    expect(mockQuarantineOutbox).not.toHaveBeenCalled();
  });

  it('still quarantines it when the session was fine', async () => {
    expect(await recordSyncFailure('outbox-4', { code: '42501', message: 'denied' }, 'denied')).toBe('quarantined');
  });

  it('still quarantines other refusals whatever the session', async () => {
    mockSessionUsable = false;

    expect(await recordSyncFailure('outbox-5', { code: '22023', message: 'bad' }, 'bad')).toBe('quarantined');
  });
});

describe('the offline short-circuit is never mistaken for a rejection', () => {
  /**
   * src/lib/supabase.ts rejects immediately with an OfflineError when NetInfo
   * reports no connectivity, instead of waiting out the 15s deadline.
   *
   * That error reaches this classifier on every queued write made in the field.
   * If it were ever judged permanent, the outbox would quarantine the operator's
   * work the moment they lost signal — turning the single most common condition
   * this app runs in into permanent data loss requiring a call to the office.
   *
   * Constructed here rather than imported, so this still guards the shape if the
   * class moves: what matters is that a plain Error carrying no SQLSTATE and no
   * HTTP status is transient.
   */
  it('treats a bare offline error as retryable', () => {
    const offline = new Error('Sin conexión');
    offline.name = 'OfflineError';
    expect(isPermanentRejection(offline)).toBe(false);
  });

  it('treats an aborted request as retryable', () => {
    // What the deadline produces when a request hangs and is aborted.
    const aborted = new Error('Aborted');
    aborted.name = 'AbortError';
    expect(isPermanentRejection(aborted)).toBe(false);
  });

  it('would catch an offline error that ever gained a 4xx status', () => {
    // Guard on the failure mode, not the current code: adding `status: 503` or
    // similar to OfflineError one day is what would quietly break this.
    const withStatus = Object.assign(new Error('Sin conexión'), { status: 400 });
    expect(isPermanentRejection(withStatus)).toBe(true);
  });
});
