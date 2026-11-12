import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator, type StackScreenProps } from '@react-navigation/stack';
import { act, render, waitFor } from '@testing-library/react-native';
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js';
import React from 'react';
import { Text, View } from 'react-native';
import RoleGuard from '../src/navigation/RoleGuard';
import type { RootStackParamList } from '../src/navigation/types';

const mockGetSession = jest.fn();
const mockGetCurrentUser = jest.fn();
const mockLogout = jest.fn();
const mockGetStoredUserId = jest.fn();

jest.mock('../src/api/supabase-auth', () => ({
  auth: {
    getSession: (...args: any[]) => mockGetSession(...args),
    getStoredUserId: (...args: any[]) => mockGetStoredUserId(...args),
    getCurrentUser: (...args: any[]) => mockGetCurrentUser(...args),
    logout: (...args: any[]) => mockLogout(...args),
  },
}));

const Stack = createStackNavigator<RootStackParamList>();

const Login = ({ navigation }: StackScreenProps<RootStackParamList, 'Login'>) => (
  <View>
    <Text>Login real</Text>
    <Text>{navigation.canGoBack() ? 'Con historial' : 'Sin historial'}</Text>
  </View>
);

const Admin = () => (
  <RoleGuard requiredRole="admin">
    <Text>Panel admin protegido</Text>
  </RoleGuard>
);

const Operator = () => (
  <RoleGuard requiredRole="operator">
    <Text>Panel operador protegido</Text>
  </RoleGuard>
);

const renderNavigator = (initialRouteName: keyof RootStackParamList) => render(
  <NavigationContainer>
    <Stack.Navigator initialRouteName={initialRouteName} screenOptions={{ animationEnabled: false }}>
      <Stack.Screen name="Login" component={Login} />
      <Stack.Screen name="AdminDashboard" component={Admin} />
      <Stack.Screen name="OperatorDashboard" component={Operator} />
    </Stack.Navigator>
  </NavigationContainer>,
);

