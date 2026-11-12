import AsyncStorage from '@react-native-async-storage/async-storage';

const mockRequest = jest.fn(async () => { throw new Error('offline'); });
jest.mock('../src/lib/supabase', () => {
  const { createClient, processLock } = jest.requireActual('@supabase/supabase-js');
  const imported = require('@react-native-async-storage/async-storage');
  const storage = imported.default ?? imported;
  return { __esModule: true, default: createClient('http://127.0.0.1:54321', 'test-public-key', {
    auth: { storage, storageKey: 'local-session-test', autoRefreshToken: false, persistSession: true, detectSessionInUrl: false, lock: processLock },
    global: { fetch: (...args: unknown[]) => mockRequest(...args) },
  }) };
});

import supabase from '../src/lib/supabase';
import { clearLocalSession } from '../src/api/localSession';

const client = supabase.auth as any;
const session = (expiresAt: number) => ({
  access_token: 'test-access', refresh_token: 'test-refresh', token_type: 'bearer',
  expires_in: 3600, expires_at: expiresAt, user: { id: 'operator-a' },
});

beforeEach(async () => {
  await client.initializePromise;
  await AsyncStorage.clear();
  mockRequest.mockClear();
});

it.each([0, Math.floor(Date.now() / 1000) + 3600])('detaches even an expired session without an HTTP request (%s)', async (expiry) => {
  const events: string[] = [];
  const { data } = client.onAuthStateChange((event: string) => { events.push(event); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await client._saveSession(session(expiry));
  expect(await AsyncStorage.getItem(client.storageKey)).not.toBeNull();
  await clearLocalSession();
  expect(await AsyncStorage.getItem(client.storageKey)).toBeNull();
  expect(events).toContain('SIGNED_OUT');
  data.subscription.unsubscribe();
  expect(mockRequest).not.toHaveBeenCalled();
});

it('repairs the real auth-js behavior where a failed logout keeps the session', async () => {
  await client._saveSession(session(Math.floor(Date.now() / 1000) + 3600));
  const { error } = await client.signOut({ scope: 'local' });
  expect(error).toBeTruthy();
  expect(await AsyncStorage.getItem(client.storageKey)).not.toBeNull();
  await clearLocalSession();
  expect(await AsyncStorage.getItem(client.storageKey)).toBeNull();
});
