/**
 * Runs the real Supabase auth client against a fake network, because the bugs
 * here lived in what the library does, not in our code. It reports a failed
 * refresh as "no session", and it deletes the saved session on any refresh
 * failure that is not a network error. A mocked client would hide both.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

// Jest's default screen is 750x1334 dp, which the tablet rule would count as a tablet.
// These tests cover the phone biometric path, so pin the device to a phone.
jest.mock('../src/utils/device', () => ({ isTablet: () => false }));

import { isDefiniteAuthRejection } from '../src/api/authFailure';
import { restoreSessionWithBiometrics } from '../src/api/biometricSession';
import { auth } from '../src/api/supabase-auth';
import supabase from '../src/lib/supabase';

const STORAGE_KEY = (supabase.auth as unknown as { storageKey: string }).storageKey;
const nowSeconds = () => Math.floor(Date.now() / 1000);

let tokenNumber = 0;

/** A unique token each time, so the library's refresh failure cooldown never carries over. */
const saveSession = (expiresAt: number) => {
  tokenNumber += 1;
  return AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({
    access_token: `access-${tokenNumber}`,
    refresh_token: `refresh-${tokenNumber}`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expiresAt,
    user: { id: 'op-1' },
  }));
};
const saveExpiredSession = () => saveSession(nowSeconds() - 3600);
const saveLiveSession = () => saveSession(nowSeconds() + 3600);

const respond = (status: number, body: unknown, contentType = 'application/json') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
  json: async () => {
    if (contentType !== 'application/json') throw new SyntaxError('Unexpected token <');
    return body;
  },
  text: async () => String(body),
});

const fetchMock = jest.fn();

/** Let the library's retry backoff run out without really waiting for it. */
const settle = async <T>(work: Promise<T>): Promise<T> => {
  const caught = work.then(
    (value) => ({ value, error: undefined as unknown, failed: false }),
    (error) => ({ value: undefined as T, error, failed: true }),
  );
  await jest.advanceTimersByTimeAsync(60_000);
  const result = await caught;
  if (result.failed) throw result.error;
  return result.value;
};

describe('a saved session against a bad network, using the real auth client', () => {
  const realFetch = global.fetch;

  beforeAll(() => {
    supabase.auth.stopAutoRefresh();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    fetchMock.mockReset();
    await AsyncStorage.clear();
  });

  afterEach(() => jest.useRealTimers());

  describe('when an expired token cannot be refreshed', () => {
    const cases: [string, () => unknown][] = [
      ['no network', () => Promise.reject(new TypeError('Network request failed'))],
      ['a request that times out', () => {
        const aborted = new Error('Aborted');
        aborted.name = 'AbortError';
        return Promise.reject(aborted);
      }],
      ['a gateway error', () => Promise.resolve(respond(503, '<html>', 'text/html'))],
      ['a server error with no JSON', () => Promise.resolve(respond(500, '<html>', 'text/html'))],
      ['a server error with JSON', () => Promise.resolve(respond(500, { code: 'unexpected_failure', msg: 'x' }))],
      ['a rate limit', () => Promise.resolve(respond(429, { code: 'over_request_rate_limit', msg: 'x' }))],
      ['a captive portal refusing the request', () => Promise.resolve(respond(403, '<html>', 'text/html'))],
      ['a captive portal answering 200', () => Promise.resolve(respond(200, '<html>', 'text/html'))],
    ];

    it.each(cases)('keeps the session through %s', async (_name, network) => {
      await saveExpiredSession();
      fetchMock.mockImplementation(network);

      const error = await settle(auth.getSession()).then(() => null, (thrown) => thrown);

      expect(error).not.toBeNull();
      expect(isDefiniteAuthRejection(error)).toBe(false);
      expect(await auth.getStoredUserId()).toBe('op-1');
    });

    it('gives the profile check the same answer, not a sign-out', async () => {
      await saveExpiredSession();
      fetchMock.mockRejectedValue(new TypeError('Network request failed'));

      const error = await settle(auth.getCurrentUser()).then(() => null, (thrown) => thrown);

      expect(isDefiniteAuthRejection(error)).toBe(false);
      expect(await auth.getStoredUserId()).toBe('op-1');
    });
  });

  it('treats a refused refresh token as signed out', async () => {
    await saveExpiredSession();
    fetchMock.mockResolvedValue(respond(400, { code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }));

    await expect(settle(auth.getSession())).resolves.toBeNull();
    expect(await auth.getStoredUserId()).toBeNull();
  });

  it('refreshes normally once the server is back', async () => {
    await saveExpiredSession();
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    await settle(auth.getSession()).catch(() => undefined);

    jest.advanceTimersByTime(60_000);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(respond(200, {
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: nowSeconds() + 3600,
      user: { id: 'op-1' },
    }));

    const session = await settle(auth.getSession());
    expect(session?.access_token).toBe('new-access');
  });

  it('returns a live session without touching the network', async () => {
    await saveLiveSession();

    const session = await settle(auth.getSession());

    expect(session?.user.id).toBe('op-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('classifying the profile check with a live token', () => {
    it('does not call a dropped connection a rejection', async () => {
      await saveLiveSession();
      fetchMock.mockRejectedValue(new TypeError('Network request failed'));

      const error = await settle(auth.getCurrentUser()).then(() => null, (thrown) => thrown);

      expect(error).not.toBeNull();
      expect(isDefiniteAuthRejection(error)).toBe(false);
    });

    it('calls a refused token a rejection', async () => {
      await saveLiveSession();
      fetchMock.mockResolvedValue(respond(403, { code: 'bad_jwt', msg: 'invalid JWT' }));

      const error = await settle(auth.getCurrentUser()).then(() => null, (thrown) => thrown);

      expect(isDefiniteAuthRejection(error)).toBe(true);
    });

    it('calls a revoked session a rejection', async () => {
      await saveLiveSession();
      fetchMock.mockResolvedValue(respond(403, { code: 'session_not_found', msg: 'gone' }));

      const error = await settle(auth.getCurrentUser()).then(() => null, (thrown) => thrown);

      expect(isDefiniteAuthRejection(error)).toBe(true);
    });
  });

  describe('biometric sign-in', () => {
    const getItem = SecureStore.getItemAsync as jest.Mock;
    const deleteItem = SecureStore.deleteItemAsync as jest.Mock;

    beforeEach(() => {
      deleteItem.mockClear();
      tokenNumber += 1;
      getItem.mockResolvedValue(`biometric-${tokenNumber}`);
    });

    afterEach(() => getItem.mockResolvedValue(null));

    it('keeps the stored token through an outage', async () => {
      fetchMock.mockRejectedValue(new TypeError('Network request failed'));

      const result = await settle(restoreSessionWithBiometrics());

      expect(result).toEqual({ ok: false, reason: 'failed' });
      expect(deleteItem).not.toHaveBeenCalled();
    });

    it('forgets a token the server refused', async () => {
      fetchMock.mockResolvedValue(respond(400, { code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }));

      const result = await settle(restoreSessionWithBiometrics());

      expect(result).toEqual({ ok: false, reason: 'expired' });
      expect(deleteItem).toHaveBeenCalled();
    });
  });
});
