import React, { useEffect, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { RootStackNavigationProp } from '../navigation/types';
import { useBiometricAuth } from '../hooks/useBiometricAuth';
import { auth } from '../api/supabase-auth';
import { enableBiometricSignIn, restoreSessionWithBiometrics } from '../api/biometricSession';
import type { BiometricRestoreFailure } from '../api/biometricSession';
import { createAuditLog } from '../utils/auditLog';
import { COLORS, SPACING, RADIUS, TYPE } from '../theme/phcTheme';
import PHCLogo from '../components/shared/PHCLogo';
import { PHCButton } from '../components/shared/ui';
import { showSheet } from '../components/shared/Sheet';
import { toFriendlyLoginMessage } from '../utils/errorMessage';
import { claimOutbox } from '../sync/outboxOwner';
import NetInfo from '@react-native-community/netinfo';
import { isTablet } from '../utils/device';
import { activateVaultSession, listVaultOperators, saveVaultOperator, verifyVaultPassword, forgetVaultUsername } from '../utils/operatorVault';

const LoginScreen = () => {
  const navigation = useNavigation<RootStackNavigationProp<'Login'>>();
  const { isAvailable, getBiometricLabel } = useBiometricAuth();
  const tablet = isTablet();

  const [selectedRole, setSelectedRole] = useState<'admin' | 'operator' | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [operators, setOperators] = useState<Array<{ id: string; username: string; fullName: string }>>([]);

  useEffect(() => { void listVaultOperators().then(setOperators).catch(() => setOperators([])); }, []);

  const handleRoleSelect = (role: 'admin' | 'operator') => {
    setSelectedRole(role);
    setEmail('');
    setPassword('');
  };

  /**
   * Refuse a shared phone to a second operator while the first one's work is
   * still queued (see sync/outboxOwner.ts). Signs the new session out again.
   */
  const takeOverOutbox = async (userId: string): Promise<boolean> => {
    const claim = await claimOutbox(userId);
    if (claim.ok) return true;
    await auth.logout();
    showSheet(
      'Teléfono con datos sin subir',
      `Este dispositivo tiene ${claim.unsent} registro(s) de otro operador que todavía no se subieron. `
        + 'Ese operador debe iniciar sesión con conexión para subirlos antes de que otra persona use el dispositivo.',
    );
    return false;
  };

  /**
   * This used to verify a fingerprint and then ask `getCurrentUser()` whether a
   * session existed — so it could only ever unlock a session you already had,
   * and did nothing after signing out, which is when it was actually wanted.
   * It now trades a stored refresh token for a real session, so it genuinely
   * signs you in.
   */
  const handleBiometricLogin = async () => {
    if (!isAvailable || tablet) {
      showSheet('Biométrico no disponible', 'Usá tu usuario y contraseña para iniciar sesión');
      return;
    }
    setLoading(true);
    try {
      const restored = await restoreSessionWithBiometrics();
      if (!restored.ok) {
        const messages: Record<BiometricRestoreFailure, string> = {
          'not-enrolled': 'Iniciá sesión con usuario y contraseña una vez y activá el acceso biométrico.',
          cancelled: 'No se completó la verificación biométrica. Probá de nuevo o usá tu contraseña.',
          expired: 'Tu acceso guardado venció. Iniciá sesión con usuario y contraseña.',
          failed: 'No se pudo restaurar la sesión. Usá tu usuario y contraseña.',
        };
        showSheet('Acceso biométrico', messages[restored.reason ?? 'failed']);
        return;
      }

      let resolvedRole: 'admin' | 'operator' = restored.role ?? 'operator';
      try {
        const currentUser = await auth.getCurrentUser();
        if (currentUser && currentUser.is_active === false) {
          await auth.logout();
          showSheet('Acceso bloqueado', 'Tu usuario fue desactivado. Contactá al administrador.');
          return;
        }
        if (currentUser) {
          resolvedRole = currentUser.role === 'admin' ? 'admin' : 'operator';
          await auth.rememberSignedInUser(currentUser);
        }
      } catch (checkError) {
        // The refresh above already proved the token is live; a failed profile
        // read here means the network dropped, not that access is invalid.
        console.warn('[Login] Could not verify account status (offline?):', checkError);
      }
      const userId = (await auth.getSession())?.user?.id || 'unknown';
      if (resolvedRole === 'operator' && !(await takeOverOutbox(userId))) return;
      await createAuditLog('LOGIN', 'user', userId, { method: 'biometric' });
      navigation.replace(resolvedRole === 'admin' ? 'AdminDashboard' : 'OperatorDashboard');
    } catch (error) {
      console.error('[Login] Biometric error:', error);
      showSheet('Acceso biométrico', 'No se pudo restaurar la sesión. Usá tu usuario y contraseña.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async () => {
    if (!selectedRole) return showSheet('Error', 'Seleccioná tu acceso');
    if (!email.trim()) return showSheet('Error', selectedRole === 'operator' ? 'Ingresá tu usuario' : 'Ingresá tu email');
    if (!password) return showSheet('Error', 'Ingresá tu contraseña');

    const trimmedEmail = email.trim();
    // Operators are given a plain username by the admin, not an email — the
    // account's real login is `${username}@phc.local` under the hood (see
    // admin-create-operator). Accept the bare username here so operators
    // never need to know or type that suffix themselves.
    const loginEmail = selectedRole === 'operator' && !trimmedEmail.includes('@')
      ? `${trimmedEmail.toLowerCase()}@phc.local`
      : trimmedEmail;

    const loginStartedAt = Date.now();
    console.info(`[StartupTiming] Login submitted t=${loginStartedAt}`);
    setLoading(true);
    try {
      if (selectedRole === 'operator') {
        const connectivity = await NetInfo.fetch().catch(() => ({ isConnected: true, isInternetReachable: null } as any));
        if (!connectivity.isConnected || connectivity.isInternetReachable === false) {
          const cached = await verifyVaultPassword(trimmedEmail, password);
          if (!cached) throw new Error('Invalid login credentials');
          if (!(await takeOverOutbox(cached.id))) return;
          await activateVaultSession(cached);
          await createAuditLog('LOGIN', 'user', cached.id, { method: 'offline-vault' });
          navigation.replace('OperatorDashboard');
          return;
        }
      }
      const { user } = await auth.login(loginEmail, password);
      console.info(
        `[StartupTiming] auth.login resolved durationMs=${Date.now() - loginStartedAt} t=${Date.now()}`,
      );
      const backendRole = user.role === 'admin' ? 'admin' : 'operator';

      if (selectedRole === 'admin' && backendRole !== 'admin') {
        await auth.logout();
        showSheet('Acceso denegado', 'Este usuario no tiene permisos de administrador');
        return;
      }
      if (backendRole === 'operator') {
        if (!(await takeOverOutbox(user.id))) return;
        // Keep this operator's own session and a password verifier, so the
        // next offline login on this device can name them (operatorVault.ts).
        const session = await auth.getSession();
        if (session) {
          try { await saveVaultOperator(user, password, session); }
          catch (vaultError) { console.warn('[Login] Could not save operator vault entry:', vaultError); }
          setOperators(await listVaultOperators());
        }
      }
      await createAuditLog('LOGIN', 'user', user.id, { method: 'password' });

      // Remember this session for biometric sign-in. Deliberately silent on
      // failure: a device without a secure lock screen simply keeps using the
      // password, and an operator mid-shift should not be handed a dialog
      // about keystore configuration.
      if (isAvailable && !tablet) {
        const enrolled = await enableBiometricSignIn(backendRole);
        if (!enrolled.ok) {
          console.info(`[Login] Biometric sign-in not enabled: ${enrolled.reason}`);
        }
      }

      console.info(
        `[StartupTiming] Navigating to dashboard durationMs=${Date.now() - loginStartedAt} t=${Date.now()}`,
      );
      navigation.replace(backendRole === 'admin' ? 'AdminDashboard' : 'OperatorDashboard');
    } catch (error: any) {
      if (selectedRole === 'operator' && /desactivad/i.test(String((error as Error)?.message || ''))) {
        await forgetVaultUsername(trimmedEmail);
        setOperators(await listVaultOperators());
      } else if (selectedRole === 'operator' && isNetworkFailure(error)) {
        const cached = await verifyVaultPassword(trimmedEmail, password).catch(() => null);
        if (cached) {
          try {
            await activateVaultSession(cached);
            await createAuditLog('LOGIN', 'user', cached.id, { method: 'offline-vault' });
            navigation.replace('OperatorDashboard');
            return;
          } catch { /* report the usual login error below */ }
        }
      }
      showSheet('Error', toFriendlyLoginMessage(error, selectedRole));
    } finally {
      setLoading(false);
    }
  };

  const handleBackToRoles = () => {
    setSelectedRole(null);
    setEmail('');
    setPassword('');
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
      keyboardDismissMode="on-drag"
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.brandBlock}>
          <PHCLogo height={64} />
          <Text style={styles.brandName}>PERFORACIONES HIDROGEOLÓGICAS CHACO</Text>
          <View style={styles.rule} />
          <Text style={styles.brandTagline}>Sistema de Gestión de Perforación</Text>
        </View>

        {!selectedRole ? (
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Seleccioná tu acceso</Text>

            {isAvailable && !tablet && (
              <>
                <PHCButton
                  title={`Iniciar con ${getBiometricLabel()}`}
                  variant="secondary"
                  onPress={handleBiometricLogin}
                  disabled={loading}
                />
                <Text style={styles.divider}>o</Text>
              </>
            )}

            <TouchableOpacity style={styles.roleCard} activeOpacity={0.85} onPress={() => handleRoleSelect('admin')}>
              <View style={styles.roleAccent} />
              <View style={styles.roleTextWrap}>
                <Text style={styles.roleTitle}>Administrador</Text>
                <Text style={styles.roleDesc}>Gestión completa del sistema</Text>
              </View>
              <Text style={styles.roleChevron}>›</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.roleCard} activeOpacity={0.85} onPress={() => handleRoleSelect('operator')}>
              <View style={styles.roleAccent} />
              <View style={styles.roleTextWrap}>
                <Text style={styles.roleTitle}>Operador</Text>
                <Text style={styles.roleDesc}>Registro de progreso y materiales</Text>
              </View>
              <Text style={styles.roleChevron}>›</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.panel}>
            <TouchableOpacity style={styles.backButton} onPress={handleBackToRoles}>
              <Text style={styles.backButtonText}>‹ Volver</Text>
            </TouchableOpacity>

            <Text style={styles.panelTitle}>
              {selectedRole === 'admin' ? 'Acceso Administrador' : 'Acceso Operador'}
            </Text>

            <Text style={styles.inputLabel}>{selectedRole === 'admin' ? 'Email' : 'Usuario'}</Text>
            {selectedRole === 'operator' && operators.length > 0 && <View style={styles.quickPicks}>
              <Text style={styles.quickPickTitle}>Operadores de esta tableta</Text>
              {operators.map((operator) => <TouchableOpacity key={operator.id} style={styles.quickPick} onPress={() => setEmail(operator.username)}>
                <Text style={styles.quickPickText}>{operator.fullName || operator.username}</Text>
              </TouchableOpacity>)}
            </View>}
            <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder={selectedRole === 'admin' ? 'admin@ejemplo.com' : 'usuario'}
              placeholderTextColor={COLORS.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              keyboardType={selectedRole === 'admin' ? 'email-address' : 'default'}
            />

            <Text style={styles.inputLabel}>Contraseña</Text>
            <TextInput
              returnKeyType="go"
              onSubmitEditing={() => { Keyboard.dismiss(); if (!loading) void handleLogin(); }}
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={COLORS.placeholder}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />

            <PHCButton
              title={loading ? 'Iniciando…' : 'Iniciar sesión'}
              onPress={handleLogin}
              loading={loading}
              style={{ marginTop: SPACING.xl }}
            />

            <Text style={styles.hint}>Usá las credenciales que te asignó el administrador</Text>
          </View>
        )}

        <Text style={styles.footer}>PHC · Paraguay 2026</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: SPACING.xl, paddingVertical: SPACING.lg },
  brandBlock: { alignItems: 'center', marginBottom: SPACING.xxxl },
  brandName: {
    color: COLORS.textSecondary,
    fontSize: TYPE.micro,
    letterSpacing: 1.6,
    fontWeight: TYPE.semibold,
    marginTop: SPACING.lg,
    textAlign: 'center',
  },
  rule: { width: 44, height: 3, borderRadius: RADIUS.sm, backgroundColor: COLORS.accent, marginVertical: SPACING.md },
  brandTagline: { color: COLORS.text, fontSize: TYPE.body, fontWeight: TYPE.medium },
  panel: {
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.xl,
  },
  panelTitle: {
    color: COLORS.text,
    fontSize: TYPE.title,
    fontWeight: TYPE.bold,
    marginBottom: SPACING.xl,
    textAlign: 'center',
  },
  divider: { color: COLORS.textMuted, textAlign: 'center', marginVertical: SPACING.md },
  roleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceVariant,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.lg,
    marginBottom: SPACING.md,
  },
  roleAccent: { width: 4, height: 40, borderRadius: RADIUS.sm, backgroundColor: COLORS.accent, marginRight: SPACING.lg },
  roleTextWrap: { flex: 1 },
  roleTitle: { color: COLORS.text, fontSize: TYPE.h2, fontWeight: TYPE.bold },
  roleDesc: { color: COLORS.textSecondary, fontSize: TYPE.label, marginTop: SPACING.xs },
  roleChevron: { color: COLORS.primaryText, fontSize: TYPE.h1, fontWeight: TYPE.bold, marginLeft: SPACING.sm },
  backButton: { alignSelf: 'flex-start', marginBottom: SPACING.md },
  backButtonText: { color: COLORS.primaryText, fontSize: TYPE.body, fontWeight: TYPE.semibold },
  inputLabel: { color: COLORS.textSecondary, fontSize: TYPE.label, fontWeight: TYPE.semibold, marginBottom: SPACING.sm },
  input: {
    backgroundColor: COLORS.input,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.lg,
    fontSize: TYPE.h2,
    color: COLORS.text,
    marginBottom: SPACING.lg,
  },
  hint: { color: COLORS.textMuted, fontSize: TYPE.caption, textAlign: 'center', marginTop: SPACING.lg },
  quickPicks: { marginBottom: SPACING.md, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.sm },
  quickPickTitle: { width: '100%', color: COLORS.textSecondary, fontSize: TYPE.caption, fontWeight: TYPE.semibold },
  quickPick: { paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, borderRadius: RADIUS.md, backgroundColor: COLORS.surfaceVariant },
  quickPickText: { color: COLORS.text, fontSize: TYPE.caption },
  footer: { color: COLORS.textMuted, fontSize: TYPE.caption, textAlign: 'center', marginTop: SPACING.xxxl },
});

const isNetworkFailure = (error: unknown): boolean => {
  const message = String((error as any)?.message || error || '');
  return /sin conexi[oó]n|network request failed|failed to fetch|timeout|timed out|aborted|fetch failed/i.test(message)
    || (!(error as any)?.status && !(error as any)?.code && /offlineerror/i.test(String((error as any)?.name || '')));
};

export default LoginScreen;
