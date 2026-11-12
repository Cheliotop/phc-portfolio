import React, { useState, useEffect, useContext } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { createMaterialTopTabNavigator } from '@react-navigation/material-top-tabs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import NetInfo from '@react-native-community/netinfo';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { COLORS, CONTENT_MAX_WIDTH, RADIUS, SPACING, TYPE } from '../theme/phcTheme';
import PHCLogo from '../components/shared/PHCLogo';
import { SyncStatusIndicator, SyncQueueModal } from '../components/shared/SyncStatusIndicator';
import { auditLogout } from '../utils/auditLog';
import { drainOutbox } from '../sync/drainCoordinator';
import { countRejectedOutboxRows, countUnsentOutboxRows } from '../sync/outboxOwner';
import { auth } from '../api/supabase-auth';
import type { OperatorTabParamList, RootStackNavigationProp } from '../navigation/types';
import TurnosTab from '../components/operator/TurnosTab';
import PozosTab from '../components/operator/PozosTab';
import ProgresoTab from '../components/operator/ProgresoTab';
import MaterialesTab from '../components/operator/MaterialesTab';
import PedidosV2Tab from '../components/operator/PedidosV2Tab';
import WaterSamplesTab from '../components/operator/WaterSamplesTab';
import FichaTecnicaTab from '../components/operator/FichaTecnicaTab';
import { notifyOperatorDataChanged } from '../events/operatorDataEvents';
import { showSheet } from '../components/shared/Sheet';
import { OperatorIdleLock } from '../components/shared/OperatorIdleLock';

// v7 requires a concrete navigator ID when strictNullChecks is disabled.
const Tab = createMaterialTopTabNavigator<OperatorTabParamList, 'OperatorTabs'>();

const OperatorHeader = () => {
  const navigation = useNavigation<RootStackNavigationProp<'OperatorDashboard'>>();
  const [userName, setUserName] = useState('');
  const [showSyncModal, setShowSyncModal] = useState(false);

  useEffect(() => {
    loadUserName();
  }, []);

  const loadUserName = async () => {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 500;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const name = await AsyncStorage.getItem('userName');
        setUserName(name || 'Operador');
        return;
      } catch (error: any) {
        console.error(`[PHC] Error loading user name (attempt ${attempt}):`, error);

        if (attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
          continue;
        }

        setUserName('Operador');
      }
    }
  };

  const handleLogout = async () => {
    // Queued work stays on the phone and uploads only under this account (see
    // sync/outboxOwner.ts), so say so before the operator walks away from it.
    const unsent = await countUnsentOutboxRows().catch(() => 0);
    const rejected = await countRejectedOutboxRows().catch(() => 0);
    const warnings = [
      unsent > 0
        ? `Tenés ${unsent} registro(s) sin subir. Quedan guardados en el dispositivo y se subirán cuando haya conexión, a nombre de quien los cargó.`
        : null,
      rejected > 0
        ? `El servidor rechazó ${rejected} registro(s). Quedan guardados para que el administrador los revise.`
        : null,
    ].filter(Boolean);
    showSheet(
      'Cerrar Sesión',
      warnings.length > 0
        ? `${warnings.join(' ')} ¿Cerrar sesión igual?`
        : '¿Estás seguro de que querés cerrar sesión?',
      [
        {
          text: 'Cancelar',
          style: 'cancel',
        },
        {
          text: 'Sí, cerrar',
          style: 'destructive',
          onPress: async () => {
            const operatorId = await AsyncStorage.getItem('operatorId') || 'unknown';
            try {
              await auditLogout(operatorId);
              await auth.logout();
            } catch (error) {
              console.error('[PHC] Error logging out:', error);
            } finally {
              navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
            }
          },
        },
      ]
    );
  };

  const handleSwitchOperator = () => {
    showSheet('Cambiar operador', '¿Querés cerrar tu sesión para que otra persona ingrese en esta tableta?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Cambiar operador', onPress: async () => {
        await auth.logout({ preserveOfflineSession: true });
        navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
      } },
    ]);
  };

  return (
    <View style={styles.header}>
      <View style={styles.headerLeft}>
        <PHCLogo height={28} />
        <View style={styles.headerText}>
          <Text style={styles.headerTitle} numberOfLines={1}>{userName || 'Operador'}</Text>
          <Text style={styles.headerSubtitle}>Panel de Operador</Text>
        </View>
      </View>
      <View style={styles.headerRight}>
        <TouchableOpacity style={styles.switchButton} onPress={handleSwitchOperator}>
          <Text style={styles.switchButtonText}>Cambiar operador</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.headerButton} onPress={() => setShowSyncModal(true)}>
          <SyncStatusIndicator showCount={true} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <Text style={styles.logoutButtonText}>Salir</Text>
        </TouchableOpacity>
      </View>
      <SyncQueueModal visible={showSyncModal} onClose={() => setShowSyncModal(false)} />
    </View>
  );
};

