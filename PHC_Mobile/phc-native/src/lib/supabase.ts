import { createClient, processLock } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { AppState, Platform } from 'react-native';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../api/config';
import type { Database } from '../types/supabase.generated';

/**
 * Every request gets a deadline.
 *
 * `fetch` has no timeout. With no signal, a request does not fail — it hangs on
 * DNS or an unanswered TCP connect until the OS gives up, which on Android can
 * be well over a minute. Found on a real handset on 2026-08-01: Muestras,
 * Materiales, Pedidos and Cierre all sat on "Cargando…" forever with no signal.
 *
 * The screens were not missing their offline path. Three of the four already
 * read SQLite and already handle a failed refresh — they simply never reached
 * the catch, because the await never returned. A deadline is what turns
 * "forever" into "fall back to what is on the phone".
 *
 * Storage gets a longer one. A 250KB photo over a bad rural connection is
 * legitimately slow, and killing that upload at 15s would fail the one thing
 * hardest to redo: an operator cannot re-photograph a hole they have already
 * cased.
 */
const REQUEST_TIMEOUT_MS = 15_000;
const STORAGE_TIMEOUT_MS = 120_000;

/**
 * Last known connectivity, kept current by a listener so no request has to pay
 * for an async check. `null` means "not established yet", which is treated as
 * online — guessing offline would block the first request of every launch.
 */
let isOnline: boolean | null = null;
NetInfo.addEventListener((state) => {
  isOnline = state.isConnected === null ? null : Boolean(state.isConnected);
});

/**
 * Every no-signal failure, in Spanish, in one shape.
 *
 * Screens render `error.message` straight to the operator, so the alternative
 * is "Aborted" or "Network request failed" on a Paraguayan drilling site.
 *
 * Carries no SQLSTATE and no HTTP status ON PURPOSE: that is what makes the
 * outbox classify it as transient. Giving this a status would make the queue
 * quarantine an operator's work the moment they lost signal — see the guard in
 * __tests__/syncRejection.test.ts.
 */
export class OfflineError extends Error {
  constructor() {
    super('Sin conexión. Se muestra lo último guardado en este dispositivo.');
    this.name = 'OfflineError';
  }
}

/**
 * Did the auth server really answer this token refresh?
 *
 * The auth library deletes the saved session when an expired token's refresh
 * fails with anything but a network error. A 500, a rate limit or a proxy's
 * HTML error page would sign the operator out over a problem that says nothing
 * about their account, so those have to look like a network error instead.
 */
const isRealRefreshAnswer = (response: Response): boolean => {
  if (response.ok) return true;
  const { status } = response;
  return status < 500 && status !== 408 && status !== 429
    && (response.headers.get('content-type') ?? '').includes('json');
};

const fetchWithDeadline: typeof fetch = (input, init) => {
  // When the device is certain it has no connectivity, do not wait out the
  // deadline. The screens fall back to SQLite immediately instead of showing a
  // spinner for fifteen seconds to reach a conclusion the OS already had.
  // Only `false` short-circuits: an unknown state still attempts the request,
  // so a false negative from NetInfo costs a timeout rather than a feature.
  if (isOnline === false) {
    return Promise.reject(new OfflineError());
  }

  const url = typeof input === 'string' ? input : (input as Request)?.url ?? String(input);
  const timeout = url.includes('/storage/v1/') ? STORAGE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  // A caller's own signal still wins — the outbox aborts in-flight work when a
  // drain is superseded, and that must not be swallowed here.
  init?.signal?.addEventListener?.('abort', () => controller.abort());

  const isTokenRefresh = url.includes('/auth/v1/token') && url.includes('grant_type=refresh_token');

  return fetch(input, { ...init, signal: controller.signal })
    .then((response) => {
      if (isTokenRefresh && !isRealRefreshAnswer(response)) throw new OfflineError();
      return response;
    })
    .catch((error) => {
      // Screens surface `error.message` directly. Without this the operator
      // reads "Aborted" or "Network request failed" — English, and no help
      // about what to do. Rethrown as the same shape as the offline
      // short-circuit so the outbox still classifies it as transient.
      if (error?.name === 'AbortError' || /network request failed/i.test(error?.message ?? '')) {
        throw new OfflineError();
      }
      throw error;
    })
    .finally(() => clearTimeout(timer));
};

const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    lock: processLock,
  },
  global: { fetch: fetchWithDeadline },
});

// Supabase Auth does not receive browser visibility events in React Native.
// Tie token refresh to the native foreground lifecycle so a long-running
// field session cannot silently fall back to anonymous requests after its
// short-lived access token expires. This module is a singleton, so the
// listener is registered exactly once.
if (Platform.OS !== 'web') {
  const updateAutoRefresh = (state: string) => {
    if (state === 'active') {
      supabase.auth.startAutoRefresh();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  };

  updateAutoRefresh(AppState.currentState);
  AppState.addEventListener('change', updateAutoRefresh);
}

export default supabase;
