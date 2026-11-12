module.exports = {
  preset: 'react-native',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  globalSetup: '<rootDir>/jest.globalSetup.js',
  setupFiles: ['<rootDir>/jest.setup.js'],
  testMatch: ['**/__tests__/**/*.(test|spec).(ts|tsx|js|jsx)'],
  moduleNameMapper: {
    '\\.(png|jpg|jpeg|gif|webp)$': '<rootDir>/__mocks__/fileMock.js',
  },
  // React Navigation, Gesture Handler and Expo SDK 54 ship ESM/source files.
  // decode-uri-component is pinned to ESM-only 0.5.0 via npm overrides
  // (GHSA incomplete-fix chain); it must be transformed like the rest.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|react-native-gesture-handler|standard-navigation|expo|expo-.*|@expo|decode-uri-component)/)',
  ],
  // Screen suites use current Supabase/auth and dashboard behavior. The admin
  // suite mocks expo-print's native boundary after transforming its ESM chain.
};