describe('real dashboard role guards', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    mockLogout.mockResolvedValue(undefined);
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: true, isInternetReachable: true });
  });

  it('mounts the admin dashboard only for an active admin profile', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'admin-1' } });
    mockGetCurrentUser.mockResolvedValue({ id: 'admin-1', role: 'admin', is_active: true });

    const { getByText } = renderNavigator('AdminDashboard');

    await waitFor(() => expect(getByText('Panel admin protegido')).toBeTruthy());
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it('mounts the operator dashboard only for an active operator profile', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'operator-1' } });
    mockGetCurrentUser.mockResolvedValue({ id: 'operator-1', role: 'operator', is_active: true });

    const { getByText } = renderNavigator('OperatorDashboard');

    await waitFor(() => expect(getByText('Panel operador protegido')).toBeTruthy());
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it('signs out a wrong-role user and resets to Login without back history', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'operator-1' } });
    mockGetCurrentUser.mockResolvedValue({ id: 'operator-1', role: 'operator', is_active: true });

    const { getByText } = renderNavigator('AdminDashboard');

    await waitFor(() => expect(getByText('Login real')).toBeTruthy());
    expect(getByText('Sin historial')).toBeTruthy();
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it('rejects a deactivated profile', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'operator-1' } });
    mockGetCurrentUser.mockResolvedValue({ id: 'operator-1', role: 'operator', is_active: false });

    const { getByText } = renderNavigator('OperatorDashboard');

    await waitFor(() => expect(getByText('Login real')).toBeTruthy());
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing Supabase session before checking a profile', async () => {
    mockGetSession.mockResolvedValue(null);

    const { getByText } = renderNavigator('OperatorDashboard');

    await waitFor(() => expect(getByText('Login real')).toBeTruthy());
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  describe('when the server cannot confirm the session', () => {
    const rememberOperator = () => AsyncStorage.multiSet([
      ['userRole', 'operator'],
      ['userId', 'operator-1'],
    ]);

    beforeEach(() => {
      mockGetSession.mockResolvedValue({ user: { id: 'operator-1' } });
      mockGetStoredUserId.mockResolvedValue('operator-1');
    });

    it('keeps a known user working when the phone reports no connection', async () => {
      await rememberOperator();
      mockGetCurrentUser.mockRejectedValue(new Error('Network request failed'));
      (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: false, isInternetReachable: false });

      const { getByText } = renderNavigator('OperatorDashboard');

      await waitFor(() => expect(getByText('Panel operador protegido')).toBeTruthy());
      expect(mockLogout).not.toHaveBeenCalled();
    });

    // Audit test 21: the phone shows full signal, the API is down.
    it('keeps a known user working when the API is down but the phone shows signal', async () => {
      await rememberOperator();
      mockGetCurrentUser.mockRejectedValue(new Error('Sin conexión.'));

      const { getByText } = renderNavigator('OperatorDashboard');

      await waitFor(() => expect(getByText('Panel operador protegido')).toBeTruthy());
      expect(mockLogout).not.toHaveBeenCalled();
    });

    it('keeps a known user working when an expired token cannot be refreshed', async () => {
      await rememberOperator();
      mockGetSession.mockRejectedValue(new AuthRetryableFetchError('Sin conexión.', 0));

      const { getByText } = renderNavigator('OperatorDashboard');

      await waitFor(() => expect(getByText('Panel operador protegido')).toBeTruthy());
      expect(mockGetCurrentUser).not.toHaveBeenCalled();
      expect(mockLogout).not.toHaveBeenCalled();
    });

    it('keeps a known user working through a server error', async () => {
      await rememberOperator();
      mockGetCurrentUser.mockRejectedValue(new AuthApiError('boom', 500, 'unexpected_failure'));

      const { getByText } = renderNavigator('OperatorDashboard');

      await waitFor(() => expect(getByText('Panel operador protegido')).toBeTruthy());
      expect(mockLogout).not.toHaveBeenCalled();
    });

    it('does not open the dashboard when the last verified role is a different one', async () => {
      await rememberOperator();
      mockGetStoredUserId.mockResolvedValue('admin-1');
      await AsyncStorage.multiSet([['userRole', 'admin'], ['userId', 'admin-1']]);
      mockGetCurrentUser.mockRejectedValue(new Error('Sin conexión.'));

      const { getByText, queryByText } = renderNavigator('OperatorDashboard');

      await waitFor(() => expect(getByText('Login real')).toBeTruthy());
      expect(queryByText('Panel operador protegido')).toBeNull();
      // The session is left alone: nothing says it is bad, and the login screen
      // cannot replace it until the server is back.
      expect(mockLogout).not.toHaveBeenCalled();
    });

    it('does not open the dashboard when the saved session belongs to someone else', async () => {
      await rememberOperator();
      mockGetStoredUserId.mockResolvedValue('operator-2');
      mockGetCurrentUser.mockRejectedValue(new Error('Sin conexión.'));

      const { getByText } = renderNavigator('OperatorDashboard');

      await waitFor(() => expect(getByText('Login real')).toBeTruthy());
      expect(mockLogout).not.toHaveBeenCalled();
    });

    it('signs out when the auth server rejects the session', async () => {
      await rememberOperator();
      mockGetCurrentUser.mockRejectedValue(new AuthApiError('invalid JWT', 403, 'bad_jwt'));

      const { getByText } = renderNavigator('OperatorDashboard');

      await waitFor(() => expect(getByText('Login real')).toBeTruthy());
      expect(mockLogout).toHaveBeenCalledTimes(1);
    });

    it('signs out when the session has been revoked', async () => {
      await rememberOperator();
      mockGetCurrentUser.mockRejectedValue(new AuthSessionMissingError());

      const { getByText } = renderNavigator('OperatorDashboard');

      await waitFor(() => expect(getByText('Login real')).toBeTruthy());
      expect(mockLogout).toHaveBeenCalledTimes(1);
    });

    it('signs out when the profile row no longer exists', async () => {
      await rememberOperator();
      mockGetCurrentUser.mockRejectedValue({ code: 'PGRST116', message: 'no rows' });

      const { getByText } = renderNavigator('OperatorDashboard');

      await waitFor(() => expect(getByText('Login real')).toBeTruthy());
      expect(mockLogout).toHaveBeenCalledTimes(1);
    });

    describe('on a link too slow to answer', () => {
      beforeEach(() => jest.useFakeTimers());
      afterEach(() => jest.useRealTimers());

      it('opens the dashboard for a known user, and a later rejection still applies', async () => {
        await rememberOperator();
        let rejectCheck: (error: unknown) => void = () => undefined;
        mockGetCurrentUser.mockReturnValue(new Promise((_, reject) => { rejectCheck = reject; }));

        const { getByText, queryByText } = renderNavigator('OperatorDashboard');

        await act(async () => { await jest.advanceTimersByTimeAsync(1_000); });
        expect(queryByText('Panel operador protegido')).toBeNull();

        await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });
        expect(getByText('Panel operador protegido')).toBeTruthy();
        expect(mockLogout).not.toHaveBeenCalled();

        await act(async () => {
          rejectCheck(new AuthApiError('invalid JWT', 403, 'bad_jwt'));
          await jest.advanceTimersByTimeAsync(1_000);
        });
        expect(getByText('Login real')).toBeTruthy();
        expect(mockLogout).toHaveBeenCalledTimes(1);
      });

      it('keeps an unknown user waiting rather than opening the dashboard', async () => {
        mockGetCurrentUser.mockReturnValue(new Promise(() => undefined));

        const { queryByText } = renderNavigator('OperatorDashboard');

        await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
        expect(queryByText('Panel operador protegido')).toBeNull();
      });
    });
  });
});
