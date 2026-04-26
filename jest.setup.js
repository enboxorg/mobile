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
// screens, tests) can set up targeted mockResolvedValueOnce /
// mockRejectedValueOnce cases without crashing at
// TurboModuleRegistry.getEnforcing.
//
// Coherence contract (fixed after scrutiny feedback):
//
//   The mock maintains an internal per-test Map<alias, {secret, iv}> that
//   `generateAndStoreSecret`, `hasSecret`, `getSecret`, and `deleteSecret`
//   all agree on. That way downstream tests cannot observe the impossible
//   state "hasSecret === false yet getSecret resolves a secret" that the
//   previous default mock allowed.
//
//     - `generateAndStoreSecret(alias, options)` inserts an entry
//       (generating a deterministic 64-char lowercase-hex secret + 24-char
//       hex IV so tests can assert shape). Resolves undefined.
//     - `hasSecret(alias)` resolves `true` iff an entry exists for `alias`,
//       `false` otherwise.
//     - `getSecret(alias, prompt)` resolves the stored secret hex when an
//       entry exists; when the alias is absent it REJECTS with an Error
//       whose `.code === 'NOT_FOUND'` (the canonical biometric error code
//       documented in validation-contract.md VAL-NATIVE-035).
//     - `deleteSecret(alias)` removes the entry and resolves undefined —
//       idempotently even when the alias was already absent.
//
// The store is cleared automatically before every test via the jest
// `beforeEach` hook below so no state leaks across tests. Individual tests
// may still override behavior for a single call with
// `mock.fn.mockRejectedValueOnce(...)` / `mockResolvedValueOnce(...)` to
// simulate native error paths (USER_CANCELED, KEY_INVALIDATED, etc.).
// Names starting with `mock` are exempt from Jest's factory-hoisting
// restriction, so the closure in jest.mock(...) below can safely reference
// them at call time.
const mockBiometricVaultStore = new Map();

function mockBiometricVaultMakeError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

