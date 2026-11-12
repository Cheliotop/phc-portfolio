import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { isDefiniteAuthRejection } from '../api/authFailure';
import { auth } from '../api/supabase-auth';
import { useTheme } from '../hooks/useTheme';
import type { RootStackNavigationProp } from './types';

type AppRole = 'admin' | 'operator';
type GuardState = 'checking' | 'allowed' | 'redirecting';

interface RoleGuardProps {
  requiredRole: AppRole;
  children: React.ReactNode;
}

/** How long a known user waits on a slow server before getting to work anyway. */
const SLOW_SERVER_GRACE_MS = 5_000;

/**
 * Verifies the live Supabase profile before mounting a dashboard. Only a
 * definite answer from the server signs the user out (see authFailure.ts). If
 * the server can't be reached, for any reason, the last verified role is used
 * as long as the session saved on the phone belongs to the same user. Server RLS
 * remains the authority for every remote read/write.
 */
const RoleGuard = ({ requiredRole, children }: RoleGuardProps) => {
  const navigation = useNavigation<RootStackNavigationProp<'AdminDashboard' | 'OperatorDashboard'>>();
  const { theme } = useTheme();
  const [state, setState] = useState<GuardState>('checking');

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      const resetToLogin = async () => {
        if (cancelled) {
          return;
        }
        setState('redirecting');
        try {
          await auth.logout();
        } catch (error) {
          console.warn('[AuthGuard] Logout cleanup failed:', error);
        }
        if (!cancelled) {
          navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
        }
      };

      const isKnownUser = async () => {
        const [[, cachedRole], [, cachedUserId]] = await AsyncStorage.multiGet([
          'userRole',
          'userId',
        ]);
        const storedUserId = await auth.getStoredUserId();
        return cachedRole === requiredRole
          && !!cachedUserId
          && cachedUserId === storedUserId;
      };

      const verify = async () => {
        const verifyStartedAt = Date.now();
        console.info(`[StartupTiming] RoleGuard entered role=${requiredRole} t=${verifyStartedAt}`);
        setState('checking');

        // On a weak link the checks below can take most of a minute. A known
        // user gets to work meanwhile; a rejection arriving later still applies.
        const knownUser = await isKnownUser().catch(() => false);
        const graceTimer = knownUser
          ? setTimeout(() => {
            if (!cancelled) {
              setState('allowed');
            }
          }, SLOW_SERVER_GRACE_MS)
          : null;

        try {
          const sessionStartedAt = Date.now();
          const session = await auth.getSession();
          console.info(
            `[StartupTiming] RoleGuard getSession resolved durationMs=${Date.now() - sessionStartedAt} totalMs=${Date.now() - verifyStartedAt} hasSession=${Boolean(session)} t=${Date.now()}`,
          );
          if (!session) {
            await resetToLogin();
            return;
          }

          const userStartedAt = Date.now();
          const user = await auth.getCurrentUser();
          console.info(
            `[StartupTiming] RoleGuard getCurrentUser resolved durationMs=${Date.now() - userStartedAt} totalMs=${Date.now() - verifyStartedAt} t=${Date.now()}`,
          );
          if (!user || user.is_active === false || user.role !== requiredRole) {
            await resetToLogin();
            return;
          }

          await AsyncStorage.multiSet([
            ['userRole', requiredRole],
            ['userId', user.id],
            ['operatorId', user.id],
          ]).catch((error) => console.warn('[AuthGuard] Could not refresh cached identity:', error));

          if (!cancelled) {
            console.info(
              `[StartupTiming] RoleGuard allowed totalMs=${Date.now() - verifyStartedAt} t=${Date.now()}`,
            );
            setState('allowed');
          }
        } catch (error) {
          console.info(
            `[StartupTiming] RoleGuard failed totalMs=${Date.now() - verifyStartedAt} t=${Date.now()}`,
          );
          console.warn('[AuthGuard] Session verification failed:', error);
          if (isDefiniteAuthRejection(error)) {
            await resetToLogin();
            return;
          }
          if (cancelled) {
            return;
          }
          if (knownUser) {
            console.info(
              `[StartupTiming] RoleGuard allowed unverified totalMs=${Date.now() - verifyStartedAt} t=${Date.now()}`,
            );
            setState('allowed');
            return;
          }
          // Nothing proves this user may open this dashboard, but nothing says
          // the session is bad either, so leave it in place for later.
          setState('redirecting');
          navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
        } finally {
          if (graceTimer) {
            clearTimeout(graceTimer);
          }
        }
      };

      verify();
      return () => {
        cancelled = true;
      };
    }, [navigation, requiredRole]),
  );

  if (state !== 'allowed') {
    return (
      <View style={[styles.loading, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator color={theme.colors.primary} accessibilityLabel="Verificando sesión" />
      </View>
    );
  }

  return <>{children}</>;
};

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default RoleGuard;
