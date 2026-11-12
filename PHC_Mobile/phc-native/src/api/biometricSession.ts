/**
 * Biometric sign-in, backed by a stored Supabase refresh token.
 *
 * The button used to say "Iniciar con Face ID" but could not start anything.
 * It verified a fingerprint and then called `getCurrentUser()`, so it only
 * worked while a session already existed — which is to say it failed at the
 * exact moment anyone would reach for it, right after signing out.
 *
 * What is stored is the refresh token, never the password. A password is
 * forever and works everywhere; a refresh token is revocable from the server,
 * scoped to this app, and rotates on every use. It sits in SecureStore with
 * `requireAuthentication`, so the Android keystore itself gates the read behind
 * the biometric prompt rather than us checking a fingerprint in JavaScript and
 * then reading an unprotected value.
 *
 * Note that Supabase's own session already lives in AsyncStorage in plaintext.
 * This does not make that worse, and the token here is the only copy that
 * survives sign-out.
 */
import * as SecureStore from 'expo-secure-store';

import supabase from '../lib/supabase';
import { isDefiniteAuthRejection } from './authFailure';
import { isTablet } from '../utils/device';

const REFRESH_TOKEN_KEY = 'phc.biometric.refreshToken';
const ROLE_KEY = 'phc.biometric.role';

/** SecureStore rejects `requireAuthentication` when no secure lock screen is set up. */
const PROTECTED: SecureStore.SecureStoreOptions = {
  requireAuthentication: true,
  keychainService: 'phc.biometric',
};

const UNPROTECTED: SecureStore.SecureStoreOptions = {
  keychainService: 'phc.biometric',
};

export type BiometricEnrollFailure = 'no-session' | 'no-secure-lock' | 'failed';
export type BiometricRestoreFailure = 'not-enrolled' | 'cancelled' | 'expired' | 'failed';

// Both members carry both keys. A bare discriminated union would be tidier,
// but callers read `.reason` right after an `if (!result.ok)` guard and the
// narrowing does not survive that here, so the optional keys keep the call
// sites honest rather than forcing a cast.
export interface BiometricEnrollResult {
  ok: boolean;
  reason?: BiometricEnrollFailure;
}

export interface BiometricRestoreResult {
  ok: boolean;
  role?: 'admin' | 'operator';
  reason?: BiometricRestoreFailure;
}

/**
 * Remember the current session for biometric sign-in. Called after a
 * successful password login; failure is not fatal, the user simply keeps
 * signing in with a password.
 */
export async function enableBiometricSignIn(role: 'admin' | 'operator'): Promise<BiometricEnrollResult> {
  if (isTablet()) return { ok: false, reason: 'failed' };
  const { data } = await supabase.auth.getSession();
  const refreshToken = data.session?.refresh_token;
  if (!refreshToken) return { ok: false, reason: 'no-session' };
  try {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken, PROTECTED);
    await SecureStore.setItemAsync(ROLE_KEY, role, UNPROTECTED);
    return { ok: true };
  } catch (error) {
    // Thrown on a device with no PIN, pattern or biometric enrolled. Storing
    // the token unprotected instead would defeat the point, so we decline.
    //
    // The message is logged rather than swallowed: an emulator with no lock
    // screen and a genuinely missing native module both surface here, and
    // without the text there is no way to tell them apart from a field report.
    const message = String((error as Error)?.message || error || '');
    console.info(`[Biometric] Could not store session: ${message}`);
    const lower = message.toLowerCase();
    const noSecureLock = ['authentication', 'keyguard', 'secure lock', 'not enrolled', 'biometric', 'passcode']
      .some((needle) => lower.includes(needle));
    return { ok: false, reason: noSecureLock ? 'no-secure-lock' : 'failed' };
  }
}

/** Whether a biometric sign-in has been set up on this device. */
export async function hasBiometricSignIn(): Promise<boolean> {
  if (isTablet()) return false;
  try {
    return (await SecureStore.getItemAsync(ROLE_KEY, UNPROTECTED)) !== null;
  } catch {
    return false;
  }
}

/**
 * Exchange the stored refresh token for a live session. Reading the token
 * triggers the OS biometric prompt.
 */
export async function restoreSessionWithBiometrics(): Promise<BiometricRestoreResult> {
  if (isTablet()) return { ok: false, reason: 'not-enrolled' };
  let refreshToken: string | null = null;
  try {
    refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY, PROTECTED);
  } catch {
    // The user dismissed the prompt or the biometric did not match. The stored
    // token is untouched so they can try again.
    return { ok: false, reason: 'cancelled' };
  }
  if (!refreshToken) return { ok: false, reason: 'not-enrolled' };

  const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
  // No answer from the server says nothing about the token, so keep it.
  if (error && !isDefiniteAuthRejection(error)) return { ok: false, reason: 'failed' };
  if (error || !data.session) {
    // Refresh tokens expire and are revoked when an operator is deactivated or
    // signs out elsewhere. Clear it so the button stops offering a route that
    // cannot work.
    await clearBiometricSignIn();
    return { ok: false, reason: 'expired' };
  }

  // Supabase rotates the refresh token on every use, so the stored one is now
  // spent. Without this, biometric sign-in would work exactly once.
  try {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, data.session.refresh_token, PROTECTED);
  } catch {
    // The session is live either way; the next biometric attempt will fall
    // back to the password, which is the safe direction to fail in.
  }

  const storedRole = await SecureStore.getItemAsync(ROLE_KEY, UNPROTECTED).catch(() => null);
  return { ok: true, role: storedRole === 'admin' ? 'admin' : 'operator' };
}

/** Forget the biometric session. Called on sign-out and on a dead token. */
export async function clearBiometricSignIn(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, PROTECTED).catch(() => undefined),
    SecureStore.deleteItemAsync(ROLE_KEY, UNPROTECTED).catch(() => undefined),
  ]);
}
