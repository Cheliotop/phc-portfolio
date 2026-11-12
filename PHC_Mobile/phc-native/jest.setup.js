/* eslint-env jest */

// The CI/dev shell exports NODE_ENV=production, which Jest inherits. That made
// React load its PRODUCTION build, so every render-based test failed with
// "act(...) is not supported in production builds of React". Force the test
// environment here (setupFiles run before any test requires React) so the suite
// works regardless of the ambient shell. The npm "test" script also sets it,
// for direct `npx jest` runs.
process.env.NODE_ENV = 'test';

// The timezone is pinned in jest.globalSetup.js, NOT here. setupFiles run
// inside the per-file sandbox, where assigning process.env.TZ mutates a copy
// and leaves the real process timezone untouched — the date tests keep failing
// and it looks like the pin was ignored.

require('react-native-gesture-handler/jestSetup');

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('react-native/Libraries/EventEmitter/NativeEventEmitter', () =>
  jest.fn().mockImplementation(() => ({
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    removeAllListeners: jest.fn(),
    emit: jest.fn(),
  })),
);

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(async () => ({ isConnected: true })),
    addEventListener: jest.fn(() => jest.fn()),
  },
  fetch: jest.fn(async () => ({ isConnected: true })),
  addEventListener: jest.fn(() => jest.fn()),
}));

jest.mock('expo-image-picker', () => ({
  MediaTypeOptions: {
    Images: 'Images',
  },
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    runAsync: jest.fn(async () => ({ changes: 1, lastInsertRowId: 1 })),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async () => null),
    execAsync: jest.fn(async () => undefined),
  })),
}));

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: {
    JPEG: 'jpeg',
  },
  manipulateAsync: jest.fn(async (uri) => ({ uri })),
}));

jest.mock('expo-file-system/legacy', () => ({
  FileSystemUploadType: {
    MULTIPART: 'multipart',
  },
  documentDirectory: 'file:///tmp/',
  cacheDirectory: 'file:///tmp/',
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1024 })),
  uploadAsync: jest.fn(async () => ({
    status: 201,
    body: JSON.stringify({
      photo: {
        id: 1,
        url: '/api/photos/1',
        filename: 'photo-1.jpg',
        original_name: 'photo.jpg',
      },
    }),
  })),
  copyAsync: jest.fn(async () => undefined),
  deleteAsync: jest.fn(async () => undefined),
  makeDirectoryAsync: jest.fn(async () => undefined),
  readDirectoryAsync: jest.fn(async () => []),
}));

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-local-authentication', () => ({
  AuthenticationType: {
    FACIAL_RECOGNITION: 1,
    FINGERPRINT: 2,
    IRIS: 3,
  },
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  supportedAuthenticationTypesAsync: jest.fn(async () => []),
  authenticateAsync: jest.fn(async () => ({ success: false })),
}));

// Haptics are fire-and-forget decoration; tests must not need a vibrator.
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  impactAsync: jest.fn(async () => undefined),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

// Backs biometric sign-in. Defaults to "nothing stored", so a test that does
// not care about biometrics sees the same behaviour as a fresh device.
jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async () => undefined),
  getItemAsync: jest.fn(async () => null),
  deleteItemAsync: jest.fn(async () => undefined),
}));

const { Alert, Keyboard } = require('react-native');
Alert.alert = jest.fn();

// RN 0.81's KeyboardAvoidingView keeps the subscription objects and calls
// `.remove()` on unmount. NativeEventEmitter is mocked in Jest, so supply the
// subscription contract explicitly instead of returning undefined.
Keyboard.addListener = jest.fn(() => ({ remove: jest.fn() }));
