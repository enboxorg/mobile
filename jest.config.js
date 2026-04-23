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
  // transformIgnorePatterns — Jest ESM allowlist rationale.
  //
  // Reason (current entry): `ed25519-keygen` is an ESM-only package pulled
  // into `BiometricVault` via `@enbox/crypto`'s HDKey usage (see
  // `src/lib/enbox/biometric-vault.ts` — imports `HDKey` from
  // `ed25519-keygen/hdkey` to derive the root seed + identity-account
  // paths). The `@react-native/jest-preset` defaults to "do not transform
  // anything in node_modules", which causes Jest to refuse to parse the
  // package's ESM source and tests exercising BiometricVault fail at
  // import time with `SyntaxError: Cannot use import statement outside a
  // module`. Adding `ed25519-keygen` here opts that single dependency
  // back into Babel transformation so Jest can load it alongside the
  // CJS-first React Native preset.
  //
  // If the dep chain grows (for example, if tests begin importing
  // `@enbox/crypto` / `@enbox/dids` directly without virtual mocks, or
  // an upstream bump pulls additional ESM-only packages through
  // BiometricVault's transitive imports), extend this alternation with
  // the matching scope. The most likely additions are
  // `@noble/curves|@noble/hashes|@scure/base` (all three are ESM-only and
  // are the transitive crypto dependencies of `@enbox/crypto` / `@enbox/dids`).
  // Keep the list alphabetical where reasonable and add one scope per PR
  // so diffs stay reviewable and the growth is easy to audit.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|ed25519-keygen)/)',
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
  ],
};
