import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';
import { auth } from '../src/api/supabase-auth';
import LoginScreen from '../src/screens/LoginScreen';
import { createAuditLog } from '../src/utils/auditLog';
import NetInfo from '@react-native-community/netinfo';

const mockIsTablet = jest.fn(() => false);
const mockSaveVault = jest.fn();
const mockVerifyVault = jest.fn();
const mockActivateVault = jest.fn();
const mockListVault = jest.fn(async () => []);
const mockForgetVaultUsername = jest.fn();
jest.mock('../src/utils/device', () => ({ isTablet: () => mockIsTablet() }));
jest.mock('../src/utils/operatorVault', () => ({
  saveVaultOperator: (...args: unknown[]) => mockSaveVault(...args),
  verifyVaultPassword: (...args: unknown[]) => mockVerifyVault(...args),
  activateVaultSession: (...args: unknown[]) => mockActivateVault(...args),
  listVaultOperators: (...args: unknown[]) => mockListVault(...args),
  forgetVaultUsername: (...args: unknown[]) => mockForgetVaultUsername(...args),
}));

const mockShowSheet = jest.fn();
jest.mock('../src/components/shared/Sheet', () => ({
  showSheet: (...args: unknown[]) => mockShowSheet(...args),
  SheetHost: () => null,
}));


const mockReplace = jest.fn();
const mockAuthenticate = jest.fn();
const mockGetBiometricLabel = jest.fn(() => 'huella');
let mockBiometricAvailable = false;
const mockRefreshSession = jest.fn();
const mockGetSession = jest.fn(async () => ({ data: { session: null } }));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ replace: mockReplace }),
}));

// Biometric sign-in trades a stored refresh token for a live session, so the
// auth client has to be reachable from this screen's tests.
jest.mock('../src/lib/supabase', () => ({
  __esModule: true,
  default: {
    auth: {
      refreshSession: (...args: unknown[]) => mockRefreshSession(...args),
      getSession: (...args: unknown[]) => mockGetSession(...args),
    },
  },
}));

jest.mock('../src/api/supabase-auth', () => ({
  auth: {
    login: jest.fn(),
    logout: jest.fn(),
    getCurrentUser: jest.fn(),
    getSession: jest.fn(async () => ({ user: { id: 'admin-1' } })),
    rememberSignedInUser: jest.fn(async () => undefined),
  },
}));

jest.mock('../src/sync/outboxOwner', () => ({
  claimOutbox: jest.fn(async () => ({ ok: true, unsent: 0 })),
}));

jest.mock('../src/utils/auditLog', () => ({
  createAuditLog: jest.fn(async () => undefined),
}));

jest.mock('../src/hooks/useBiometricAuth', () => ({
  useBiometricAuth: () => ({
    isAvailable: mockBiometricAvailable,
    authenticate: mockAuthenticate,
    getBiometricLabel: mockGetBiometricLabel,
  }),
}));

const mockAlert = mockShowSheet;
const mockLogin = auth.login as jest.MockedFunction<typeof auth.login>;
const mockLogout = auth.logout as jest.MockedFunction<typeof auth.logout>;
const mockGetCurrentUser = auth.getCurrentUser as jest.MockedFunction<typeof auth.getCurrentUser>;
const mockCreateAuditLog = createAuditLog as jest.MockedFunction<typeof createAuditLog>;

