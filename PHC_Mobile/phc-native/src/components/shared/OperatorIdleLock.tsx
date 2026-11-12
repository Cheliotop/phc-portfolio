import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus, StyleSheet, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';
import { PHCButton } from './ui';
import { isTablet } from '../../utils/device';
import { verifyVaultPassword } from '../../utils/operatorVault';
import { auth } from '../../api/supabase-auth';
import type { RootStackNavigationProp } from '../../navigation/types';

const IDLE_MS = 10 * 60 * 1000;
const ACTIVE_KEY = 'phc.operatorLastActiveAt';

export const OperatorIdleLock = ({ children }: { children: React.ReactNode }) => {
  const tablet = isTablet();
  const navigation = useNavigation<RootStackNavigationProp<'OperatorDashboard'>>();
  const [locked, setLocked] = useState(false);
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('Operador');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const lastTouch = useRef(Date.now());
  const backgroundAt = useRef<number | null>(null);
  const lockedRef = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const lock = useCallback(async () => {
    if (!tablet || lockedRef.current) return;
    lockedRef.current = true;
    const [[, name], [, user]] = await AsyncStorage.multiGet(['userName', 'userLoginName']);
    setFullName(name || 'Operador');
    setUsername(user || '');
    setPassword('');
    setError('');
    setLocked(true);
  }, [tablet]);

  const touch = useCallback(() => {
    if (!tablet || lockedRef.current) return;
    lastTouch.current = Date.now();
    void AsyncStorage.setItem(ACTIVE_KEY, String(lastTouch.current));
  }, [tablet, locked]);

  useEffect(() => {
    if (!tablet) return;
    void AsyncStorage.getItem(ACTIVE_KEY).then((value) => {
      const last = Number(value);
      if (last && Date.now() - last >= IDLE_MS) void lock();
      else if (!last) void AsyncStorage.setItem(ACTIVE_KEY, String(Date.now()));
    });
    timer.current = setInterval(() => {
      if (Date.now() - lastTouch.current >= IDLE_MS) void lock();
    }, 1000);
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state !== 'active') {
        backgroundAt.current = Date.now();
        void AsyncStorage.setItem(ACTIVE_KEY, String(backgroundAt.current));
      } else {
        if (backgroundAt.current && Date.now() - backgroundAt.current >= IDLE_MS) void lock();
        backgroundAt.current = null;
        lastTouch.current = Date.now();
      }
    });
    return () => { if (timer.current) clearInterval(timer.current); sub.remove(); };
  }, [tablet, lock]);

  const unlock = async () => {
    const operator = await verifyVaultPassword(username, password);
    if (!operator) { setError('Usuario o contraseña incorrectos'); return; }
    if (operator.id !== await AsyncStorage.getItem('userId')) { setError('Este usuario no es quien inició sesión. Cambiá de operador.'); return; }
    setPassword(''); setError(''); lockedRef.current = false; setLocked(false); lastTouch.current = Date.now();
    await AsyncStorage.setItem(ACTIVE_KEY, String(lastTouch.current));
  };

  const switchOperator = async () => {
    await auth.logout({ preserveOfflineSession: true });
    navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
  };

  if (!tablet) return <>{children}</>;
  return (
    <View style={styles.root} onTouchStart={touch}>
      {children}
      {locked && <View style={styles.cover}>
        <View style={styles.panel}>
          <Text style={styles.title}>Tableta bloqueada</Text>
          <Text style={styles.name}>{fullName}</Text>
          <TextInput value={password} onChangeText={setPassword} placeholder="Contraseña" secureTextEntry
            autoCapitalize="none" autoCorrect={false} style={styles.input} returnKeyType="done"
            onSubmitEditing={() => void unlock()} />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <PHCButton title="Desbloquear" onPress={() => void unlock()} style={styles.action} />
          <PHCButton title="Cambiar operador" variant="secondary" onPress={() => void switchOperator()} style={styles.action} />
        </View>
      </View>}
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1 }, cover: { ...StyleSheet.absoluteFillObject, zIndex: 1000, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center', padding: SPACING.xl },
  panel: { width: '100%', maxWidth: 520, backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, padding: SPACING.xl, borderWidth: 1, borderColor: COLORS.border },
  title: { color: COLORS.text, fontSize: TYPE.title, fontWeight: TYPE.bold, textAlign: 'center' }, name: { color: COLORS.textSecondary, fontSize: TYPE.body, textAlign: 'center', marginVertical: SPACING.lg },
  input: { backgroundColor: COLORS.input, color: COLORS.text, borderRadius: RADIUS.md, padding: SPACING.lg, fontSize: TYPE.body, marginBottom: SPACING.md },
  error: { color: COLORS.errorText, marginBottom: SPACING.md }, action: { marginTop: SPACING.sm },
});
