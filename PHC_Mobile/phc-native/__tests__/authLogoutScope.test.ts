import AsyncStorage from '@react-native-async-storage/async-storage';

const mockSignOut = jest.fn(async () => ({ error: null }));
const mockClearBiometric = jest.fn(async () => undefined);
const mockClearLocal = jest.fn(async () => undefined);
jest.mock('../src/api/localSession', () => ({ clearLocalSession: () => mockClearLocal() }));
jest.mock('../src/lib/supabase', () => ({
  __esModule: true,
  default: { auth: { signOut: (...args: unknown[]) => mockSignOut(...args) } },
}));
jest.mock('../src/api/biometricSession', () => ({
  clearBiometricSignIn: () => mockClearBiometric(),
}));
jest.mock('../src/utils/operatorVault', () => ({ forgetVaultOperator: jest.fn(async () => undefined) }));

import { auth } from '../src/api/supabase-auth';

describe('logout keeps the device queue and other sessions', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.multiSet([['userId', 'operator-1'], ['userLoginName', 'ana'], ['userRole', 'operator']]);
  });

  it('signs out this device only, even when the network is down', async () => {
    mockSignOut.mockRejectedValueOnce(new Error('Network request failed'));
    await expect(auth.logout()).resolves.toBeUndefined();
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(await AsyncStorage.getItem('userId')).toBeNull();
    expect(await AsyncStorage.getItem('userLoginName')).toBeNull();
    expect(mockClearBiometric).toHaveBeenCalledTimes(1);
    expect(mockClearLocal).toHaveBeenCalledTimes(1);
  });

  it('clears the active session without revoking the vault token when switching operators', async () => {
    await auth.logout({ preserveOfflineSession: true });
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockClearLocal).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem('userId')).toBeNull();
  });

  it('clears local auth state when GoTrue returns a network error result', async () => {
    mockSignOut.mockResolvedValueOnce({ error: new Error('offline') } as any);
    await auth.logout();
    expect(mockClearLocal).toHaveBeenCalledTimes(1);
  });
});
