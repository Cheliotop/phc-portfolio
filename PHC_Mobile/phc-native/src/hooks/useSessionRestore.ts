import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { auth } from '../api/supabase-auth';

/**
 * Decide which screen the app opens on.
 *
 * The navigator hard-coded `initialRouteName="Login"`, so every cold start
 * landed on the login form even though the Supabase session was still valid in
 * AsyncStorage. Android reclaims a backgrounded app aggressively — switching to
 * another app and coming back is enough — so an operator was retyping their
 * password to get back to a screen they never left. In the field, in gloves,
 * that is the difference between recording a bar and not bothering.
 *
 * THE NETWORK MUST NOT DECIDE THIS
 * This reads the saved session straight from storage. `getSession()` would try
 * to refresh an expired access token first, and when that fails on a network
 * error it reports no session even though the saved one is still good. A phone
 * closed for over an hour and opened during an outage would then land on the
 * login form, which also needs the server.
 *
 * Whether the session is still valid is RoleGuard's call, on the dashboard this
 * opens. It sends a rejected session (a deactivated account, or months of
 * inactivity) back to the login screen.
 */
export type InitialRoute = 'Login' | 'OperatorDashboard' | 'AdminDashboard';

interface SessionRestore {
  checking: boolean;
  initialRoute: InitialRoute;
}

export const useSessionRestore = (): SessionRestore => {
  const [checking, setChecking] = useState(true);
  const [initialRoute, setInitialRoute] = useState<InitialRoute>('Login');

  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      try {
        // The role is what decides the destination, and it is written in the
        // same breath as the session at login. No role means no completed
        // login, whatever happens to be left in the auth store.
        const role = await AsyncStorage.getItem('userRole');
        if (role !== 'operator' && role !== 'admin') return;

        if (!(await auth.getStoredUserId())) return;

        if (!cancelled) {
          setInitialRoute(role === 'admin' ? 'AdminDashboard' : 'OperatorDashboard');
        }
      } catch {
        // Any failure here means "show the login screen", which is always a
        // safe answer. Never let this throw: it runs before the navigator
        // mounts, so an exception is a white screen with no way back.
      } finally {
        if (!cancelled) setChecking(false);
      }
    };

    void restore();
    return () => { cancelled = true; };
  }, []);

  return { checking, initialRoute };
};
