/**
 * Focused primitive tests for `BiometricVault.lock()`.
 *
 * The auto-lock UX hook (Milestone 4, VAL-UX-035) will call this
 * primitive when the app moves to background. This suite pins the
 * primitive's contract independently of the UX wiring so the hook can
 * be layered on top with confidence:
 *
 *   1. `lock()` clears ONLY in-memory state (secret/seed/DID/CEK).
 *   2. `lock()` does NOT delete the native secret — the next unlock must
 *      still prompt biometrics against a surviving Keychain/Keystore
 *      entry (auto-lock semantics, not reset semantics).
 *   3. `lock()` is idempotent and callable on a locked / never-initialized
 *      vault without throwing.
 *   4. After `lock()`, the DID, encryption, and decryption surfaces all
 *      report VAULT_ERROR_LOCKED.
 *   5. `isInitialized()` still returns `true` after `lock()` — the vault
 *      is locked, not forgotten.
 *
 * Cross-refs: VAL-VAULT-010 (primary), VAL-VAULT-020 / VAL-VAULT-021
 * (auto-lock hook side, wired in a subsequent feature).
 */

import { WALLET_ROOT_KEY_ALIAS } from '@/lib/enbox/biometric-vault';

// ---------------------------------------------------------------------------
// Virtual mocks for ESM-only @enbox packages. Mirrors the style used by
// biometric-vault.test.ts so the vault can load under Jest.
// ---------------------------------------------------------------------------

jest.mock(
  '@enbox/dids',
  () => {
    class MockBearerDid {
      public readonly uri: string;
      public readonly metadata = {};
      public readonly document = {};
      public readonly keyManager: any;
      constructor(uri: string, keyManager?: any) {
        this.uri = uri;
        this.keyManager = keyManager;
      }
    }
    const mockCreate = jest.fn(async ({ keyManager, options }: any) => {
      const keys = Array.from(
        (keyManager as any)._predefinedKeys?.values?.() ?? [],
      );
      const first = keys[0] as any;
      const kid = first?.kid ?? 'no-key';
      const svcPart = options?.services?.[0]?.id
        ? `:${options.services[0].id}`
        : '';
      return new MockBearerDid(`did:dht:${kid}${svcPart}`, keyManager);
    });
    return {
      __esModule: true,
      BearerDid: MockBearerDid,
      DidDht: { create: mockCreate },
    };
  },
  { virtual: true },
);

jest.mock(
  '@enbox/agent',
  () => {
    // Minimal stub — BiometricVault instantiates this fallback but in these
    // tests we always pass `didFactory` so `bytesToPrivateKey` is never called.
    class MockAgentCryptoApi {}
    return { __esModule: true, AgentCryptoApi: MockAgentCryptoApi };
  },
  { virtual: true },
);

jest.mock(
  '@enbox/crypto',
  () => {
    class MockLocalKeyManager {
      async getKeyUri({ key }: { key: any }): Promise<string> {
        return `urn:jwk:${key.kid}`;
      }
    }
    return {
      __esModule: true,
      LocalKeyManager: MockLocalKeyManager,
      computeJwkThumbprint: jest.fn(
        async ({ jwk }: any) => `tp_${jwk.alg}_${jwk.kid ?? ''}`,
      ),
    };
  },
  { virtual: true },
);

// Module under test — import AFTER the mocks are registered.
import NativeBiometricVault from '@specs/NativeBiometricVault';
import { BiometricVault } from '@/lib/enbox/biometric-vault';

const native = NativeBiometricVault as unknown as {
  isBiometricAvailable: jest.Mock;
  generateAndStoreSecret: jest.Mock;
  getSecret: jest.Mock;
  hasSecret: jest.Mock;
  deleteSecret: jest.Mock;
};

// Fake BearerDid stand-in returned by the injected didFactory so that
// initialize() / unlock() can complete without relying on real DID
// derivation. The shape here matches what the vault actually reads.
const fakeBearerDid: any = { uri: 'did:dht:fake-lock-test' };

function makeTestVault(): BiometricVault {
  return new BiometricVault({
    didFactory: async () => fakeBearerDid,
    cryptoApi: {
      bytesToPrivateKey: async () => ({ kty: 'OKP', crv: 'Ed25519', alg: 'Ed25519', kid: 'fake' }),
    },
  });
}