// Deterministic hex generator so tests can assert the "non-empty lowercase
// hex" contract without relying on randomness. Seeded by alias so the same
// alias gets the same stored material within a test.
//
// The `>>> 0` and `& 0xff` operations below are legitimate uses of bitwise
// arithmetic: we need an unsigned-32-bit wraparound for a linear-congruential
// PRNG and a low-byte mask to peel off the high-entropy top bits. There is
// no non-bitwise equivalent in JS for either operation.
/* eslint-disable no-bitwise */
function mockBiometricVaultDeterministicHex(seed, byteLength) {
  const input = String(seed);
  let acc = 0;
  for (let i = 0; i < input.length; i++) {
    acc = (acc * 31 + input.charCodeAt(i)) >>> 0;
  }
  let out = '';
  for (let i = 0; i < byteLength; i++) {
    acc = (acc * 1103515245 + 12345) >>> 0;
    const byte = (acc >>> 16) & 0xff;
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}
/* eslint-enable no-bitwise */

function mockBiometricVaultDefaultGenerate(alias, options) {
  // Non-destructive contract (VAL-VAULT-030): the native API rejects
  // when the alias already exists. Mirror that here so JS-only tests
  // exercise the same surface as the Android / iOS implementations.
  // Callers that intend to overwrite must call `deleteSecret(alias)`
  // first.
  if (mockBiometricVaultStore.has(alias)) {
    return Promise.reject(
      mockBiometricVaultMakeError(
        'VAULT_ERROR_ALREADY_INITIALIZED',
        'A biometric secret already exists for this alias',
      ),
    );
  }
  // Caller may pre-seed the wallet secret by passing a 64-char lower-case
  // hex string under `options.secretHex`. When supplied, store those exact
  // bytes so the JS layer's local derivation matches the native store.
  let secret;
  const providedHex = options && typeof options.secretHex === 'string' ? options.secretHex : null;
  if (providedHex) {
    if (!/^[0-9a-f]{64}$/.test(providedHex)) {
      return Promise.reject(
        mockBiometricVaultMakeError(
          'VAULT_ERROR',
          'secretHex must be 64 lower-case hex characters',
        ),
      );
    }
    secret = providedHex;
  } else {
    secret = mockBiometricVaultDeterministicHex(`secret:${alias}`, 32);
  }
  const iv = mockBiometricVaultDeterministicHex(`iv:${alias}`, 12);
  mockBiometricVaultStore.set(alias, { secret, iv });
  return Promise.resolve(undefined);
}

function mockBiometricVaultDefaultGetSecret(alias /* , prompt */) {
  const entry = mockBiometricVaultStore.get(alias);
  if (!entry) {
    return Promise.reject(
      mockBiometricVaultMakeError('NOT_FOUND', 'No secret stored under alias'),
    );
  }
  return Promise.resolve(entry.secret);
}

function mockBiometricVaultDefaultHasSecret(alias) {
  return Promise.resolve(mockBiometricVaultStore.has(alias));
}

function mockBiometricVaultDefaultDeleteSecret(alias) {
  // Idempotent: resolves even when the alias is absent.
  mockBiometricVaultStore.delete(alias);
  return Promise.resolve(undefined);
}

const mockNativeBiometricVault = {
  isBiometricAvailable: jest.fn().mockResolvedValue({
    available: true,
    enrolled: true,
    type: 'fingerprint',
  }),
  generateAndStoreSecret: jest.fn(mockBiometricVaultDefaultGenerate),
  getSecret: jest.fn(mockBiometricVaultDefaultGetSecret),
  hasSecret: jest.fn(mockBiometricVaultDefaultHasSecret),
  deleteSecret: jest.fn(mockBiometricVaultDefaultDeleteSecret),
};

// Expose the store and mock so tests that need them can use
// `global.__enboxBiometricVaultStore` / `global.__enboxBiometricVaultMock`.
global.__enboxBiometricVaultStore = mockBiometricVaultStore;
global.__enboxBiometricVaultMock = mockNativeBiometricVault;

// Simulate the Android-native `invalidateAlias` cleanup that the
// NativeBiometricVaultModule.kt now performs whenever
// `KeyPermanentlyInvalidatedException` surfaces — at cipher-init OR
// post-`doFinal` (Round-3 review Finding 4). Mirrors the contract the
// native layer guarantees:
//
//   1. The alias' wrapped ciphertext + IV prefs are dropped.
//   2. The Keystore key entry is dropped.
//   3. The very next `getSecret(alias, ...)` rejects with
//      `KEY_INVALIDATED`.
//
// JS consumers (`BiometricVault._doUnlock`, navigation gate matrices)
// rely on (1) + (2) so a subsequent `hasSecret(alias)` resolves false
// and the user routes through recovery instead of looping forever on
// the same `KEY_INVALIDATED` rejection. Tests use this simulator to
// exercise the post-invalidation state without standing up an Android
// emulator.
global.__enboxBiometricVaultSimulateInvalidation = function (alias) {
  mockBiometricVaultStore.delete(alias);
  mockNativeBiometricVault.getSecret.mockRejectedValueOnce(
    mockBiometricVaultMakeError(
      'KEY_INVALIDATED',
      'Key invalidated by biometric enrollment change',
    ),
  );
};

// Reset the shared store and default mock implementations before every
// test so one test's state cannot leak into another. Per-test overrides
// via mockResolvedValueOnce / mockRejectedValueOnce are preserved because
// they sit on top of these default implementations.
beforeEach(() => {
  mockBiometricVaultStore.clear();
  mockNativeBiometricVault.isBiometricAvailable
    .mockReset()
    .mockResolvedValue({ available: true, enrolled: true, type: 'fingerprint' });
  mockNativeBiometricVault.generateAndStoreSecret
    .mockReset()
    .mockImplementation(mockBiometricVaultDefaultGenerate);
  mockNativeBiometricVault.getSecret
    .mockReset()
    .mockImplementation(mockBiometricVaultDefaultGetSecret);
  mockNativeBiometricVault.hasSecret
    .mockReset()
    .mockImplementation(mockBiometricVaultDefaultHasSecret);
  mockNativeBiometricVault.deleteSecret
    .mockReset()
    .mockImplementation(mockBiometricVaultDefaultDeleteSecret);
});

jest.mock('./specs/NativeBiometricVault', () => ({
  __esModule: true,
  default: mockNativeBiometricVault,
}));