const OperatorDashboard = () => {
  const { width } = useWindowDimensions();
  const insets = useContext(SafeAreaInsetsContext);
  const isTablet = width >= 600;

  useEffect(() => {
    let syncing = false;

    const runSync = async () => {
      if (syncing) {
        return;
      }

      // isInternetReachable is null while NetInfo is still probing; only a
      // definite "no internet" (connected to a cell/Wi-Fi with no data, common
      // at a rig) skips the drain, so attempts are not wasted on a dead link.
      const state = await NetInfo.fetch();
      if (!state.isConnected || state.isInternetReachable === false) {
        return;
      }

      syncing = true;
      try {
        // drainOutbox owns the phase ordering (shift -> bars -> close package
        // -> reports/pedidos/samples) and a module-level in-flight lock, so a
        // reconnect firing while the 30s interval is mid-drain cannot run two
        // drains over the same outbox at once.
        const result = await drainOutbox();
        if (result.synced > 0) {
          notifyOperatorDataChanged();
        }
      } catch (error) {
        console.warn('[PHC] Background sync failed:', error);
      } finally {
        syncing = false;
      }
    };

    runSync();
    const interval = setInterval(runSync, 30000);
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) {
        runSync();
      }
    });

    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, []);

  return (
    <OperatorIdleLock>
    <View style={[styles.container, {
      // Edge-to-edge Android tablets draw their taskbar over the app window.
      // Reserve that area for every tab, including the pinned Ficha controls.
      paddingBottom: insets?.bottom ?? 0,
      paddingLeft: insets?.left ?? 0,
      paddingRight: insets?.right ?? 0,
    }]}>
      <OperatorHeader />
      <Tab.Navigator
        id="OperatorTabs"
        screenOptions={{
          lazy: true,
          tabBarStyle: [styles.tabBar, isTablet && styles.tabletTabBar],
          tabBarActiveTintColor: COLORS.accent,
          tabBarInactiveTintColor: COLORS.textSecondary,
          tabBarLabelStyle: [styles.tabBarLabel, isTablet && styles.tabletTabBarLabel],
          tabBarShowIcon: isTablet,
          tabBarItemStyle: isTablet ? styles.tabletTabBarItem : undefined,
          tabBarScrollEnabled: !isTablet,
          sceneStyle: styles.contentScene,
          tabBarIndicatorStyle: { backgroundColor: COLORS.accent, height: 3 },
        }}
      >
        <Tab.Screen
          name="Turnos"
          component={TurnosTab}
          options={{
            tabBarLabel: 'Turnos', tabBarIcon: ({ color }) => <TabIcon glyph="◷" color={color} tablet={isTablet} />,
          }}
        />
        <Tab.Screen
          name="Pozos"
          component={PozosTab}
          options={{
            tabBarLabel: 'Pozos', tabBarIcon: ({ color }) => <TabIcon glyph="⌖" color={color} tablet={isTablet} />,
          }}
        />
        <Tab.Screen
          name="Progreso"
          component={ProgresoTab}
          options={{
            tabBarLabel: 'Progreso', tabBarIcon: ({ color }) => <TabIcon glyph="↗" color={color} tablet={isTablet} />,
          }}
        />
        <Tab.Screen
          name="Materiales"
          component={MaterialesTab}
          options={{
            tabBarLabel: 'Materiales', tabBarIcon: ({ color }) => <TabIcon glyph="▦" color={color} tablet={isTablet} />,
          }}
        />
        <Tab.Screen
          name="Pedidos"
          component={PedidosV2Tab}
          options={{
            tabBarLabel: 'Pedidos', tabBarIcon: ({ color }) => <TabIcon glyph="▤" color={color} tablet={isTablet} />,
          }}
        />
        <Tab.Screen
          name="Muestras"
          component={WaterSamplesTab}
          options={{
            tabBarLabel: 'Muestras', tabBarIcon: ({ color }) => <TabIcon glyph="◉" color={color} tablet={isTablet} />,
          }}
        />
        <Tab.Screen
          name="Cierre"
          component={FichaTecnicaTab}
          options={{
            tabBarLabel: 'Cierre', tabBarIcon: ({ color }) => <TabIcon glyph="✓" color={color} tablet={isTablet} />,
          }}
        />
      </Tab.Navigator>
    </View>
    </OperatorIdleLock>
  );
};

const TabIcon = ({ glyph, color, tablet }: { glyph: string; color: string; tablet: boolean }) =>
  tablet ? <Text style={{ color, fontSize: TYPE.body, lineHeight: SPACING.lg }}>{glyph}</Text> : null;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    paddingTop: SPACING.huge2,
    paddingBottom: SPACING.md,
    paddingHorizontal: SPACING.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.appBar,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerText: {
    marginLeft: SPACING.md,
    flexShrink: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: TYPE.body,
    fontWeight: TYPE.bold,
    color: COLORS.text,
  },
  headerSubtitle: {
    fontSize: TYPE.caption,
    marginTop: SPACING.xs,
    color: COLORS.textSecondary,
  },
  headerButton: { minHeight: 48, justifyContent: 'center',
    padding: SPACING.sm,
    marginRight: SPACING.sm,
  },
  switchButton: { minHeight: 48, justifyContent: 'center', paddingHorizontal: SPACING.sm, marginRight: SPACING.xs },
  switchButtonText: { color: COLORS.primaryText, fontSize: TYPE.caption, fontWeight: TYPE.semibold },
  logoutButton: { minHeight: 48, justifyContent: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  logoutButtonText: {
    fontWeight: TYPE.semibold,
    fontSize: TYPE.caption,
    color: COLORS.textSecondary,
  },
  tabBar: {
    backgroundColor: COLORS.backgroundDark,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    height: 48,
    elevation: 4,
  },
  tabletTabBar: { height: 60 },
  tabletTabBarItem: { flex: 1, minWidth: 0, paddingHorizontal: SPACING.none },
  tabletTabBarLabel: { fontSize: TYPE.micro, lineHeight: SPACING.md },
  contentScene: { flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' },
  tabBarLabel: {
    fontSize: TYPE.caption,
    fontWeight: TYPE.bold,
    textTransform: 'none',
  },
});

export default OperatorDashboard;
