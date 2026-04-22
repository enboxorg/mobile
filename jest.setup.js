// Mock Turbo Native Modules that are resolved at import time.
// These are replaced by real native implementations when the app runs on device.

jest.mock('./specs/NativeSecureStorage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    deleteItem: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('./specs/NativeCrypto', () => ({
  __esModule: true,
  default: {
    sha256: jest.fn((data) => Promise.resolve(`mocksha256_${data}`)),
    pbkdf2: jest.fn((password, salt) => Promise.resolve(`mockpbkdf2_${salt}_${password}`)),
    randomBytes: jest.fn(() => Promise.resolve('0102030405060708090a0b0c0d0e0f10')),
  },
}));

// NativeBiometricVault mock.
//
// The real Turbo Module is backed by biometric-gated Keychain (iOS) and
// biometric-gated Keystore (Android). In tests we replace it with a default
// export that mirrors the spec surface in specs/NativeBiometricVault.ts so
// that any JS consumer (Milestone 3 biometric IdentityVault wrapper, UX
// screens, tests) can set up targeted mockResolvedValueOnce / mockRejectedValueOnce
// cases without crashing at TurboModuleRegistry.getEnforcing.
//
// The default method behaviors are intentionally "sensible defaults":
//   - hardware present and enrolled
//   - no stored secret yet (hasSecret resolves to false)
//   - generate/getSecret/deleteSecret succeed
//   - getSecret returns a non-empty lower-case hex string (64 chars ~= 32 bytes)
// matching the shape documented in validation-contract.md (VAL-NATIVE-022).
jest.mock('./specs/NativeBiometricVault', () => ({
  __esModule: true,
  default: {
    isBiometricAvailable: jest.fn().mockResolvedValue({
      available: true,
      enrolled: true,
      type: 'fingerprint',
    }),
    generateAndStoreSecret: jest.fn().mockResolvedValue(undefined),
    getSecret: jest
      .fn()
      .mockResolvedValue(
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ),
    hasSecret: jest.fn().mockResolvedValue(false),
    deleteSecret: jest.fn().mockResolvedValue(undefined),
  },
}));
