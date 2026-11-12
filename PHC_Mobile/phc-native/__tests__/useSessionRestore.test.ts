/**
 * The navigator hard-coded `initialRouteName="Login"`, so every cold start
 * showed the login form even with a valid session in storage. Android reclaims
 * a backgrounded app aggressively — switching apps and coming back is enough —
 * so an operator was retyping their password to return to a screen they never
 * left.
 *
 * The case that matters most is the offline one: `getSession()` returns the
 * stored session when the refresh cannot reach the network, and the operator
 * must get back to work. It returns null only when the refresh token is gone or
 * rejected, which is the one situation where logging in again is the answer.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { renderHook, waitFor } from '@testing-library/react-native';

const mockGetStoredUserId = jest.fn();

jest.mock('../src/api/supabase-auth', () => ({
  auth: { getStoredUserId: () => mockGetStoredUserId() },
}));

import { useSessionRestore } from '../src/hooks/useSessionRestore';

describe('useSessionRestore', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    mockGetStoredUserId.mockResolvedValue('op-1');
  });

  const restore = async () => {
    const view = renderHook(() => useSessionRestore());
    await waitFor(() => expect(view.result.current.checking).toBe(false));
    return view.result.current.initialRoute;
  };

  it('returns an operator to their dashboard', async () => {
    await AsyncStorage.setItem('userRole', 'operator');
    expect(await restore()).toBe('OperatorDashboard');
  });

  it('returns an admin to theirs', async () => {
    await AsyncStorage.setItem('userRole', 'admin');
    expect(await restore()).toBe('AdminDashboard');
  });

  it('shows the login screen when no session is saved', async () => {
    await AsyncStorage.setItem('userRole', 'operator');
    mockGetStoredUserId.mockResolvedValue(null);
    expect(await restore()).toBe('Login');
  });

  it('shows the login screen after Salir', async () => {
    // logout() clears userRole, so a deliberate sign-out is never undone by a
    // stale entry left in the auth store.
    expect(await restore()).toBe('Login');
  });

  it('ignores a role that is not a real role', async () => {
    await AsyncStorage.setItem('userRole', 'superuser');
    expect(await restore()).toBe('Login');
  });

  it('never throws, and falls back to Login, when storage is broken', async () => {
    // This runs before the navigator mounts. An exception here is a white
    // screen with no way back.
    const original = AsyncStorage.getItem;
    (AsyncStorage as { getItem: unknown }).getItem = jest.fn().mockRejectedValue(new Error('gone'));
    try {
      expect(await restore()).toBe('Login');
    } finally {
      (AsyncStorage as { getItem: unknown }).getItem = original;
    }
  });

  it('falls back to Login when the auth store itself throws', async () => {
    await AsyncStorage.setItem('userRole', 'operator');
    mockGetStoredUserId.mockRejectedValue(new Error('auth unavailable'));
    expect(await restore()).toBe('Login');
  });
});
