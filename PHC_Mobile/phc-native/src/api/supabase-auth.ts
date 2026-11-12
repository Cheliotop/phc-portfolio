import supabase from '../lib/supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isDefiniteAuthRejection } from './authFailure';
import { clearBiometricSignIn } from './biometricSession';
import { forgetVaultOperator } from '../utils/operatorVault';
import { rememberSignedInOperator } from '../db/repositories/operators';
import { clearLocalSession } from './localSession';

export interface AuthUser {
  id: string;
  email?: string;
  username?: string;
  role: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  is_active?: boolean;
}

export const auth = {
  async login(email: string, password: string): Promise<{ user: AuthUser }> {
    const loginStartedAt = Date.now();
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    console.info(
      `[StartupTiming] Password auth resolved outcome=${error || !data.user ? 'error' : 'ok'} durationMs=${Date.now() - loginStartedAt} t=${Date.now()}`,
    );
    if (error) throw error;
    if (!data.user) throw new Error('No user returned');

    const profileStartedAt = Date.now();
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .single();
    console.info(
      `[StartupTiming] Login profile query resolved durationMs=${Date.now() - profileStartedAt} t=${Date.now()}`,
    );
    if (profileError) throw profileError;

    // Pass 1.5: deactivated accounts are blocked at login. is_active is an
    // admin-controlled column (see protect_profiles_privileged DB trigger).
    if (profile && profile.is_active === false) {
      await forgetVaultOperator(data.user.id);
      await supabase.auth.signOut({ scope: 'local' });
      throw new Error('Usuario desactivado. Contactá al administrador.');
    }

    const user: AuthUser = {
      id: data.user.id,
      email: data.user.email,
      username: profile?.username || data.user.email?.split('@')[0] || '',
      role: profile?.role || 'operator',
      full_name: profile?.full_name,
      first_name: profile?.first_name,
      last_name: profile?.last_name,
      is_active: profile?.is_active,
    };

    await auth.rememberSignedInUser(user);
    return { user };
  },

  /**
   * Cache who is signed in, for offline screens and RoleGuard's offline check.
   * Both sign-in paths (password and biometric) must call this: RoleGuard only
   * honours an offline session whose user matches the cached userId.
   */
  async rememberSignedInUser(user: AuthUser): Promise<void> {
    const displayName = user.full_name
      || [user.first_name, user.last_name].filter(Boolean).join(' ')
      || user.username
      || '';
    const { data: sessionData } = await supabase.auth.getSession();
    await AsyncStorage.multiSet([
      ['authToken', sessionData?.session?.access_token || ''],
      ['userRole', user.role === 'admin' ? 'admin' : 'operator'],
      ['userName', displayName],
      ['userId', user.id],
      ['operatorId', user.id],
      ['userLoginName', user.username || user.email?.split('@')[0] || ''],
      ['phc.operatorLastActiveAt', String(Date.now())],
    ]);
    if (user.role !== 'admin') {
      // Every record this operator saves references their local row; operador 2 of
      // a shared tablet had none. Best effort: sign-in must not fail on SQLite.
      await rememberSignedInOperator({
        id: user.id,
        name: displayName || 'Operador',
        currentTime: new Date().toISOString(),
      }).catch((error) => console.warn('[PHC] Could not record the operator locally:', error));
    }
  },

  // Pass 1.5: admin-side operator creation. Calls the `admin-create-operator`
  // Edge Function, which uses the service-role Admin API server-side. This
  // NEVER touches the caller's session (the old signUp()-based flow replaced
  // the admin's session with the new operator's — audit finding #2). Only
  // admins pass the function's is_admin() check.
  async adminCreateOperator(data: {
    username: string;
    password: string;
    email?: string;
    first_name?: string;
    last_name?: string;
  }): Promise<{ user: AuthUser }> {
    const { data: result, error } = await supabase.functions.invoke('admin-create-operator', {
      body: data,
    });

    if (error) {
      // supabase-js wraps non-2xx responses; surface the function's message.
      let message = error.message || 'No se pudo crear el operador';
      try {
        const ctx = (error as any).context;
        if (ctx && typeof ctx.json === 'function') {
          const payload = await ctx.json();
          if (payload?.error) message = payload.error;
        }
      } catch {
        // keep generic message
      }
      throw new Error(message);
    }

    if (result?.error) throw new Error(result.error);
    if (!result?.user) throw new Error('No se pudo crear el operador');

    return { user: result.user as AuthUser };
  },

  async logout(options: { preserveOfflineSession?: boolean } = {}): Promise<void> {
    try {
      if (options.preserveOfflineSession) {
        await clearLocalSession();
      } else {
        try {
          const { error } = await supabase.auth.signOut({ scope: 'local' });
          if (error) await clearLocalSession();
        } catch {
          // A network failure must not leave an active Supabase session behind
          // after the visible identity has been removed.
          await clearLocalSession();
        }
      }
    } finally {
      await AsyncStorage.multiRemove([
        'authToken', 'userRole', 'userName', 'userId', 'operatorId', 'userLoginName',
      ]);
      await clearBiometricSignIn();
    }
  },

  /**
   * The current session, refreshed if needed. Null means there is none, or the
   * server rejected it. Throws when the refresh could not reach the server: the
   * library also reports that as a null session, but the session is still on
   * the phone and still good, so callers must not treat it as signed out.
   */
  async getSession() {
    const { data, error } = await supabase.auth.getSession();
    if (!data.session && error && !isDefiniteAuthRejection(error)) throw error;
    return data.session;
  },

  /** Whose session is saved on this phone. Reads storage only, never the network. */
  async getStoredUserId(): Promise<string | null> {
    const { storageKey } = supabase.auth as unknown as { storageKey: string };
    const stored = await AsyncStorage.getItem(storageKey);
    if (!stored) return null;
    try {
      return JSON.parse(stored)?.user?.id ?? null;
    } catch {
      return null;
    }
  },

  async getCurrentUser(): Promise<AuthUser | null> {
    const authUserStartedAt = Date.now();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    console.info(
      `[StartupTiming] getCurrentUser auth user resolved durationMs=${Date.now() - authUserStartedAt} t=${Date.now()}`,
    );
    if (userError) throw userError;
    if (!user) return null;

    const profileStartedAt = Date.now();
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();
    console.info(
      `[StartupTiming] getCurrentUser profile resolved durationMs=${Date.now() - profileStartedAt} t=${Date.now()}`,
    );
    if (profileError) throw profileError;

    if (!profile) return null;

    return {
      id: user.id,
      email: user.email,
      username: profile.username,
      role: profile.role,
      full_name: profile.full_name,
      first_name: profile.first_name,
      last_name: profile.last_name,
      is_active: profile.is_active,
    };
  },
};
