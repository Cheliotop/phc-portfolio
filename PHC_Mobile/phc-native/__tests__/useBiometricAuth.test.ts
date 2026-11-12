import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useBiometricAuth } from '../src/hooks/useBiometricAuth';

const mockIsTablet = jest.fn(() => false);
jest.mock('../src/utils/device', () => ({ isTablet: () => mockIsTablet() }));

jest.mock('expo-local-authentication', () => ({
  AuthenticationType: {
    FINGERPRINT: 1,
    FACIAL_RECOGNITION: 2,
    IRIS: 3,
  },
  hasHardwareAsync: jest.fn(),
  isEnrolledAsync: jest.fn(),
  supportedAuthenticationTypesAsync: jest.fn(),
  authenticateAsync: jest.fn(),
}));

const hasHardwareAsync = LocalAuthentication.hasHardwareAsync as jest.Mock;
const isEnrolledAsync = LocalAuthentication.isEnrolledAsync as jest.Mock;
const supportedAuthenticationTypesAsync =
  LocalAuthentication.supportedAuthenticationTypesAsync as jest.Mock;
const authenticateAsync = LocalAuthentication.authenticateAsync as jest.Mock;

describe('useBiometricAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTablet.mockReturnValue(false);
    hasHardwareAsync.mockResolvedValue(true);
    isEnrolledAsync.mockResolvedValue(false);
    supportedAuthenticationTypesAsync.mockResolvedValue([
      LocalAuthentication.AuthenticationType.FINGERPRINT,
    ]);
    authenticateAsync.mockResolvedValue({ success: true });
  });

  it('refreshes enrollment when authentication is attempted', async () => {
    const { result } = renderHook(() => useBiometricAuth());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isEnrolled).toBe(false);

    isEnrolledAsync.mockResolvedValue(true);

    let authenticationResult;
    await act(async () => {
      authenticationResult = await result.current.authenticate('Test prompt');
    });

    expect(authenticationResult).toEqual({ success: true, error: undefined });
    expect(result.current.isEnrolled).toBe(true);
    expect(authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ promptMessage: 'Test prompt' }),
    );
  });

  it('shows its prompt and buttons in Spanish', async () => {
    isEnrolledAsync.mockResolvedValue(true);
    const { result } = renderHook(() => useBiometricAuth());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.authenticate();
    });

    expect(authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({
      promptMessage: 'Verificá tu identidad para ingresar a PHC',
      cancelLabel: 'Cancelar',
      fallbackLabel: 'Usar PIN',
    }));
  });

  it('does not open the prompt when current enrollment is unavailable', async () => {
    const { result } = renderHook(() => useBiometricAuth());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let authenticationResult;
    await act(async () => {
      authenticationResult = await result.current.authenticate();
    });

    expect(authenticationResult).toEqual({
      success: false,
      error: 'Biometric authentication not available',
    });
    expect(authenticateAsync).not.toHaveBeenCalled();
  });

  it('ignores enrollment and blocks biometric prompts on tablets', async () => {
    mockIsTablet.mockReturnValue(true);
    const { result } = renderHook(() => useBiometricAuth());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAvailable).toBe(false);
    expect(result.current.isEnrolled).toBe(false);
    await act(async () => { await result.current.authenticate(); });
    expect(authenticateAsync).not.toHaveBeenCalled();
    expect(hasHardwareAsync).not.toHaveBeenCalled();
  });
});
