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
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
  ],
};
