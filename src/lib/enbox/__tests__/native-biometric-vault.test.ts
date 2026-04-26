/**
 * JS-level contract tests for the NativeBiometricVault Turbo Module spec.
 *
 * The real module is mocked by jest.setup.js, so these tests exercise the
 * JS-facing surface that downstream consumers (Milestone 3 biometric
 * IdentityVault wrapper, Milestone 4 onboarding/unlock screens) will depend
 * on. They cover:
 *
 *   - availability: hardware/enrollment negative path
 *   - lifecycle: generateAndStoreSecret → hasSecret=true → deleteSecret → hasSecret=false
 *   - getSecret: lowercase-hex contract + prompt option forwarding
 *   - rejection codes: USER_CANCELED, KEY_INVALIDATED, NOT_FOUND all surface .code
 *   - deleteSecret: idempotent (no-throw on missing alias)
 *   - requireBiometrics=false: deterministic VAULT_ERROR (chosen contract)
 *   - error-code union consistency across simulated iOS and Android rejection shapes
 *
 * Notes:
 * - We simulate cross-platform behavior by reusing the single mock and firing
 *   rejection shapes that mimic what the iOS RCTNativeBiometricVault and the
 *   Android NativeBiometricVaultModule actually reject with. The point is
 *   JS-surface invariance: a consumer must see the same nine canonical .code
 *   values regardless of platform.
 * - None of these tests should change native-module behavior; they only
 *   assert that the JS wrapper faithfully forwards arguments and propagates
 *   .code on errors.
 */

import NativeBiometricVault from '@specs/NativeBiometricVault';

// Narrow alias to the mocked surface; every method is a jest.Mock.
// Declared via `any` escape-hatch because the Turbo Module default export
// is typed as `Spec` and casting to `jest.Mocked<Spec>` pulls in TurboModule
// internals we don't need for the tests.
const mock = NativeBiometricVault as unknown as {
  isBiometricAvailable: jest.Mock;
  generateAndStoreSecret: jest.Mock;
  getSecret: jest.Mock;
  hasSecret: jest.Mock;
  deleteSecret: jest.Mock;
};

// The full canonical error-code union per validation-contract.md VAL-NATIVE-028.
// Keeping this as a frozen sorted tuple makes the "nine codes, no more, no less"
// assertion stable across test runs.
const CANONICAL_ERROR_CODES = [
  'AUTH_FAILED',
  'BIOMETRY_LOCKOUT',
  'BIOMETRY_LOCKOUT_PERMANENT',
  'BIOMETRY_NOT_ENROLLED',
  'BIOMETRY_UNAVAILABLE',
  'KEY_INVALIDATED',
  'NOT_FOUND',
  'USER_CANCELED',
  'VAULT_ERROR',
] as const;

type BiometricErrorCode = (typeof CANONICAL_ERROR_CODES)[number];

// Helper: construct an Error with a .code property, mirroring both the
// RCTPromiseRejectBlock + NSError (iOS) and Promise.reject(code, message)
// (Android) shapes React Native surfaces to JS.
function biometricError(
  code: BiometricErrorCode,
  message: string = code,
): Error & { code: BiometricErrorCode } {
  const err = new Error(message) as Error & { code: BiometricErrorCode };
  err.code = code;
  return err;
}

// The default mock behaviors (plus the per-test Map-backed coherent store)
// are installed by `jest.setup.js`'s top-level `beforeEach`, which runs
// before this file's own hooks. We therefore do NOT call `mockReset()` here
// — doing so would drop the store-backed implementations and regress the
// mock to the old incoherent "hasSecret=false but getSecret resolves a
// secret" shape. Per-test overrides via `mockResolvedValueOnce` /
// `mockRejectedValueOnce` still work because they sit on top of the
// default implementations installed by the setup hook.

