import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import supabase from '../lib/supabase';
import { bytesToHex, hexToBytes, pbkdf2HmacSha256Async, randomBytes } from './passwordKdf';
import { rememberSignedInOperator } from '../db/repositories/operators';

const VAULT_KEY = 'phc.operatorVault.v1';
export const PBKDF2_ITERATIONS = 20_000;
export interface VaultOperator {
  id: string; username: string; fullName: string; role: 'operator';
  session: Session; salt: string; verifier: string; iterations: number;
}
const options: SecureStore.SecureStoreOptions = { keychainService: 'phc.operatorVault' };
const load = async (): Promise<VaultOperator[]> => {
  try { return JSON.parse((await SecureStore.getItemAsync(VAULT_KEY, options)) || '[]'); }
  catch { return []; }
};
const save = (operators: VaultOperator[]) => SecureStore.setItemAsync(VAULT_KEY, JSON.stringify(operators), options);
// A token-refresh callback can overlap login/removal. Serialize the complete
// read/modify/write, otherwise an older snapshot overwrites another operator.
let pendingWrite: Promise<void> = Promise.resolve();
const updateVault = (update: (operators: VaultOperator[]) => VaultOperator[]): Promise<void> => {
  const write = pendingWrite.then(async () => save(update(await load())));
  pendingWrite = write.catch(() => undefined);
  return write;
};
// Public reads must observe writes queued before the read (removal/refresh).
// Keep updateVault on raw load so a write never waits on itself.
const readVault = async (): Promise<VaultOperator[]> => {
  await pendingWrite;
  return load();
};
const displayName = (user: { full_name?: string; first_name?: string; last_name?: string; username?: string }) =>
  user.full_name || [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || '';

export const listVaultOperators = async (): Promise<Pick<VaultOperator, 'id' | 'username' | 'fullName'>[]> =>
  (await readVault()).map(({ id, username, fullName }) => ({ id, username, fullName }));

export async function saveVaultOperator(user: {
  id: string; username?: string; email?: string; full_name?: string; first_name?: string; last_name?: string;
}, password: string, session?: Session | null): Promise<void> {
  const activeSession = session ?? (await supabase.auth.getSession()).data.session;
  if (!activeSession || !password) return;
  const salt = randomBytes(16);
  const record: VaultOperator = {
    id: user.id, username: (user.username || user.email?.split('@')[0] || '').toLowerCase(),
    fullName: displayName(user), role: 'operator', session: activeSession,
    salt: bytesToHex(salt), verifier: bytesToHex(await pbkdf2HmacSha256Async(password, salt, PBKDF2_ITERATIONS)),
    iterations: PBKDF2_ITERATIONS,
  };
  await updateVault((operators) => [record, ...operators.filter((item) => item.id !== user.id)].slice(0, 6));
}

export async function forgetVaultOperator(userId: string): Promise<void> {
  await updateVault((operators) => operators.filter((operator) => operator.id !== userId));
}

export async function forgetVaultUsername(username: string): Promise<void> {
  const normalized = username.trim().toLowerCase();
  await updateVault((operators) => operators.filter((operator) => operator.username.toLowerCase() !== normalized));
}

const persistRefreshedSession = async (session: Session) => {
  try {
    await updateVault((operators) => operators.map((operator) =>
      operator.id === session.user.id ? { ...operator, session } : operator));
  } catch { /* The active session remains usable if SecureStore is unavailable. */ }
};

// Keep each operator's refresh token current while that operator is active.
supabase.auth.onAuthStateChange((event, session) => {
  if (session && (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN')) void persistRefreshedSession(session);
});

export async function verifyVaultPassword(username: string, password: string): Promise<VaultOperator | null> {
  const operator = (await readVault()).find((item) => item.username.toLowerCase() === username.trim().toLowerCase());
  if (!operator) return null;
  const actual = await pbkdf2HmacSha256Async(password, hexToBytes(operator.salt), operator.iterations);
  const expected = hexToBytes(operator.verifier);
  let mismatch = actual.length ^ expected.length;
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) mismatch |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  return mismatch === 0 ? operator : null;
}

/** Restore the last verified session bytes without a network request (B3 outage path). */
export async function activateVaultSession(operator: VaultOperator): Promise<void> {
  const authClient = supabase.auth as unknown as {
    _saveSession: (session: Session) => Promise<void>;
    _notifyAllSubscribers: (event: string, session: Session) => Promise<void>;
  };
  // Supabase's public setSession verifies/refreshes over HTTP. Its existing
  // B3 path needs the saved session installed locally during a site outage.
  if (typeof authClient._saveSession !== 'function' || typeof authClient._notifyAllSubscribers !== 'function') {
    throw new Error('Supabase auth client internals changed; offline operator sign-in is disabled');
  }
  await authClient._saveSession(operator.session);
  await authClient._notifyAllSubscribers('SIGNED_IN', operator.session);
  const name = operator.fullName || operator.username;
  await AsyncStorage.multiSet([
    ['authToken', operator.session.access_token], ['userRole', 'operator'],
    ['userName', name], ['userId', operator.id], ['operatorId', operator.id],
    ['userLoginName', operator.username], ['phc.operatorLastActiveAt', String(Date.now())],
  ]);
  // Same as an online sign-in: the operator's own local row (shared tablet).
  await rememberSignedInOperator({ id: operator.id, name, currentTime: new Date().toISOString() })
    .catch((error) => console.warn('[PHC] Could not record the operator locally:', error));
}
