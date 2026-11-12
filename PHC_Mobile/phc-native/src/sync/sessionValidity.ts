import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Whether the phone holds a session the server should still accept.
 *
 * Read from storage, not through `auth.getSession()`, which tries a refresh when the
 * token has expired and can hold a drain for most of a minute while the auth server
 * is unreachable. Needed only to judge a refusal, so it errs towards "no".
 */
export const hasUsableSession = async (): Promise<boolean> => {
  try {
    // Required here rather than imported, so loading the sync rules never builds
    // the Supabase client.
    const supabase = require('../lib/supabase').default;
    const { storageKey } = supabase.auth as { storageKey: string };
    const stored = await AsyncStorage.getItem(storageKey);
    if (!stored) return false;
    const session = JSON.parse(stored);
    const expiresAt = Number(session?.expires_at);
    return Boolean(session?.access_token) && Number.isFinite(expiresAt) && expiresAt * 1000 > Date.now() + 10_000;
  } catch {
    return false;
  }
};
