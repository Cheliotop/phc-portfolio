import { useState, useCallback, useEffect } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import { isTablet } from '../utils/device';

export interface BiometricResult {
  success: boolean;
  error?: string;
}

export const useBiometricAuth = () => {
  const tablet = isTablet();
  const [isAvailable, setIsAvailable] = useState(false);
  const [isEnrolled, setIsEnrolled] = useState(false);
  const [hardwareType, setHardwareType] = useState<string>('none');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (tablet) {
      setIsAvailable(false);
      setIsEnrolled(false);
      setIsLoading(false);
    } else checkAvailability();
  }, [tablet]);

  const checkAvailability = useCallback(async () => {
    setIsLoading(true);
    try {
      const compatible = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      const supportedTypes = await LocalAuthentication.supportedAuthenticationTypesAsync();

      setIsAvailable(compatible);
      setIsEnrolled(enrolled);

      if (supportedTypes.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
        setHardwareType('face');
      } else if (supportedTypes.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
        setHardwareType('fingerprint');
      } else if (supportedTypes.includes(LocalAuthentication.AuthenticationType.IRIS)) {
        setHardwareType('iris');
      } else {
        setHardwareType('none');
      }
    } catch (error) {
      console.error('[Biometric] Check failed:', error);
      setIsAvailable(false);
      setIsEnrolled(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const authenticate = useCallback(async (promptMessage?: string): Promise<BiometricResult> => {
    if (tablet) return { success: false, error: 'La verificación biométrica no está disponible en tabletas' };
    try {
      // Enrollment can change while the app is backgrounded in Android Settings.
      // Re-check at the point of use instead of relying on the mount-time snapshot.
      const compatible = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      setIsAvailable(compatible);
      setIsEnrolled(enrolled);

      if (!compatible || !enrolled) {
        return { success: false, error: 'Biometric authentication not available' };
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: promptMessage || 'Verificá tu identidad para ingresar a PHC',
        cancelLabel: 'Cancelar',
        disableDeviceFallback: false,
        fallbackLabel: 'Usar PIN',
      });

      return {
        success: result.success,
        error: result.success ? undefined : 'Authentication failed',
      };
    } catch (error: any) {
      console.error('[Biometric] Auth failed:', error);
      return { success: false, error: error.message };
    }
  }, [tablet]);

  const getBiometricLabel = useCallback(() => {
    switch (hardwareType) {
      case 'face':
        return 'reconocimiento facial';
      case 'fingerprint':
        return 'huella';
      case 'iris':
        return 'iris';
      default:
        return 'método biométrico';
    }
  }, [hardwareType]);

  const getBiometricIcon = useCallback(() => {
    switch (hardwareType) {
      case 'face':
        return '👤';
      case 'fingerprint':
        return '👆';
      case 'iris':
        return '👁️';
      default:
        return '🔐';
    }
  }, [hardwareType]);

  return {
    isAvailable,
    isEnrolled,
    hardwareType,
    isLoading,
    authenticate,
    checkAvailability,
    getBiometricLabel,
    getBiometricIcon,
  };
};

export default useBiometricAuth;