describe('NativeBiometricVault — isBiometricAvailable', () => {
  it('returns an available:true/enrolled:true default shape under the jest.setup mock', async () => {
    const result = await NativeBiometricVault.isBiometricAvailable();
    expect(result.available).toBe(true);
    expect(result.enrolled).toBe(true);
    expect(['faceID', 'touchID', 'fingerprint', 'face', 'none']).toContain(
      result.type,
    );
  });

  it('forwards { available:false, enrolled:false, type:"none", reason } verbatim when hardware is absent', async () => {
    // Simulate a device with no biometric hardware (e.g. iOS simulator without
    // Touch ID configured, Android emulator with no fingerprint sensor).
    mock.isBiometricAvailable.mockResolvedValueOnce({
      available: false,
      enrolled: false,
      type: 'none',
      reason: 'NO_HARDWARE',
    });

    const result = await NativeBiometricVault.isBiometricAvailable();

    // Verbatim forwarding — this is what the "BiometricUnavailable"
    // onboarding gate (Milestone 4) consumes.
    expect(result).toEqual({
      available: false,
      enrolled: false,
      type: 'none',
      reason: 'NO_HARDWARE',
    });
    expect(mock.isBiometricAvailable).toHaveBeenCalledTimes(1);
  });

  it('does not throw when availability returns unavailable', async () => {
    mock.isBiometricAvailable.mockResolvedValueOnce({
      available: false,
      enrolled: false,
      type: 'none',
    });
    await expect(
      NativeBiometricVault.isBiometricAvailable(),
    ).resolves.toMatchObject({ available: false });
  });
});

describe('NativeBiometricVault — lifecycle roundtrip', () => {
  // This test exercises the actual coherent Map-backed default installed by
  // jest.setup.js — it does NOT manually flip hasSecret. That is the whole
  // point of the coherent mock: hasSecret / getSecret / deleteSecret all
  // agree on the same internal store, so a test can't observe the
  // impossible "hasSecret === false yet getSecret resolves a secret" state
  // that caused the BLOCKER 4 scrutiny finding.
  it('generateAndStoreSecret → hasSecret=true → deleteSecret → hasSecret=false', async () => {
    const alias = 'enbox.wallet.root';
    const options = { requireBiometrics: true, invalidateOnEnrollmentChange: true };

    // Step 0: a pristine store reports no secret for this alias.
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(false);
    // And getSecret rejects with NOT_FOUND when the alias is absent.
    await expect(
      NativeBiometricVault.getSecret(alias, {
        promptTitle: 'Unlock',
        promptMessage: 'Authenticate',
        promptCancel: 'Cancel',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Step 1: generateAndStoreSecret populates the internal store and
    // resolves undefined with forwarded args.
    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, options),
    ).resolves.toBeUndefined();
    expect(mock.generateAndStoreSecret).toHaveBeenCalledTimes(1);
    expect(mock.generateAndStoreSecret).toHaveBeenCalledWith(alias, options);

    // Step 2: hasSecret now reflects store state (no manual flip required).
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(true);
    expect(mock.hasSecret).toHaveBeenCalledWith(alias);

    // Step 2b: getSecret resolves the stored secret (lower-case hex).
    const storedSecret = await NativeBiometricVault.getSecret(alias, {
      promptTitle: 'Unlock',
      promptMessage: 'Authenticate',
      promptCancel: 'Cancel',
    });
    expect(storedSecret).toMatch(/^[0-9a-f]+$/);
    expect(storedSecret.length).toBeGreaterThan(0);

    // Step 3: deleteSecret resolves undefined with forwarded alias.
    await expect(
      NativeBiometricVault.deleteSecret(alias),
    ).resolves.toBeUndefined();
    expect(mock.deleteSecret).toHaveBeenCalledWith(alias);

    // Step 4: after delete the store is empty — hasSecret observes that
    // directly through the Map-backed default (no manual override needed).
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(false);
    await expect(
      NativeBiometricVault.getSecret(alias, {
        promptTitle: 'Unlock',
        promptMessage: 'Authenticate',
        promptCancel: 'Cancel',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// VAL-VAULT-030 / Round-2 review Finding 3: the native API surface
// MUST refuse to overwrite an existing secret. The Android module's
// pre-fix code path silently `deleteKeystoreKey()`'d the existing key
// BEFORE creating the new one (with no rollback covering BiometricPrompt
// cancellation), and iOS issued an unconditional SecItemDelete BEFORE
// SecItemAdd. Either could destroy a working wallet on a mid-setup
// cancel. The fix is enforced at THREE layers:
//
//   1. The native modules themselves (Android Keystore, iOS Keychain)
//      reject with VAULT_ERROR_ALREADY_INITIALIZED if the alias exists.
//   2. The JS-side BiometricVault._doInitialize pre-checks via
//      hasSecret() and rejects with the same code (defense in depth).
//   3. The jest.setup.js mock mirrors (1) so JS-only tests exercise
//      the same surface.
//
// These tests pin (3) — and by extension the JS contract that
// downstream callers depend on.
describe('NativeBiometricVault — non-destructive contract (VAL-VAULT-030)', () => {
  it('rejects with VAULT_ERROR_ALREADY_INITIALIZED when generateAndStoreSecret is called over an existing alias', async () => {
    const alias = 'enbox.wallet.root';
    const options = { requireBiometrics: true, invalidateOnEnrollmentChange: true };
    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, options),
    ).resolves.toBeUndefined();
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(true);

    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, options),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR_ALREADY_INITIALIZED' });
  });

  it('preserves the original stored secret bytes after a rejected overwrite attempt', async () => {
    const alias = 'enbox.wallet.root';
    const originalHex =
      '11111111111111111111111111111111' + '11111111111111111111111111111111';
    const replacementHex =
      '22222222222222222222222222222222' + '22222222222222222222222222222222';

    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, {
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
        secretHex: originalHex,
      }),
    ).resolves.toBeUndefined();

    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, {
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
        secretHex: replacementHex,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR_ALREADY_INITIALIZED' });

    const survivingSecret = await NativeBiometricVault.getSecret(alias, {
      promptTitle: 'Unlock',
      promptMessage: 'Authenticate',
      promptCancel: 'Cancel',
    });
    expect(survivingSecret).toBe(originalHex);
  });

  it('allows re-provisioning AFTER an explicit deleteSecret (the only sanctioned overwrite path)', async () => {
    const alias = 'enbox.wallet.root';
    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, {
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
      }),
    ).resolves.toBeUndefined();
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(true);

    await expect(
      NativeBiometricVault.deleteSecret(alias),
    ).resolves.toBeUndefined();
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(false);

    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, {
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
      }),
    ).resolves.toBeUndefined();
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(true);
  });
});

