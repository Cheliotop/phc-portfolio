import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('../src/lib/supabase', () => ({ __esModule: true, default: { auth: { storageKey: 'sb-test-auth-token' } } }));

import { hasUsableSession } from '../src/sync/sessionValidity';

const store = (session: unknown) => AsyncStorage.setItem('sb-test-auth-token', JSON.stringify(session));

beforeEach(() => AsyncStorage.clear());

it('is false with no session stored', async () => {
  expect(await hasUsableSession()).toBe(false);
});

it('is true for a token that has not expired', async () => {
  await store({ access_token: 'a', expires_at: Math.floor(Date.now() / 1000) + 600 });
  expect(await hasUsableSession()).toBe(true);
});

it('is false for an expired token', async () => {
  await store({ access_token: 'a', expires_at: Math.floor(Date.now() / 1000) - 5 });
  expect(await hasUsableSession()).toBe(false);
});