describe('BiometricVault.lock() — primitive contract (auto-lock prerequisite)', () => {
  it('clears in-memory state and preserves the native secret', async () => {
    const vault = makeTestVault();

    await vault.initialize({});
    expect(vault.isLocked()).toBe(false);
    expect(await native.hasSecret(WALLET_ROOT_KEY_ALIAS)).toBe(true);

    const deleteCallsBefore = native.deleteSecret.mock.calls.length;

    await vault.lock();

    // In-memory state wiped → vault reports locked.
    expect(vault.isLocked()).toBe(true);

    // Native secret SURVIVES — lock() must not call deleteSecret.
    expect(native.deleteSecret.mock.calls.length).toBe(deleteCallsBefore);
    expect(await native.hasSecret(WALLET_ROOT_KEY_ALIAS)).toBe(true);

    // The vault is still "initialized" — locked ≠ forgotten. This is the
    // distinction the auto-lock hook relies on: lock() is the background
    // teardown primitive, reset() is the wipe primitive.
    expect(await vault.isInitialized()).toBe(true);
  });

  it('locked vault rejects getDid / encryptData / decryptData with VAULT_ERROR_LOCKED', async () => {
    const vault = makeTestVault();
    await vault.initialize({});

    // Capture a ciphertext while unlocked so the post-lock decryptData path
    // has a valid JWE to work against (if the vault were not locked).
    const plaintext = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const jwe = await vault.encryptData({ plaintext });

    await vault.lock();

    await expect(vault.getDid()).rejects.toMatchObject({
      code: 'VAULT_ERROR_LOCKED',
    });
    await expect(
      vault.encryptData({ plaintext }),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR_LOCKED' });
    await expect(vault.decryptData({ jwe })).rejects.toMatchObject({
      code: 'VAULT_ERROR_LOCKED',
    });
  });

  it('is idempotent — repeated lock() calls do not throw or call native APIs', async () => {
    const vault = makeTestVault();
    await vault.initialize({});

    const deleteCallsBefore = native.deleteSecret.mock.calls.length;
    await vault.lock();
    await vault.lock();
    await vault.lock();

    expect(vault.isLocked()).toBe(true);
    expect(native.deleteSecret.mock.calls.length).toBe(deleteCallsBefore);
    // hasSecret must still be true even after repeated lock() calls.
    expect(await native.hasSecret(WALLET_ROOT_KEY_ALIAS)).toBe(true);
  });

  it('lock() is safe on a never-initialized vault (no-op semantics)', async () => {
    const vault = makeTestVault();

    // Vault starts locked because no material has been loaded.
    expect(vault.isLocked()).toBe(true);

    await expect(vault.lock()).resolves.toBeUndefined();
    expect(vault.isLocked()).toBe(true);

    expect(native.generateAndStoreSecret).not.toHaveBeenCalled();
    expect(native.deleteSecret).not.toHaveBeenCalled();
    expect(native.getSecret).not.toHaveBeenCalled();
  });

  it('after lock(), a subsequent unlock() re-prompts biometrics via NativeBiometricVault.getSecret', async () => {
    const vault = makeTestVault();
    await vault.initialize({});

    const getSecretCallsAfterInit = native.getSecret.mock.calls.length;

    await vault.lock();
    expect(vault.isLocked()).toBe(true);

    // Unlock must prompt biometrics again — this is the end-to-end
    // auto-lock guarantee the hook ships (VAL-VAULT-021).
    await vault.unlock({});
    expect(native.getSecret.mock.calls.length).toBe(
      getSecretCallsAfterInit + 1,
    );
    expect(vault.isLocked()).toBe(false);
  });
});

// ===================================================================
// VAL-VAULT-028 — getMnemonic() re-derives the BIP-39 phrase from the
// vault's in-memory entropy so the pending-first-backup resume flow
// can re-show the 24 words WITHOUT triggering a second biometric
// prompt (the caller has already gone through `unlock()` / the new
// agent's `start()`).
// ===================================================================

describe('BiometricVault.getMnemonic() — re-derive phrase from in-memory secret (VAL-VAULT-028)', () => {
  // The 24-word all-`abandon` / `art` phrase is the BIP-39 phrase
  // that decodes to 32 zero bytes of entropy. Used here as a stable,
  // well-known fixture: initialize({ recoveryPhrase: FIXED_MNEMONIC })
  // round-trips to the exact same mnemonic via getMnemonic().
  const FIXED_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon ' +
    'abandon abandon abandon abandon abandon abandon ' +
    'abandon abandon abandon abandon abandon abandon ' +
    'abandon abandon abandon abandon abandon art';

  it('round-trips the mnemonic passed to initialize() — unlocked vault returns it verbatim', async () => {
    const vault = makeTestVault();
    await vault.initialize({ recoveryPhrase: FIXED_MNEMONIC });

    const mnemonic = await vault.getMnemonic();
    expect(mnemonic).toBe(FIXED_MNEMONIC);
  });

  it('does NOT trigger a native biometric prompt — entropy is already in memory', async () => {
    const vault = makeTestVault();
    await vault.initialize({ recoveryPhrase: FIXED_MNEMONIC });

    // getMnemonic MUST NOT trigger a native biometric prompt —
    // entropy is already in memory from initialize() / unlock().
    // getSecret() is the native method that would prompt biometrics
    // on a real device, so its call count is the canonical signal.
    const getSecretCountBefore = native.getSecret.mock.calls.length;
    await vault.getMnemonic();
    await vault.getMnemonic();
    await vault.getMnemonic();
    expect(native.getSecret.mock.calls.length).toBe(getSecretCountBefore);
  });

  it('returns the same mnemonic across initialize → lock → unlock → getMnemonic (round-trip)', async () => {
    const vault = makeTestVault();
    await vault.initialize({ recoveryPhrase: FIXED_MNEMONIC });
    expect(await vault.getMnemonic()).toBe(FIXED_MNEMONIC);

    // Simulate the auto-lock → re-foreground sequence that underlies
    // the resumePendingBackup() path.
    await vault.lock();
    expect(vault.isLocked()).toBe(true);

    await vault.unlock({});
    expect(vault.isLocked()).toBe(false);

    // Same entropy → same mnemonic. This pins the deterministic
    // round-trip so a future entropy-encoding refactor can't silently
    // break the pending-backup resume flow.
    expect(await vault.getMnemonic()).toBe(FIXED_MNEMONIC);
  });

  it('rejects with VAULT_ERROR_LOCKED when the vault is locked', async () => {
    const vault = makeTestVault();
    await vault.initialize({ recoveryPhrase: FIXED_MNEMONIC });
    await vault.lock();

    await expect(vault.getMnemonic()).rejects.toMatchObject({
      code: 'VAULT_ERROR_LOCKED',
    });
  });

  it('rejects on a never-initialized vault (locked is the default state)', async () => {
    const vault = makeTestVault();

    await expect(vault.getMnemonic()).rejects.toMatchObject({
      code: 'VAULT_ERROR_LOCKED',
    });
  });
});