// Round-3 review regressions:
//
//   Finding 3 (Medium) — Android `generateAndStoreSecret()` existence
//   probe used to fail-OPEN: any throw inside the
//   `prefs().contains(...)` / `loadKeystoreKey(...)` block fell through
//   to the destructive `deleteKeystoreKey(keyAlias)` ~30 lines below,
//   wiping a perfectly valid existing alias on a transient probe
//   error. The native module now fail-CLOSES — a probe exception
//   rejects with `VAULT_ERROR` and never reaches the destructive
//   provisioning path. The JS-observable contract this pins:
//   ANY rejection from `generateAndStoreSecret(alias, ...)` (cancel,
//   transient `VAULT_ERROR`, biometry lockout, etc.) MUST preserve a
//   pre-existing alias byte-for-byte.
//
//   Finding 4 (Medium) — `KeyPermanentlyInvalidatedException` thrown
//   by `Cipher.doFinal` inside the post-auth callback used to reject
//   without dropping the wrapped ciphertext / IV in
//   SharedPreferences. `hasSecret(alias)` then kept returning `true`
//   forever and every subsequent unlock looped on the same
//   `KEY_INVALIDATED` rejection. The native module now routes BOTH
//   the cipher-init invalidation path AND the post-`doFinal`
//   invalidation path through `invalidateAlias()`, which drops the
//   key entry AND the prefs symmetrically. The JS-observable
//   contract this pins: a `getSecret(alias, ...)` rejection with
//   code `KEY_INVALIDATED` MUST be followed by `hasSecret(alias)`
//   resolving `false`, so the UI can route the user through
//   recovery instead of looping.
describe('NativeBiometricVault — Round-3 regressions (Findings 3 & 4)', () => {
  const prompt = {
    promptTitle: 'Unlock',
    promptMessage: 'Authenticate',
    promptCancel: 'Cancel',
  };

  it('Finding 3: generateAndStoreSecret rejecting with VAULT_ERROR after a transient probe failure preserves the pre-existing alias byte-for-byte', async () => {
    const alias = 'enbox.wallet.root';
    const originalHex =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    // Provision the alias under the canonical 32-byte secret.
    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, {
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
        secretHex: originalHex,
      }),
    ).resolves.toBeUndefined();
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(true);

    // Simulate a transient native probe failure on the next
    // `generateAndStoreSecret(alias, ...)` call. The pre-fix native
    // path would have caught this internally and proceeded to delete
    // the existing alias. The fixed native path rejects with
    // `VAULT_ERROR` instead. We model that by returning the same
    // canonical rejection here.
    mock.generateAndStoreSecret.mockRejectedValueOnce(
      biometricError(
        'VAULT_ERROR',
        'Could not determine whether a biometric secret already exists; ' +
          'refusing to provision to avoid overwriting a valid alias',
      ),
    );

    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, {
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR' });

    // Critical assertion: the rejected re-provision attempt MUST NOT
    // have wiped the original alias. Both surfaces still see the
    // valid secret.
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(true);
    const survivingSecret = await NativeBiometricVault.getSecret(alias, prompt);
    expect(survivingSecret).toBe(originalHex);
  });

  it('Finding 4: getSecret rejecting with KEY_INVALIDATED is followed by hasSecret=false (native invalidateAlias cleanup ran)', async () => {
    const alias = 'enbox.wallet.root';
    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, {
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
      }),
    ).resolves.toBeUndefined();
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(true);

    // Trigger the simulated native invalidateAlias() cleanup. Mirrors
    // the contract: the next getSecret(alias) rejects with
    // KEY_INVALIDATED, AND the native side has already cleared the
    // wrapped ciphertext + key entry so hasSecret returns false.
    const simulate = (
      globalThis as unknown as { __enboxBiometricVaultSimulateInvalidation: (alias: string) => void }
    ).__enboxBiometricVaultSimulateInvalidation;
    expect(typeof simulate).toBe('function');
    simulate(alias);

    await expect(
      NativeBiometricVault.getSecret(alias, prompt),
    ).rejects.toMatchObject({ code: 'KEY_INVALIDATED' });

    // Critical assertion: the alias is gone after the
    // KEY_INVALIDATED rejection. Pre-fix the prefs lingered and
    // hasSecret kept returning true, trapping the user in a
    // KEY_INVALIDATED loop.
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(false);
    await expect(
      NativeBiometricVault.getSecret(alias, prompt),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('Finding 4: re-provisioning is permitted immediately after a KEY_INVALIDATED rejection (no orphan-alias trap)', async () => {
    const alias = 'enbox.wallet.root';
    const originalHex =
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' +
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const replacementHex =
      'cccccccccccccccccccccccccccccccc' +
      'cccccccccccccccccccccccccccccccc';

    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, {
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
        secretHex: originalHex,
      }),
    ).resolves.toBeUndefined();

    const simulate = (
      globalThis as unknown as { __enboxBiometricVaultSimulateInvalidation: (alias: string) => void }
    ).__enboxBiometricVaultSimulateInvalidation;
    simulate(alias);

    await expect(
      NativeBiometricVault.getSecret(alias, prompt),
    ).rejects.toMatchObject({ code: 'KEY_INVALIDATED' });

    // After the cleanup the alias is fully absent — re-provisioning
    // is allowed without first calling `deleteSecret(alias)`. This
    // is the recovery path the UI relies on when the user lands on
    // the BiometricInvalidated screen and proceeds through
    // RecoveryRestore.
    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, {
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
        secretHex: replacementHex,
      }),
    ).resolves.toBeUndefined();
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(true);
    const newSecret = await NativeBiometricVault.getSecret(alias, prompt);
    expect(newSecret).toBe(replacementHex);
  });
});

