import React, { useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { queryClient } from './src/api/queryClient';
import { ThemeProvider, useTheme } from './src/hooks/useTheme';
import CleanupScreen from './src/components/CleanupScreen';
import LoginScreen from './src/screens/LoginScreen';
import OperatorDashboard from './src/screens/OperatorDashboard';
import AdminDashboard from './src/screens/AdminDashboard';
import { SyncStatusIndicator } from './src/components/shared/SyncStatusIndicator';
import { ErrorBoundary } from './src/components/shared/ErrorBoundary';
import { SheetHost } from './src/components/shared/Sheet';
import { enableLayoutAnimation } from './src/utils/motion';
import { installCrashReporting } from './src/utils/crashReport';
import { installShiftCutoffWatch } from './src/sync/shiftCutoff';
import RoleGuard from './src/navigation/RoleGuard';
import { useSessionRestore, type InitialRoute } from './src/hooks/useSessionRestore';
import type { RootStackParamList } from './src/navigation/types';

// v7 requires a concrete navigator ID when strictNullChecks is disabled.
const Stack = createStackNavigator<RootStackParamList, 'RootStack'>();

const GuardedOperatorDashboard = () => (
  <RoleGuard requiredRole="operator">
    <OperatorDashboard />
  </RoleGuard>
);

const GuardedAdminDashboard = () => (
  <RoleGuard requiredRole="admin">
    <AdminDashboard />
  </RoleGuard>
);

const AppNavigator = ({ initialRoute }: { initialRoute: InitialRoute }) => {
  const { theme } = useTheme();

  return (
    <>
      <StatusBar style={theme.isDark ? 'light' : 'dark'} backgroundColor={theme.colors.background} />
      <Stack.Navigator
        id="RootStack"
        initialRouteName={initialRoute}
        screenOptions={{
          headerShown: false,
          cardStyle: { backgroundColor: theme.colors.background }
        }}
      >
        <Stack.Screen name="Login" component={LoginScreen} />
        <Stack.Screen name="OperatorDashboard" component={GuardedOperatorDashboard} />
        <Stack.Screen name="AdminDashboard" component={GuardedAdminDashboard} />
      </Stack.Navigator>
    </>
  );
};

const AppContent = () => {
  const [isCleanupComplete, setIsCleanupComplete] = useState(false);
  const { checking, initialRoute } = useSessionRestore();

  const handleCleanupComplete = () => {
    console.log('✅ Cleanup completed, showing main app');
    setIsCleanupComplete(true);
  };

  // The session check runs alongside cleanup rather than after it, so restoring
  // a session costs no extra startup time. Holding the navigator until both are
  // done also avoids mounting Login and then replacing it, which would show the
  // operator a login form flashing past on every launch.
  if (!isCleanupComplete || checking) {
    return <CleanupScreen onComplete={handleCleanupComplete} />;
  }

  return <AppNavigator initialRoute={initialRoute} />;
};

// Android ignores LayoutAnimation unless this is set, which is why the app
// never animated despite the API being available all along.
enableLayoutAnimation();

// Global JS error and unhandled-rejection reporting, plus sending queued
// reports at startup and when the network returns. Registered here, at module
// load, so it runs before the first screen.
installCrashReporting();
// The 12-hour shift cutoff also runs whenever the app comes to the foreground.
installShiftCutoffWatch();

export default function App() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NavigationContainer>
            {/* Without this, any uncaught render error unmounts the whole tree and
                the operator gets a blank screen with no message and no way back —
                in the field, offline, with nobody to call. The boundary shows a
                Spanish error card with a retry that re-renders AppContent. */}
            <ErrorBoundary>
              <AppContent />
            </ErrorBoundary>
            {/* Outside the boundary on purpose: the sheet is how the app talks
                to the user, so it has to still work on the screen that appears
                when everything else has failed. */}
            <SheetHost />
          </NavigationContainer>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