describe('LoginScreen', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockBiometricAvailable = false;
    mockIsTablet.mockReturnValue(false);
    mockVerifyVault.mockResolvedValue(null);
    mockActivateVault.mockResolvedValue(undefined);
    mockSaveVault.mockResolvedValue(undefined);
    mockForgetVaultUsername.mockResolvedValue(undefined);
    mockListVault.mockResolvedValue([]);
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: true, isInternetReachable: true });
    mockAuthenticate.mockResolvedValue({ success: false });
    mockLogout.mockResolvedValue(undefined);
    await AsyncStorage.clear();
  });

  it('shows the current role selection', () => {
    const { getByText, queryByText } = render(<LoginScreen />);

    expect(getByText('Seleccioná tu acceso')).toBeTruthy();
    expect(getByText('Administrador')).toBeTruthy();
    expect(getByText('Operador')).toBeTruthy();
    expect(queryByText('Iniciar con huella')).toBeNull();
  });

  it('shows the role-specific credential forms', () => {
    const admin = render(<LoginScreen />);
    fireEvent.press(admin.getByText('Administrador'));
    expect(admin.getByText('Acceso Administrador')).toBeTruthy();
    expect(admin.getByPlaceholderText('admin@ejemplo.com')).toBeTruthy();
    admin.unmount();

    const operator = render(<LoginScreen />);
    fireEvent.press(operator.getByText('Operador'));
    expect(operator.getByText('Acceso Operador')).toBeTruthy();
    expect(operator.getByPlaceholderText('usuario')).toBeTruthy();
  });

  it('asks an operator for their usuario, in vos', () => {
    const { getByText, getByPlaceholderText, queryByText } = render(<LoginScreen />);

    fireEvent.press(getByText('Operador'));
    fireEvent.press(getByText('Iniciar sesión'));
    expect(mockAlert).toHaveBeenLastCalledWith('Error', 'Ingresá tu usuario');
    expect(queryByText(/email/i)).toBeNull();

    fireEvent.changeText(getByPlaceholderText('usuario'), 'operador');
    fireEvent.press(getByText('Iniciar sesión'));
    expect(mockAlert).toHaveBeenLastCalledWith('Error', 'Ingresá tu contraseña');
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it('validates email and password before calling Supabase auth', () => {
    const { getByText, getByPlaceholderText } = render(<LoginScreen />);

    fireEvent.press(getByText('Administrador'));
    fireEvent.press(getByText('Iniciar sesión'));
    expect(mockAlert).toHaveBeenLastCalledWith('Error', 'Ingresá tu email');

    fireEvent.changeText(getByPlaceholderText('admin@ejemplo.com'), 'admin@phc.test');
    fireEvent.press(getByText('Iniciar sesión'));
    expect(mockAlert).toHaveBeenLastCalledWith('Error', 'Ingresá tu contraseña');
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it('logs an admin in with the entered email and replaces the route', async () => {
    mockLogin.mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@phc.test', role: 'admin', is_active: true },
    });
    const { getByText, getByPlaceholderText } = render(<LoginScreen />);

    fireEvent.press(getByText('Administrador'));
    fireEvent.changeText(getByPlaceholderText('admin@ejemplo.com'), '  admin@phc.test  ');
    fireEvent.changeText(getByPlaceholderText('••••••••'), 'secret');
    fireEvent.press(getByText('Iniciar sesión'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('AdminDashboard'));
    expect(mockLogin).toHaveBeenCalledWith('admin@phc.test', 'secret');
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      'LOGIN',
      'user',
      'admin-1',
      { method: 'password' },
    );
  });

  it('maps a bare operator username to its internal Supabase email', async () => {
    mockLogin.mockResolvedValue({
      user: { id: 'operator-1', username: 'operador_qa', role: 'operator', is_active: true },
    });
    const { getByText, getByPlaceholderText } = render(<LoginScreen />);

    fireEvent.press(getByText('Operador'));
    fireEvent.changeText(getByPlaceholderText('usuario'), '  Operador_QA  ');
    fireEvent.changeText(getByPlaceholderText('••••••••'), 'secret');
    fireEvent.press(getByText('Iniciar sesión'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('OperatorDashboard'));
    expect(mockLogin).toHaveBeenCalledWith('operador_qa@phc.local', 'secret');
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      'LOGIN',
      'user',
      'operator-1',
      { method: 'password' },
    );
  });

  it('signs out and blocks an operator submitted through the admin form', async () => {
    mockLogin.mockResolvedValue({
      user: { id: 'operator-1', role: 'operator', is_active: true },
    });
    const { getByText, getByPlaceholderText } = render(<LoginScreen />);

    fireEvent.press(getByText('Administrador'));
    fireEvent.changeText(getByPlaceholderText('admin@ejemplo.com'), 'operator@phc.local');
    fireEvent.changeText(getByPlaceholderText('••••••••'), 'secret');
    fireEvent.press(getByText('Iniciar sesión'));

    await waitFor(() => {
      expect(mockAlert).toHaveBeenCalledWith(
        'Acceso denegado',
        'Este usuario no tiene permisos de administrador',
      );
    });
    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it('shows the friendly Supabase invalid-login message', async () => {
    mockLogin.mockRejectedValue(new Error('Invalid login credentials'));
    const { getByText, getByPlaceholderText } = render(<LoginScreen />);

    fireEvent.press(getByText('Operador'));
    fireEvent.changeText(getByPlaceholderText('usuario'), 'operador');
    fireEvent.changeText(getByPlaceholderText('••••••••'), 'wrong');
    fireEvent.press(getByText('Iniciar sesión'));

    await waitFor(() => {
      expect(mockAlert).toHaveBeenCalledWith('Error', 'Usuario o contraseña incorrectos');
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('signs in from the vault offline and rejects a wrong password', async () => {
    mockIsTablet.mockReturnValue(true);
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: false, isInternetReachable: false });
    mockVerifyVault.mockResolvedValue({ id: 'operator-1', username: 'operador', fullName: 'Operador QA', role: 'operator' });
    const success = render(<LoginScreen />);
    fireEvent.press(success.getByText('Operador'));
    fireEvent.changeText(success.getByPlaceholderText('usuario'), 'operador');
    fireEvent.changeText(success.getByPlaceholderText('••••••••'), 'correcta');
    fireEvent.press(success.getByText('Iniciar sesión'));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('OperatorDashboard'));
    expect(mockActivateVault).toHaveBeenCalledWith(expect.objectContaining({ id: 'operator-1' }));
    expect(mockLogin).not.toHaveBeenCalled();
    success.unmount();

    jest.clearAllMocks();
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: false, isInternetReachable: false });
    mockVerifyVault.mockResolvedValue(null);
    const failure = render(<LoginScreen />);
    fireEvent.press(failure.getByText('Operador'));
    fireEvent.changeText(failure.getByPlaceholderText('usuario'), 'operador');
    fireEvent.changeText(failure.getByPlaceholderText('••••••••'), 'incorrecta');
    fireEvent.press(failure.getByText('Iniciar sesión'));
    await waitFor(() => expect(mockAlert).toHaveBeenCalledWith('Error', 'Usuario o contraseña incorrectos'));
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('saves the operator vault entry after an online operator login', async () => {
    mockLogin.mockResolvedValue({
      user: { id: 'operator-1', username: 'operador', full_name: 'Operador QA', role: 'operator', is_active: true },
    });
    (auth.getSession as jest.Mock).mockResolvedValueOnce({ user: { id: 'operator-1' }, access_token: 'a' });
    const { getByText, getByPlaceholderText } = render(<LoginScreen />);

    fireEvent.press(getByText('Operador'));
    fireEvent.changeText(getByPlaceholderText('usuario'), 'operador');
    fireEvent.changeText(getByPlaceholderText('••••••••'), 'secret');
    fireEvent.press(getByText('Iniciar sesión'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('OperatorDashboard'));
    expect(mockSaveVault).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'operator-1', username: 'operador' }),
      'secret',
      expect.objectContaining({ access_token: 'a' }),
    );
  });

  it('shows tablet operator quick picks and hides biometrics despite enrolled hardware', async () => {
    mockIsTablet.mockReturnValue(true);
    mockBiometricAvailable = true;
    mockListVault.mockResolvedValue([{ id: 'operator-1', username: 'operador', fullName: 'Operador QA' }]);
    const { getByText, getByPlaceholderText, queryByText } = render(<LoginScreen />);
    fireEvent.press(getByText('Operador'));
    await waitFor(() => expect(getByText('Operadores de esta tableta')).toBeTruthy());
    expect(queryByText('Iniciar con huella')).toBeNull();
    fireEvent.press(getByText('Operador QA'));
    expect(getByPlaceholderText('usuario').props.value).toBe('operador');
  });

  it('returns to role selection and clears both credential fields', () => {
    const { getByText, getByPlaceholderText, queryByPlaceholderText } = render(<LoginScreen />);

    fireEvent.press(getByText('Administrador'));
    fireEvent.changeText(getByPlaceholderText('admin@ejemplo.com'), 'admin@phc.test');
    fireEvent.changeText(getByPlaceholderText('••••••••'), 'secret');
    fireEvent.press(getByText('‹ Volver'));
    fireEvent.press(getByText('Administrador'));

    expect(getByPlaceholderText('admin@ejemplo.com').props.value).toBe('');
    expect(getByPlaceholderText('••••••••').props.value).toBe('');
    expect(queryByPlaceholderText('usuario')).toBeNull();
  });

  it('revalidates the saved user and role before biometric navigation', async () => {
    mockBiometricAvailable = true;
    mockGetCurrentUser.mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
      is_active: true,
    });
    // Biometric sign-in now exchanges a stored refresh token for a real
    // session. The prompt comes from SecureStore's requireAuthentication, so
    // the keystore gates the read rather than a JavaScript-side fingerprint
    // check followed by reading an unprotected value.
    const SecureStore = require('expo-secure-store');
    SecureStore.getItemAsync.mockImplementation(async (key: string) =>
      key.includes('refreshToken') ? 'stored-refresh-token' : 'admin');
    mockRefreshSession.mockResolvedValue({
      data: { session: { refresh_token: 'rotated-refresh-token' } },
      error: null,
    });
    await AsyncStorage.multiSet([
      ['userRole', 'operator'],
      ['userId', 'admin-1'],
    ]);
    const { getByText } = render(<LoginScreen />);

    fireEvent.press(getByText('Iniciar con huella'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('AdminDashboard'));
    expect(mockRefreshSession).toHaveBeenCalledWith({ refresh_token: 'stored-refresh-token' });
    // Supabase rotates the token on use, so the spent one must be replaced or
    // biometric sign-in would work exactly once.
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      expect.stringContaining('refreshToken'),
      'rotated-refresh-token',
      expect.objectContaining({ requireAuthentication: true }),
    );
    expect(mockGetCurrentUser).toHaveBeenCalledTimes(1);
    // Same identity cache as a password sign-in, so offline RoleGuard checks
    // and operator screens see who is signed in.
    expect(auth.rememberSignedInUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin-1', role: 'admin' }),
    );
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      'LOGIN',
      'user',
      'admin-1',
      { method: 'biometric' },
    );
  });
});