describe('NativeBiometricVault — Round-4 regressions (Finding 3: strict lower-case secretHex contract)', () => {
  it('Jest mock rejects uppercase secretHex with VAULT_ERROR (parity with Android Round-4 LOWER_HEX_64_REGEX + iOS lowercase-only parser)', async () => {
    // The TurboModule spec at `specs/NativeBiometricVault.ts:36-38` pins
    // "lower-case hex (length 64)". The pre-fix Android parser used
    // `Character.digit(c, 16)` (which accepts `[A-F]`) and the iOS
    // parser had explicit `'A'..'F'` arms, so a caller that passed
    // uppercase / mixed-case hex would silently succeed on Android
    // and iOS while the JS mock rejected — a platform contract drift.
    // Round-4 Finding 3 fixed both native parsers; this test pins the
    // JS-side mirror of that same regex so any future regression on
    // EITHER native side fails this regression here AND the native
    // emulator suite at the same time.
    const alias = 'enbox.wallet.root';
    const upperCaseHex =
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(upperCaseHex).toHaveLength(64);
    expect(upperCaseHex).toMatch(/^[A-F]{64}$/);

    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, {
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
        secretHex: upperCaseHex,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR' });

    // The alias MUST NOT exist after the rejected provision —
    // mid-failure must never persist anything.
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(false);
  });

  it('Jest mock rejects mixed-case secretHex with VAULT_ERROR', async () => {
    const alias = 'enbox.wallet.root';
    // 63 lower-case chars + 1 uppercase — guaranteed regex mismatch.
    const mixedCase =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA';
    expect(mixedCase).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(mixedCase)).toBe(false);

    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, {
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
        secretHex: mixedCase,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR' });
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(false);
  });

  it('Jest mock rejects non-hex secretHex with VAULT_ERROR', async () => {
    const alias = 'enbox.wallet.root';
    const withZ =
      'zaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(withZ).toHaveLength(64);

    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, {
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
        secretHex: withZ,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR' });
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(false);
  });

  it('Jest mock rejects wrong-length secretHex (63 chars) with VAULT_ERROR', async () => {
    const alias = 'enbox.wallet.root';
    const tooShort = 'a'.repeat(63);

    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, {
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
        secretHex: tooShort,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR' });
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(false);
  });

  it('Jest mock accepts lower-case 64-char hex (positive parity with the strict regex)', async () => {
    const alias = 'enbox.wallet.root';
    const lowerCaseHex =
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4' +
      'e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    expect(lowerCaseHex).toMatch(/^[0-9a-f]{64}$/);

    await expect(
      NativeBiometricVault.generateAndStoreSecret(alias, {
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
        secretHex: lowerCaseHex,
      }),
    ).resolves.toBeUndefined();
    await expect(NativeBiometricVault.hasSecret(alias)).resolves.toBe(true);
  });
});

describe('NativeBiometricVault — getSecret success path', () => {
  const prompt = {
    promptTitle: 'Unlock Enbox',
    promptMessage: 'Authenticate to unlock your wallet',
    promptCancel: 'Cancel',
    promptSubtitle: 'Biometric authentication required',
  };

  it('resolves with a non-empty lower-case hex string and forwards prompt options verbatim', async () => {
    const expected =
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    mock.getSecret.mockResolvedValueOnce(expected);

    const secret = await NativeBiometricVault.getSecret('enbox.wallet.root', prompt);

    expect(secret).toBe(expected);
    expect(secret).toMatch(/^[0-9a-f]+$/);
    expect(secret.length % 2).toBe(0);
    expect(secret.length).toBeGreaterThanOrEqual(32);

    // Prompt object must be forwarded verbatim (argument capture), so the
    // native module can populate BiometricPrompt.PromptInfo / LAContext.
    expect(mock.getSecret).toHaveBeenCalledTimes(1);
    expect(mock.getSecret).toHaveBeenCalledWith('enbox.wallet.root', prompt);
    const callArgs = mock.getSecret.mock.calls[0];
    expect(callArgs[1]).toEqual(prompt);
    // Forwarded keys must match the documented prompt shape exactly.
    expect(Object.keys(callArgs[1]).sort()).toEqual(
      ['promptCancel', 'promptMessage', 'promptSubtitle', 'promptTitle'].sort(),
    );
  });

  it('getSecret resolves a valid lowercase hex string once the alias has been provisioned', async () => {
    // Populate the coherent store first (BLOCKER 4 fix): the default mock
    // rejects with NOT_FOUND when the alias is absent.
    await NativeBiometricVault.generateAndStoreSecret('enbox.wallet.root', {
      requireBiometrics: true,
      invalidateOnEnrollmentChange: true,
    });
    const secret = await NativeBiometricVault.getSecret('enbox.wallet.root', {
      promptTitle: 't',
      promptMessage: 'm',
      promptCancel: 'c',
    });
    expect(secret).toMatch(/^[0-9a-f]+$/);
    expect(secret.length).toBeGreaterThan(0);
  });

  it('forwards prompt options without promptSubtitle correctly', async () => {
    // Populate the coherent store first so getSecret resolves rather than
    // rejecting with NOT_FOUND.
    await NativeBiometricVault.generateAndStoreSecret('enbox.wallet.root', {
      requireBiometrics: true,
      invalidateOnEnrollmentChange: true,
    });
    const minimal = { promptTitle: 't', promptMessage: 'm', promptCancel: 'c' };
    await NativeBiometricVault.getSecret('enbox.wallet.root', minimal);
    expect(mock.getSecret).toHaveBeenCalledWith('enbox.wallet.root', minimal);
  });
});

describe('NativeBiometricVault — default mock is internally coherent (BLOCKER 4 fix)', () => {
  const prompt = {
    promptTitle: 'Unlock',
    promptMessage: 'msg',
    promptCancel: 'cancel',
  };

  it('hasSecret and getSecret agree: absent alias → hasSecret=false AND getSecret rejects NOT_FOUND', async () => {
    // Regression guard: the previous shipped default had hasSecret=false
    // while getSecret still resolved a hex string, letting consumers
    // "unlock" an uninitialized vault. The coherent default must surface
    // NOT_FOUND in lock-step with hasSecret=false.
    await expect(NativeBiometricVault.hasSecret('nope')).resolves.toBe(false);
    await expect(
      NativeBiometricVault.getSecret('nope', prompt),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('hasSecret and getSecret agree: provisioned alias → hasSecret=true AND getSecret resolves', async () => {
    await NativeBiometricVault.generateAndStoreSecret('enbox.wallet.root', {
      requireBiometrics: true,
      invalidateOnEnrollmentChange: true,
    });
    await expect(
      NativeBiometricVault.hasSecret('enbox.wallet.root'),
    ).resolves.toBe(true);
    const secret = await NativeBiometricVault.getSecret('enbox.wallet.root', prompt);
    expect(secret).toMatch(/^[0-9a-f]+$/);
  });

  it('deleteSecret is idempotent even when the alias is absent', async () => {
    // No prior generate → delete must still resolve (not reject).
    await expect(
      NativeBiometricVault.deleteSecret('never-stored'),
    ).resolves.toBeUndefined();
    // Second delete on the same missing alias must also resolve.
    await expect(
      NativeBiometricVault.deleteSecret('never-stored'),
    ).resolves.toBeUndefined();
  });

  it('store is reset between tests (no leakage of previously-provisioned aliases)', async () => {
    // This test runs AFTER the previous ones have provisioned
    // 'enbox.wallet.root'. If the reset in jest.setup.js beforeEach works
    // correctly, the alias must no longer be present here.
    await expect(
      NativeBiometricVault.hasSecret('enbox.wallet.root'),
    ).resolves.toBe(false);
  });
});

describe('NativeBiometricVault — rejection propagation preserves .code', () => {
  const prompt = {
    promptTitle: 'Unlock Enbox',
    promptMessage: 'Authenticate',
    promptCancel: 'Cancel',
  };

  it('USER_CANCELED — .code is preserved through the TurboModule surface', async () => {
    mock.getSecret.mockRejectedValueOnce(biometricError('USER_CANCELED', 'Cancelled by user'));

    await expect(
      NativeBiometricVault.getSecret('enbox.wallet.root', prompt),
    ).rejects.toMatchObject({ code: 'USER_CANCELED' });
  });

  it('KEY_INVALIDATED — .code is preserved (drives RecoveryRestore routing in Milestone 4)', async () => {
    mock.getSecret.mockRejectedValueOnce(
      biometricError('KEY_INVALIDATED', 'Key invalidated by biometric enrollment change'),
    );

    await expect(
      NativeBiometricVault.getSecret('enbox.wallet.root', prompt),
    ).rejects.toMatchObject({ code: 'KEY_INVALIDATED' });
  });

  it('NOT_FOUND — getSecret rejects with .code when alias is absent', async () => {
    mock.getSecret.mockRejectedValueOnce(
      biometricError('NOT_FOUND', 'No secret stored under alias'),
    );

    await expect(
      NativeBiometricVault.getSecret('enbox.wallet.root', prompt),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('.code survives the Promise boundary (no generic Error re-wrap)', async () => {
    mock.getSecret.mockRejectedValueOnce(biometricError('USER_CANCELED'));

    try {
      await NativeBiometricVault.getSecret('enbox.wallet.root', prompt);
      throw new Error('expected rejection');
    } catch (err) {
      // Must not be a bare Error without .code — that would mean a wrapper
      // somewhere dropped the native rejection code.
      expect(err).toBeDefined();
      expect((err as { code?: string }).code).toBe('USER_CANCELED');
    }
  });
});

describe('NativeBiometricVault — deleteSecret idempotence', () => {
  it('resolves (does not throw) when the alias does not exist', async () => {
    // The iOS impl treats errSecItemNotFound on SecItemDelete as success;
    // the Android impl treats "no key entry" as success. Both converge on
    // the JS surface: deleteSecret(missingAlias) resolves undefined.
    mock.deleteSecret.mockResolvedValueOnce(undefined);

    await expect(
      NativeBiometricVault.deleteSecret('enbox.wallet.does-not-exist'),
    ).resolves.toBeUndefined();
    expect(mock.deleteSecret).toHaveBeenCalledWith('enbox.wallet.does-not-exist');
  });

  it('can be called twice back-to-back on the same alias without throwing', async () => {
    mock.deleteSecret
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await expect(
      NativeBiometricVault.deleteSecret('enbox.wallet.root'),
    ).resolves.toBeUndefined();
    await expect(
      NativeBiometricVault.deleteSecret('enbox.wallet.root'),
    ).resolves.toBeUndefined();

    expect(mock.deleteSecret).toHaveBeenCalledTimes(2);
  });
});

describe('NativeBiometricVault — requireBiometrics flag semantics', () => {
  // Per validation-contract.md VAL-NATIVE-033, the contract is that
  // { requireBiometrics: false } must NOT silently fall through to an
  // unauthenticated Keychain/Keystore item. Both the iOS and Android native
  // implementations currently ignore the flag and always write a
  // biometric-gated entry (biometric-gated always), which is acceptable under
  // the contract. We pick the stricter variant here — reject deterministically
  // with VAULT_ERROR — and document that choice so Milestone 3's JS wrapper
  // can enforce it at the call site rather than relying on native fallback.
  //
  // Documented decision: the JS layer treats requireBiometrics=false as an
  // unsupported configuration for this mission and surfaces VAULT_ERROR.
  it('generateAndStoreSecret with requireBiometrics=false rejects deterministically with VAULT_ERROR', async () => {
    mock.generateAndStoreSecret.mockRejectedValueOnce(
      biometricError('VAULT_ERROR', 'requireBiometrics=false is not supported'),
    );

    await expect(
      NativeBiometricVault.generateAndStoreSecret('enbox.wallet.root', {
        requireBiometrics: false,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR' });
    expect(mock.generateAndStoreSecret).toHaveBeenCalledWith('enbox.wallet.root', {
      requireBiometrics: false,
    });
  });

  it('generateAndStoreSecret with requireBiometrics=true resolves (biometric-gated happy path)', async () => {
    await expect(
      NativeBiometricVault.generateAndStoreSecret('enbox.wallet.root', {
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('NativeBiometricVault — cross-platform error-code union invariance', () => {
  const prompt = {
    promptTitle: 'Unlock',
    promptMessage: 'msg',
    promptCancel: 'cancel',
  };

  // iOS rejections (as surfaced by RCTNativeBiometricVault.mm). Only the
  // eight codes that path produces — BIOMETRY_LOCKOUT_PERMANENT is
  // Android-only because LAError has no permanent-lockout surface.
  const IOS_CODES: BiometricErrorCode[] = [
    'USER_CANCELED',
    'BIOMETRY_UNAVAILABLE',
    'BIOMETRY_NOT_ENROLLED',
    'BIOMETRY_LOCKOUT',
    'KEY_INVALIDATED',
    'NOT_FOUND',
    'AUTH_FAILED',
    'VAULT_ERROR',
  ];

  // Android rejections (as surfaced by NativeBiometricVaultModule.kt). All
  // nine codes are produced: BiometricPrompt.ERROR_LOCKOUT_PERMANENT maps
  // distinctly to BIOMETRY_LOCKOUT_PERMANENT.
  const ANDROID_CODES: BiometricErrorCode[] = [
    'USER_CANCELED',
    'BIOMETRY_UNAVAILABLE',
    'BIOMETRY_NOT_ENROLLED',
    'BIOMETRY_LOCKOUT',
    'BIOMETRY_LOCKOUT_PERMANENT',
    'KEY_INVALIDATED',
    'NOT_FOUND',
    'AUTH_FAILED',
    'VAULT_ERROR',
  ];

  it('every simulated iOS rejection surfaces a canonical .code', async () => {
    for (const code of IOS_CODES) {
      mock.getSecret.mockRejectedValueOnce(biometricError(code));
      await expect(
        NativeBiometricVault.getSecret('enbox.wallet.root', prompt),
      ).rejects.toMatchObject({ code });
      expect(CANONICAL_ERROR_CODES).toContain(code);
    }
  });

  it('every simulated Android rejection surfaces a canonical .code', async () => {
    for (const code of ANDROID_CODES) {
      mock.getSecret.mockRejectedValueOnce(biometricError(code));
      await expect(
        NativeBiometricVault.getSecret('enbox.wallet.root', prompt),
      ).rejects.toMatchObject({ code });
      expect(CANONICAL_ERROR_CODES).toContain(code);
    }
  });

  it('the union of iOS ∪ Android codes equals the full nine-code canonical set', () => {
    const union = new Set<BiometricErrorCode>([...IOS_CODES, ...ANDROID_CODES]);
    const canonical = new Set<BiometricErrorCode>(CANONICAL_ERROR_CODES);

    expect(union.size).toBe(canonical.size);
    for (const code of canonical) {
      expect(union.has(code)).toBe(true);
    }
    expect(union.size).toBe(9);
  });

  it('the same symbolic code (e.g. USER_CANCELED) produces the same .code from both platforms', async () => {
    // iOS shape
    mock.getSecret.mockRejectedValueOnce(biometricError('USER_CANCELED', 'User cancelled (iOS)'));
    const iosErr = await NativeBiometricVault.getSecret('enbox.wallet.root', prompt).catch((e) => e);

    // Android shape — RCTPromiseRejectBlock(code, message) produces an Error
    // with .code that matches.
    mock.getSecret.mockRejectedValueOnce(biometricError('USER_CANCELED', 'Authentication cancelled (Android)'));
    const androidErr = await NativeBiometricVault.getSecret('enbox.wallet.root', prompt).catch((e) => e);

    expect((iosErr as { code: string }).code).toBe('USER_CANCELED');
    expect((androidErr as { code: string }).code).toBe('USER_CANCELED');
    expect((iosErr as { code: string }).code).toBe((androidErr as { code: string }).code);
  });
});
