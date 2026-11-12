import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { friendlyApiError } from '../api/supabase-api-errors';
import { AuthContext, type AppRole, type AppUser, type AuthContextValue } from './auth-context';

interface ProfileRow {
  id: string;
  email?: string | null;
  username?: string | null;
  full_name?: string | null;
  role?: string | null;
  is_active?: boolean | null;
}

interface InFlightValidation {
  accessToken: string;
  promise: Promise<boolean>;
}

const loginErrorMessage = (error: { message: string; code?: string }) =>
  error.message.includes('Invalid login')
    ? 'Email o contraseña incorrectos'
    : friendlyApiError(error, 'No se pudo iniciar sesión.').message;

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const validationVersionRef = useRef(0);
  const inFlightValidationRef = useRef<InFlightValidation | null>(null);
  // The user the screens are showing. auth-js re-sends SIGNED_IN on every tab switch
  // and TOKEN_REFRESHED every hour. Treating those as a new login tore the whole admin
  // down to "Cargando…", losing whatever was being typed (code read W3).
  const validatedUserIdRef = useRef<string | null>(null);

  const invalidateLocalSession = useCallback(() => {
    validationVersionRef.current += 1;
    inFlightValidationRef.current = null;
    validatedUserIdRef.current = null;
    setSession(null);
    setUser(null);
    setLoading(false);
  }, []);

  // Accepts admin AND operator accounts (the web now hosts both roles, mirroring
  // the mobile app). Admins additionally must pass the server-side is_admin()
  // check; operators only need an active operator profile. RLS still governs
  // every row an operator can read or write.
  const validateSession = useCallback((candidate: Session | null): Promise<boolean> => {
    if (!candidate?.user) {
      invalidateLocalSession();
      return Promise.resolve(false);
    }

    const existing = inFlightValidationRef.current;
    if (existing?.accessToken === candidate.access_token) {
      return existing.promise;
    }

    const version = ++validationVersionRef.current;
    setSession(candidate);
    setUser(null);
    setLoading(true);
    setError(null);

    const validation = (async () => {
      const [profileResult, adminResult] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, username, email, role, full_name, is_active')
          .eq('id', candidate.user.id)
          .maybeSingle(),
        supabase.rpc('is_admin'),
      ]);

      if (!mountedRef.current || version !== validationVersionRef.current) return false;

      if (profileResult.error) {
        setSession(candidate);
        setUser(null);
        setError('No se pudo validar la cuenta. Verificá tu conexión e intentá de nuevo.');
        setLoading(false);
        return false;
      }

      const profile = profileResult.data as ProfileRow | null;
      const isAdminServer = adminResult.error ? false : adminResult.data === true;
      let rejectionMessage: string | null = null;
      let role: AppRole = 'operator';

      if (!profile) {
        rejectionMessage = 'No se encontró un perfil habilitado para esta cuenta.';
      } else if (profile.is_active !== true) {
        rejectionMessage = 'Esta cuenta está desactivada.';
      } else if (profile.role === 'admin') {
        role = 'admin';
        // Defence in depth: a profile claiming admin must also satisfy is_admin().
        if (adminResult.error) {
          // Not a refusal: the check didn't get an answer. Signing out here turned a
          // network blip into a lost session. Keep it and let the admin retry.
          setSession(candidate);
          setUser(null);
          setError('No se pudo validar la cuenta de administrador. Verificá tu conexión e intentá de nuevo.');
          setLoading(false);
          return false;
        } else if (!isAdminServer) {
          rejectionMessage = 'Esta cuenta no tiene permisos de administrador.';
        }
      } else if (profile.role === 'operator') {
        role = 'operator';
      } else {
        rejectionMessage = 'Esta cuenta no tiene un rol habilitado.';
      }

      if (rejectionMessage || !profile) {
        setSession(null);
        setUser(null);
        setError(rejectionMessage || 'No se encontró un perfil habilitado para esta cuenta.');
        setLoading(false);
        await supabase.auth.signOut();
        return false;
      }

      validatedUserIdRef.current = profile.id;
      setSession(candidate);
      setUser({
        id: profile.id,
        email: profile.email ?? candidate.user.email ?? undefined,
        username: profile.username ?? undefined,
        full_name: profile.full_name ?? undefined,
        role,
        is_active: true,
      });
      setLoading(false);
      return true;
    })().catch((validationError: unknown) => {
      if (mountedRef.current && version === validationVersionRef.current) {
        setSession(candidate);
        setUser(null);
        setError(friendlyApiError(validationError, 'No se pudo validar la cuenta.').message);
        setLoading(false);
      }
      return false;
    });

    inFlightValidationRef.current = { accessToken: candidate.access_token, promise: validation };
    void validation.finally(() => {
      if (inFlightValidationRef.current?.promise === validation) {
        inFlightValidationRef.current = null;
      }
    });
    return validation;
  }, [invalidateLocalSession]);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    const scheduleValidation = (nextSession: Session | null) => {
      if (cancelled) return;
      if (!nextSession) {
        invalidateLocalSession();
        return;
      }
      if (nextSession.user?.id && nextSession.user.id === validatedUserIdRef.current) {
        // Same person, new token: keep the screens as they are.
        setSession(nextSession);
        return;
      }
      setSession(nextSession);
      setUser(null);
      setLoading(true);
      window.setTimeout(() => {
        if (!cancelled && mountedRef.current) void validateSession(nextSession);
      }, 0);
    };

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      scheduleValidation(nextSession);
    });

    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (cancelled || !mountedRef.current) return;
      if (sessionError) {
        invalidateLocalSession();
        setError(friendlyApiError(sessionError, 'No se pudo validar la sesión.').message);
        return;
      }
      scheduleValidation(data.session);
    });

    return () => {
      cancelled = true;
      mountedRef.current = false;
      validationVersionRef.current += 1;
      inFlightValidationRef.current = null;
      listener.subscription.unsubscribe();
    };
  }, [invalidateLocalSession, validateSession]);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setError(loginErrorMessage(signInError));
      return false;
    }
    if (!data.session || !data.user) {
      setError('No se pudo iniciar sesión.');
      return false;
    }
    return validateSession(data.session);
  }, [validateSession]);

  const logout = useCallback(async () => {
    setError(null);
    invalidateLocalSession();
    const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
    if (signOutError && mountedRef.current) setError(friendlyApiError(signOutError, 'No se pudo cerrar la sesión.').message);
  }, [invalidateLocalSession]);

  const value = useMemo<AuthContextValue>(() => ({
    session,
    user,
    loading,
    error,
    login,
    logout,
    isAdmin: user?.role === 'admin',
    isOperator: user?.role === 'operator',
  }), [session, user, loading, error, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
