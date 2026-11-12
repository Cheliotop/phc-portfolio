import supabase from '../lib/supabase';

/**
 * Detach the active account without revoking its protected offline-vault token.
 * signOut({ scope: 'local' }) still contacts GoTrue and revokes that session;
 * it also leaves local storage intact if that request fails. Neither behavior
 * fits switching operators on a shared offline tablet.
 *
 * Like activateVaultSession, this deliberately uses the installed auth-js local
 * session methods. Keep the real-client compatibility test when upgrading it.
 * The auth lock prevents an in-flight refresh from restoring the old account.
 */
export async function clearLocalSession(): Promise<void> {
  const client = supabase.auth as unknown as {
    initializePromise?: Promise<unknown>;
    lockAcquireTimeout?: number;
    _acquireLock?: <T>(timeout: number, task: () => Promise<T>) => Promise<T>;
    _removeSession?: () => Promise<void>;
  };
  if (typeof client._acquireLock !== 'function' || typeof client._removeSession !== 'function') {
    throw new Error('No se pudo cerrar la sesión del dispositivo. Reiniciá la aplicación e intentá de nuevo.');
  }
  await client.initializePromise;
  await client._acquireLock(client.lockAcquireTimeout ?? 10_000, () => client._removeSession!());
}
