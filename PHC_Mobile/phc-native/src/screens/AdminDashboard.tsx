import { useEffect } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { createMaterialTopTabNavigator } from '@react-navigation/material-top-tabs';
import { COLORS, CONTENT_MAX_WIDTH, SPACING, TYPE } from '../theme/phcTheme';
import OperadoresTab from '../components/admin/OperadoresTab';
import CompletionReportsTab from '../components/admin/CompletionReportsTab';
import RejectedWorkTab from '../components/admin/RejectedWorkTab';
import PedidosV2AdminTab from '../components/admin/PedidosV2AdminTab';
import OverviewTab from '../components/admin/OverviewTab';
import ProjectsTab from '../components/admin/ProjectsTab';
import CatalogoTab from '../components/admin/CatalogoTab';
import OperacionTab from '../components/admin/OperacionTab';
import AdminHeader from '../components/admin/AdminHeader';
import { adminSharedStyles } from '../components/admin/adminSharedStyles';
import type { AdminTabParamList } from '../navigation/types';

// v7 requires a concrete navigator ID when strictNullChecks is disabled.
const Tab = createMaterialTopTabNavigator<AdminTabParamList, 'AdminTabs'>();

const AdminDashboard = () => {
  const { width } = useWindowDimensions();
  const isTablet = width >= 600;

  useEffect(() => {
    console.info(`[StartupTiming] AdminDashboard first commit t=${Date.now()}`);
  }, []);

  return (
    <View style={styles.dashboardContainer}>
      <AdminHeader />
      <Tab.Navigator
        id="AdminTabs"
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
          name="Overview"
          component={OverviewTab}
          options={{
            tabBarLabel: 'Resumen', tabBarIcon: ({ color }) => <TabIcon glyph="◷" color={color} tablet={isTablet} />,
          }}
        />
        <Tab.Screen
          name="Projects"
          component={ProjectsTab}
          options={{
            tabBarLabel: 'Proyectos', tabBarIcon: ({ color }) => <TabIcon glyph="⌖" color={color} tablet={isTablet} />,
          }}
        />
        <Tab.Screen
          name="Catalog"
          component={CatalogoTab}
          options={{
            tabBarLabel: 'Catálogo', tabBarIcon: ({ color }) => <TabIcon glyph="▦" color={color} tablet={isTablet} />,
          }}
        />
        <Tab.Screen
          name="Operation"
          component={OperacionTab}
          options={{
            tabBarLabel: 'Operación', tabBarIcon: ({ color }) => <TabIcon glyph="⚙" color={color} tablet={isTablet} />,
          }}
        />
        <Tab.Screen
          name="Operators"
          component={OperadoresTab}
          options={{
            tabBarLabel: 'Operadores', tabBarIcon: ({ color }) => <TabIcon glyph="♙" color={color} tablet={isTablet} />,
          }}
        />
        <Tab.Screen
          name="Requests"
          component={PedidosV2AdminTab}
          options={{
            tabBarLabel: 'Pedidos', tabBarIcon: ({ color }) => <TabIcon glyph="▤" color={color} tablet={isTablet} />,
          }}
        />
        <Tab.Screen
          name="CompletionReports"
          component={CompletionReportsTab}
          options={{
            tabBarLabel: 'Cierres', tabBarIcon: ({ color }) => <TabIcon glyph="✓" color={color} tablet={isTablet} />,
          }}
        />
        <Tab.Screen
          name="RejectedWork"
          component={RejectedWorkTab}
          options={{
            tabBarLabel: 'Revisión', tabBarIcon: ({ color }) => <TabIcon glyph="⌕" color={color} tablet={isTablet} />,
          }}
        />
      </Tab.Navigator>
    </View>
  );
};

const TabIcon = ({ glyph, color, tablet }: { glyph: string; color: string; tablet: boolean }) =>
  tablet ? <Text style={{ color, fontSize: TYPE.body, lineHeight: SPACING.lg }}>{glyph}</Text> : null;

const styles = StyleSheet.create({
  ...adminSharedStyles,
  dashboardContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  tabBar: {
    backgroundColor: COLORS.backgroundDark,
    borderBottomColor: COLORS.border,
    borderBottomWidth: 1,
    height: 48,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
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

export default AdminDashboard;
