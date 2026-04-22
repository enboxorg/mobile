module.exports = {
  preset: '@react-native/jest-preset',
  // `setupFilesAfterEnv` runs AFTER the test framework is installed, so
  // `beforeEach` / `afterEach` / etc. are available inside jest.setup.js.
  // We use this to register the coherent default mock for
  // @specs/NativeBiometricVault whose per-test store reset depends on a
  // top-level `beforeEach` hook (see jest.setup.js).
  setupFilesAfterEnv: ['./jest.setup.js'],
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@specs/(.*)$': '<rootDir>/specs/$1',
  },
  // The biometric vault derives the HD seed via `ed25519-keygen` — an
  // ESM-only package. Include it in the Babel transform pipeline so Jest
  // can load it alongside the CJS React Native preset. Everything else in
  // `node_modules/` keeps the preset's default "do not transform" rule.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|ed25519-keygen)/)',
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
  ],
};
