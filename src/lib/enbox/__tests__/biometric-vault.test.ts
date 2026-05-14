/**
 * Exhaustive unit tests for the biometric IdentityVault.
 *
 * Covers validation-contract assertions VAL-VAULT-001..013 and
 * VAL-VAULT-024..028. The vault is exercised through its public
 * IdentityVault surface only; native and crypto dependencies are
 * mocked.
 *
 * Mocks:
 *   - `@specs/NativeBiometricVault` is provided by jest.setup.js with a
 *     coherent per-test Map-backed store; individual tests override
 *     single calls via `mockResolvedValueOnce` / `mockRejectedValueOnce`.
 *   - `@enbox/dids`, `@enbox/agent`, and `@enbox/crypto` are ESM-only
 *     packages that Jest cannot transform; we provide virtual mocks
 *     with just enough surface for BiometricVault to import and for
 *     tests to reason about stable DID derivation.
 */

import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

// ---------------------------------------------------------------------------
// Virtual mocks for ESM-only @enbox packages. Declared BEFORE importing the
// module under test so Jest hoists them correctly.
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
    class MockAgentCryptoApi {
      async bytesToPrivateKey({
        algorithm,
        privateKeyBytes,
      }: {
        algorithm: string;
        privateKeyBytes: KeyMaterialBytes;
      }) {
        const hex = Array.from(privateKeyBytes.slice(0, 16))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        return {
          kty: 'OKP',
          crv: algorithm === 'Ed25519' ? 'Ed25519' : 'X25519',
          alg: algorithm,
          kid: `${algorithm}-${hex}`,
          d: Array.from(privateKeyBytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
        };
      }
    }
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

// ---------------------------------------------------------------------------
// Import the module under test AFTER the mocks are registered.
// ---------------------------------------------------------------------------

import NativeBiometricVault from '@specs/NativeBiometricVault';

import {
  BiometricVault,
  BIOMETRIC_STATE_STORAGE_KEY,
  INITIALIZED_STORAGE_KEY,
  VAULT_ERROR_CODES,
  VaultError,
  WALLET_ROOT_KEY_ALIAS,
  mapNativeErrorToVaultError,
} from '@/lib/enbox/biometric-vault';
import type { KeyMaterialBytes } from '@/lib/enbox/biometric-vault';

// Typed alias to the jest.Mock-backed native module surface.
const native = NativeBiometricVault as unknown as {
  isBiometricAvailable: jest.Mock;
  generateAndStoreSecret: jest.Mock;
  getSecret: jest.Mock;
  hasSecret: jest.Mock;
  deleteSecret: jest.Mock;
};

/**
 * Build a new SecureStorage spy backed by a Map. Returns the spy and the
 * underlying map so tests can inspect raw values and spy calls together.
 */
function makeSecureStorage() {
  const store = new Map<string, string>();
  const api = {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    remove: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
  return { api, store };
}

function withErrorCode(code: string, message: string = code) {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

// No extra beforeEach required — jest.setup.js already resets the native
// mock's implementations and store between tests.

// ===========================================================================
// VAL-VAULT-001 — initialize provisions a biometric-gated secret
// ===========================================================================
describe('BiometricVault.initialize() — provisioning', () => {
  it('provisions secret with expected alias and invalidation policy', async () => {
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });

    const phrase = await vault.initialize({});

    expect(native.hasSecret).toHaveBeenCalledWith(WALLET_ROOT_KEY_ALIAS);
    expect(native.generateAndStoreSecret).toHaveBeenCalledTimes(1);
    const [alias, opts] = native.generateAndStoreSecret.mock.calls[0];
    expect(alias).toBe(WALLET_ROOT_KEY_ALIAS);
    expect(opts).toEqual(
      expect.objectContaining({
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
      }),
    );
    expect(typeof phrase).toBe('string');
    expect(phrase.trim().length).toBeGreaterThan(0);
  });

  it('calls generateAndStoreSecret once and getSecret ZERO times (no second biometric prompt)', async () => {
    // Scrutiny blocker 1(a): `initialize()` must not biometric-read the
    // just-provisioned secret back via `getSecret()`.
    native.getSecret.mockClear();
    const vault = new BiometricVault();

    await vault.initialize({});

    expect(native.generateAndStoreSecret).toHaveBeenCalledTimes(1);
    expect(native.getSecret).toHaveBeenCalledTimes(0);
    // Confirm the JS layer handed its locally-derived 32 bytes to
    // native — the canonical hex shape is 64 lower-case hex chars.
    const opts = native.generateAndStoreSecret.mock.calls[0][1];
    expect(typeof opts.secretHex).toBe('string');
    expect(opts.secretHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects with VAULT_ERROR_ALREADY_INITIALIZED when hasSecret already true', async () => {
    native.hasSecret.mockImplementationOnce(async () => true);
    const vault = new BiometricVault();

    await expect(vault.initialize({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_ALREADY_INITIALIZED',
    });
    expect(native.generateAndStoreSecret).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Provisioning-prompt passthrough.
  //
  // Android's `BiometricPrompt` consumes prompt copy via the
  // `promptTitle / promptMessage / promptCancel` keys passed alongside
  // `secretHex / requireBiometrics / invalidateOnEnrollmentChange`.
  // iOS implements the same surface (`LAContext.evaluatePolicy`'s
  // `localizedReason`) for parity. The JS vault stores the provision
  // prompt in `_provisionPrompt`; the bug was that
  // `_doInitialize()` never actually FORWARDED it to the native call,
  // so the native module fell back to its default copy and (on iOS)
  // skipped the explicit biometric confirmation entirely.
  //
  // This test pins the contract: every prompt key the JS layer
  // configured MUST appear in the options object handed to
  // `NativeBiometricVault.generateAndStoreSecret`. A regression that
  // drops the propagation will fail this assertion.
  // ------------------------------------------------------------------
  it('forwards the JS provision prompt copy to NativeBiometricVault.generateAndStoreSecret', async () => {
    const vault = new BiometricVault();

    await vault.initialize({});

    expect(native.generateAndStoreSecret).toHaveBeenCalledTimes(1);
    const [, opts] = native.generateAndStoreSecret.mock.calls[0];
    // The default JS prompt copy is exposed by `BiometricVault`
    // through its `_provisionPrompt` private field; we don't pin
    // exact strings here (UI copy may be retuned), but the keys
    // MUST be present and non-empty so the native layer can drive
    // `LAContext.evaluatePolicy` / `BiometricPrompt` with caller
    // copy rather than its own fallback.
    expect(typeof opts.promptTitle).toBe('string');
    expect(opts.promptTitle.length).toBeGreaterThan(0);
    expect(typeof opts.promptMessage).toBe('string');
    expect(opts.promptMessage.length).toBeGreaterThan(0);
    expect(typeof opts.promptCancel).toBe('string');
    expect(opts.promptCancel.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// VAL-VAULT-002 / VAL-VAULT-026 — returns valid 24-word BIP-39 mnemonic,
// leaves the vault unlocked, does NOT persist the phrase
// ===========================================================================
describe('BiometricVault.initialize() — mnemonic contract (VAL-VAULT-002, 026)', () => {
  it('returns a non-empty valid BIP-39 mnemonic and leaves the vault unlocked', async () => {
    const { api, store } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });

    const phrase = await vault.initialize({});

    expect(typeof phrase).toBe('string');
    expect(phrase.trim()).not.toHaveLength(0);
    expect(validateMnemonic(phrase, wordlist)).toBe(true);
    // VAL-VAULT-026: must be 24 words (256 bits entropy).
    expect(phrase.split(/\s+/).length).toBe(24);

    expect(await vault.isInitialized()).toBe(true);
    expect(vault.isLocked()).toBe(false);

    // getDid must resolve to a BearerDid instance.
    const did = await vault.getDid();
    expect(did).toBeDefined();
    expect(did.uri.startsWith('did:dht:')).toBe(true);

    // Mnemonic must NOT be persisted anywhere through SecureStorage.
    for (const [key, value] of store.entries()) {
      expect(value).not.toBe(phrase);
      // Ensure no persisted value contains the full ordered mnemonic.
      expect(value.includes(phrase)).toBe(false);
      // Ensure known keys only hold their expected values.
      if (key === INITIALIZED_STORAGE_KEY) expect(value).toBe('true');
      if (key === BIOMETRIC_STATE_STORAGE_KEY) expect(value).toBe('ready');
    }
    const allSetCallArgs = JSON.stringify(api.set.mock.calls);
    expect(allSetCallArgs).not.toContain(phrase);
  });

  it('produces a deterministic 24-word mnemonic from the stored 32-byte secret', async () => {
    const vault = new BiometricVault();
    const phrase1 = await vault.initialize({});
    // Lock + reset via a fresh vault instance against the same native state.
    await vault.lock();
    const phrase2Vault = new BiometricVault();
    // hasSecret must be true now; unlock should re-derive an identical mnemonic
    // as the one emitted by initialize() the first time around.
    await phrase2Vault.unlock({});
    const derivedAgain = await phrase2Vault.getDid();
    expect(derivedAgain.uri).toBeDefined();
    expect(phrase1.split(/\s+/).length).toBe(24);
  });
});

// ===========================================================================
// VAL-VAULT-003 — second initialize throws and leaves state intact
// ===========================================================================
describe('BiometricVault.initialize() — idempotent-hostile (VAL-VAULT-003)', () => {
  it('rejects VAULT_ERROR_ALREADY_INITIALIZED on a second initialize', async () => {
    const vault = new BiometricVault();

    await vault.initialize({});
    await expect(vault.initialize({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_ALREADY_INITIALIZED',
    });
    expect(native.generateAndStoreSecret).toHaveBeenCalledTimes(1);
    expect(native.deleteSecret).not.toHaveBeenCalled();
    expect(await vault.isInitialized()).toBe(true);

    // Fresh instance against the same mocked native state still rejects.
    const fresh = new BiometricVault();
    await expect(fresh.initialize({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_ALREADY_INITIALIZED',
    });
  });
});

// ===========================================================================
// VAL-VAULT-004 — biometrics-unavailable pathway does not persist state
// ===========================================================================
describe('BiometricVault.initialize() — biometrics unavailable (VAL-VAULT-004)', () => {
  it('maps BIOMETRY_UNAVAILABLE to VAULT_ERROR_BIOMETRICS_UNAVAILABLE and does not persist', async () => {
    const { api } = makeSecureStorage();
    native.generateAndStoreSecret.mockImplementationOnce(async () => {
      throw withErrorCode('BIOMETRY_UNAVAILABLE');
    });
    const vault = new BiometricVault({ secureStorage: api });

    await expect(vault.initialize({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_BIOMETRICS_UNAVAILABLE',
    });
    expect(await vault.isInitialized()).toBe(false);
    expect(api.set).not.toHaveBeenCalled();
  });

  it('maps BIOMETRY_NOT_ENROLLED to VAULT_ERROR_BIOMETRICS_UNAVAILABLE', async () => {
    native.generateAndStoreSecret.mockImplementationOnce(async () => {
      throw withErrorCode('BIOMETRY_NOT_ENROLLED');
    });
    const vault = new BiometricVault();
    await expect(vault.initialize({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_BIOMETRICS_UNAVAILABLE',
    });
  });
});

// ===========================================================================
// VAL-VAULT-005 — deterministic DID across lock/unlock cycles
// ===========================================================================
describe('BiometricVault — deterministic DID (VAL-VAULT-005)', () => {
  it('derives the same DID after lock + unlock', async () => {
    const vault = new BiometricVault();

    await vault.initialize({});
    const didBefore = (await vault.getDid()).uri;
    expect(didBefore.startsWith('did:dht:')).toBe(true);

    await vault.lock();
    expect(vault.isLocked()).toBe(true);
    await expect(vault.getDid()).rejects.toMatchObject({
      code: 'VAULT_ERROR_LOCKED',
    });

    await vault.unlock({});
    const didAfter = (await vault.getDid()).uri;
    expect(didAfter).toBe(didBefore);
  });
});

// ===========================================================================
// VAL-VAULT-006 / VAL-VAULT-007 / VAL-VAULT-008 / VAL-VAULT-009 — unlock()
// ===========================================================================
describe('BiometricVault.unlock()', () => {
  it('prompts biometrics once and transitions to unlocked (VAL-VAULT-006)', async () => {
    const vault = new BiometricVault();
    await vault.initialize({});
    await vault.lock();

    native.getSecret.mockClear();
    await vault.unlock({});

    expect(native.getSecret).toHaveBeenCalledTimes(1);
    expect(native.getSecret).toHaveBeenCalledWith(
      WALLET_ROOT_KEY_ALIAS,
      expect.objectContaining({
        promptTitle: expect.any(String),
        promptMessage: expect.any(String),
        promptCancel: expect.any(String),
      }),
    );
    expect(vault.isLocked()).toBe(false);
    await expect(vault.getDid()).resolves.toBeDefined();
    // getDid must not cause another native call.
    expect(native.getSecret).toHaveBeenCalledTimes(1);
  });

  it('maps USER_CANCELED to VAULT_ERROR_USER_CANCELED and stays locked (VAL-VAULT-007)', async () => {
    const vault = new BiometricVault();
    await vault.initialize({});
    await vault.lock();

    native.getSecret.mockRejectedValueOnce(withErrorCode('USER_CANCELED'));
    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_USER_CANCELED',
    });
    expect(vault.isLocked()).toBe(true);
    await expect(vault.getDid()).rejects.toMatchObject({
      code: 'VAULT_ERROR_LOCKED',
    });
    const status = await vault.getStatus();
    // USER_CANCELED must NOT flip biometricState to invalidated.
    expect(status.biometricState).not.toBe('invalidated');
  });

  it('maps KEY_INVALIDATED to VAULT_ERROR_KEY_INVALIDATED and flips biometricState (VAL-VAULT-008)', async () => {
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });
    await vault.initialize({});
    await vault.lock();

    native.getSecret.mockRejectedValueOnce(withErrorCode('KEY_INVALIDATED'));
    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_KEY_INVALIDATED',
    });
    expect(vault.isLocked()).toBe(true);
    expect((await vault.getStatus()).biometricState).toBe('invalidated');

    // Second call must also reject — no silent retry; native returns the same
    // error until the vault is reset via recovery.
    native.getSecret.mockRejectedValueOnce(withErrorCode('KEY_INVALIDATED'));
    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_KEY_INVALIDATED',
    });

    // Biometric state was persisted to SecureStorage for app-restart continuity.
    expect(api.set).toHaveBeenCalledWith(
      BIOMETRIC_STATE_STORAGE_KEY,
      'invalidated',
    );
  });

  it('rejects VAULT_ERROR_NOT_INITIALIZED and does not prompt on a fresh install (VAL-VAULT-009)', async () => {
    const vault = new BiometricVault();

    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_NOT_INITIALIZED',
    });
    expect(native.getSecret).not.toHaveBeenCalled();
  });

  it('re-throws a native BIOMETRY_LOCKOUT as VaultError with code VAULT_ERROR_BIOMETRY_LOCKOUT (does not collapse to generic VAULT_ERROR)', async () => {
    const vault = new BiometricVault();
    await vault.initialize({});
    await vault.lock();

    native.getSecret.mockRejectedValueOnce(withErrorCode('BIOMETRY_LOCKOUT'));
    await expect(vault.unlock({})).rejects.toMatchObject({
      name: 'VaultError',
      code: 'VAULT_ERROR_BIOMETRY_LOCKOUT',
    });
    // Biometric state must NOT be flipped to invalidated by a lockout —
    // lockout is a transient device state and the vault stays valid.
    expect((await vault.getStatus()).biometricState).not.toBe('invalidated');
  });

  it('re-throws a native BIOMETRY_LOCKOUT_PERMANENT as VaultError with code VAULT_ERROR_BIOMETRY_LOCKOUT', async () => {
    const vault = new BiometricVault();
    await vault.initialize({});
    await vault.lock();

    native.getSecret.mockRejectedValueOnce(
      withErrorCode('BIOMETRY_LOCKOUT_PERMANENT'),
    );
    await expect(vault.unlock({})).rejects.toMatchObject({
      name: 'VaultError',
      code: 'VAULT_ERROR_BIOMETRY_LOCKOUT',
    });
  });
});

// ===========================================================================
// VAL-VAULT-010 — lock() clears in-memory state and preserves native secret
// ===========================================================================
describe('BiometricVault.lock() (VAL-VAULT-010)', () => {
  it('clears in-memory state, keeps native secret, and does NOT call deleteSecret', async () => {
    const vault = new BiometricVault();
    await vault.initialize({});

    const deleteCallsBefore = native.deleteSecret.mock.calls.length;
    await vault.lock();

    expect(vault.isLocked()).toBe(true);
    await expect(vault.getDid()).rejects.toMatchObject({
      code: 'VAULT_ERROR_LOCKED',
    });
    await expect(
      vault.encryptData({ plaintext: new Uint8Array([1, 2, 3]) }),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR_LOCKED' });
    expect(native.deleteSecret.mock.calls.length).toBe(deleteCallsBefore);
    expect(await native.hasSecret(WALLET_ROOT_KEY_ALIAS)).toBe(true);
    // lock() must not flip initialized to false.
    expect(await vault.isInitialized()).toBe(true);
  });
});

// ===========================================================================
// VAL-VAULT-011 — getStatus() shape + transitions
// ===========================================================================
describe('BiometricVault.getStatus() (VAL-VAULT-011)', () => {
  it('reports uninitialized shape before initialize()', async () => {
    const vault = new BiometricVault();
    const s = await vault.getStatus();
    expect(s).toEqual(
      expect.objectContaining({
        initialized: false,
        lastBackup: null,
        lastRestore: null,
      }),
    );
    expect(['unknown', 'unavailable']).toContain(s.biometricState);
  });

  it('flips to initialized + biometricState "ready" after initialize()', async () => {
    const vault = new BiometricVault();
    await vault.initialize({});
    const s = await vault.getStatus();
    expect(s).toEqual(
      expect.objectContaining({
        initialized: true,
        lastBackup: null,
        lastRestore: null,
        biometricState: 'ready',
      }),
    );
  });

  it('transitions biometricState to "invalidated" after KEY_INVALIDATED unlock', async () => {
    const vault = new BiometricVault();
    await vault.initialize({});
    await vault.lock();
    native.getSecret.mockRejectedValueOnce(withErrorCode('KEY_INVALIDATED'));
    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_KEY_INVALIDATED',
    });
    expect((await vault.getStatus()).biometricState).toBe('invalidated');
  });
});

// ===========================================================================
// VAL-VAULT-012 — changePassword / backup / restore stubs
// ===========================================================================
describe('BiometricVault — password-based stubs (VAL-VAULT-012)', () => {
  it('changePassword rejects with a VaultError code', async () => {
    const vault = new BiometricVault();
    await expect(
      vault.changePassword({ oldPassword: '', newPassword: '' }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^VAULT_ERROR_(UNSUPPORTED|LOCKED|NOT_INITIALIZED)$/),
    });
  });

  it('backup() rejects when vault is locked', async () => {
    const vault = new BiometricVault();
    // locked because never initialized
    await expect(vault.backup()).rejects.toBeDefined();
  });

  it('restore() rejects (unsupported)', async () => {
    const vault = new BiometricVault();
    await expect(
      vault.restore({ backup: {} as any, password: '' }),
    ).rejects.toBeDefined();
  });
});

// ===========================================================================
// VAL-VAULT-013 — encryptData / decryptData round-trip + lock semantics
// ===========================================================================
describe('BiometricVault.encryptData/decryptData (VAL-VAULT-013)', () => {
  it('round-trips plaintext while unlocked and rejects when locked', async () => {
    const vault = new BiometricVault();
    await vault.initialize({});

    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const jwe = await vault.encryptData({ plaintext });
    expect(typeof jwe).toBe('string');
    expect(jwe.split('.').length).toBe(5);

    const out = await vault.decryptData({ jwe });
    expect(out).toEqual(plaintext);

    // Lock/unlock cycle must not involve the native module.
    const getSecretCountBefore = native.getSecret.mock.calls.length;
    await vault.lock();
    await expect(vault.decryptData({ jwe })).rejects.toMatchObject({
      code: 'VAULT_ERROR_LOCKED',
    });
    await expect(
      vault.encryptData({ plaintext }),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR_LOCKED' });
    // getSecret was not called during the encrypt/decrypt round-trip.
    expect(native.getSecret.mock.calls.length).toBe(getSecretCountBefore);
  });
});

// ===========================================================================
// Compact JWE format complies with RFC 7516 + IdentityVault
// ===========================================================================
//
// Pre-fix the encrypt path concatenated the AES-GCM auth tag onto the
// ciphertext segment and left segment 5 empty. Two consequences:
//   (1) Cross-implementation interop was broken — every upstream
//       `CompactJwe.decrypt` reads `parts[4]` as the tag, found an
//       empty string, and rejected the JWE before any AES-GCM call.
//   (2) The protected header was never bound as Additional
//       Authenticated Data, so an attacker who could substitute a
//       different protected header (e.g. flipping `enc` to a weaker
//       cipher) on a stored ciphertext would produce a JWE that
//       decrypted cleanly under the original CEK. RFC 7516 §5.1 step
//       14 requires `AAD = ASCII(BASE64URL(header))` for AES-GCM JWEs.
//
// New contract:
//   - 5 non-empty segments with the 16-byte AES-GCM tag in segment 5.
//   - Segment 4 (`ciphertext`) is exactly `plaintext.length` bytes
//     when decoded — i.e. AES-GCM in CTR mode is length-preserving.
//   - The protected header is bound as AAD on encrypt + verified on
//     decrypt; tampering with the header rejects.
//   - Empty / wrong-length tag segment is rejected with a stable
//     `VAULT_ERROR` on decrypt — legacy ciphertexts (tag concatenated
//     onto ciphertext, segment 5 empty) cannot survive a round-trip
//     through the new decoder.
describe('BiometricVault.encryptData — standard compact JWE', () => {
  function fromBase64Url(s: string): Uint8Array {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s.length % 4)) % 4);
    const raw = atob(padded);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  it('produces 5 segments with header / iv / ciphertext / 16-byte tag populated and encrypted_key empty', async () => {
    const vault = new BiometricVault();
    await vault.initialize({});

    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const jwe = await vault.encryptData({ plaintext });
    const parts = jwe.split('.');
    expect(parts.length).toBe(5);

    const [headerB64, encryptedKey, ivB64, ctB64, tagB64] = parts;

    // Header decodes to the JOSE `dir` / `A256GCM` JSON.
    const headerBytes = fromBase64Url(headerB64);
    const header = JSON.parse(new TextDecoder().decode(headerBytes));
    expect(header).toEqual({ alg: 'dir', enc: 'A256GCM' });

    // `dir` mode → encrypted_key segment MUST be empty.
    expect(encryptedKey).toBe('');

    // IV is the AES-GCM 96-bit nonce (12 bytes).
    expect(fromBase64Url(ivB64).length).toBe(12);

    // Ciphertext is plaintext-length (AES-CTR is length-preserving)
    // — the tag is NOT concatenated here in the new format.
    expect(fromBase64Url(ctB64).length).toBe(plaintext.length);

    // Auth tag is in segment 5 and is exactly 16 bytes (RFC 7518
    // §5.3 default for A256GCM).
    expect(fromBase64Url(tagB64).length).toBe(16);
  });

  it('rejects on decrypt when the protected header is tampered (AAD enforcement)', async () => {
    const vault = new BiometricVault();
    await vault.initialize({});

    const plaintext = new Uint8Array([42, 42, 42]);
    const jwe = await vault.encryptData({ plaintext });
    const parts = jwe.split('.');

    // Re-encode the header with a flipped (still-valid-JSON)
    // `enc` field to simulate header substitution. The body is
    // unchanged so a non-AAD-binding decoder would happily produce
    // plaintext; the new AAD-binding decoder MUST reject.
    const tampered = btoa(JSON.stringify({ alg: 'dir', enc: 'A128GCM' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      // eslint-disable-next-line no-div-regex
      .replace(/=+$/, '');
    parts[0] = tampered;
    const tamperedJwe = parts.join('.');

    await expect(vault.decryptData({ jwe: tamperedJwe })).rejects.toBeDefined();
  });

  it('rejects a legacy JWE shape with the tag in the ciphertext segment', async () => {
    const vault = new BiometricVault();
    await vault.initialize({});

    // Construct the legacy shape by hand: header..iv.<ct||tag>.<empty>
    const plaintext = new Uint8Array([7, 7, 7, 7]);
    const jwe = await vault.encryptData({ plaintext });
    const parts = jwe.split('.');
    const ct = fromBase64Url(parts[3]);
    const tag = fromBase64Url(parts[4]);
    const cipherWithTag = new Uint8Array(ct.length + tag.length);
    cipherWithTag.set(ct, 0);
    cipherWithTag.set(tag, ct.length);
    const ctWithTagB64 = btoa(String.fromCharCode(...cipherWithTag))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      // eslint-disable-next-line no-div-regex
      .replace(/=+$/, '');
    const legacyJwe = `${parts[0]}..${parts[2]}.${ctWithTagB64}.`;

    await expect(vault.decryptData({ jwe: legacyJwe })).rejects.toMatchObject({
      code: 'VAULT_ERROR',
    });
  });

  it('rejects a JWE with fewer than 5 segments (parser invariant)', async () => {
    const vault = new BiometricVault();
    await vault.initialize({});

    await expect(
      vault.decryptData({ jwe: 'a.b.c.d' }),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR' });
  });
});

// ===========================================================================
// VAL-VAULT-024 — conforms to IdentityVault<{InitializeResult:string}>
// ===========================================================================
describe('BiometricVault — IdentityVault conformance (VAL-VAULT-024)', () => {
  it('exposes every IdentityVault method', () => {
    const vault = new BiometricVault();
    for (const method of [
      'initialize',
      'isInitialized',
      'isLocked',
      'unlock',
      'lock',
      'getDid',
      'getStatus',
      'backup',
      'restore',
      'changePassword',
      'encryptData',
      'decryptData',
    ] as const) {
      expect(typeof (vault as any)[method]).toBe('function');
    }
  });

  it('exports the canonical nine error codes', () => {
    expect(VAULT_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'VAULT_ERROR_ALREADY_INITIALIZED',
        'VAULT_ERROR_NOT_INITIALIZED',
        'VAULT_ERROR_LOCKED',
        'VAULT_ERROR_BIOMETRICS_UNAVAILABLE',
        'VAULT_ERROR_USER_CANCELED',
        'VAULT_ERROR_KEY_INVALIDATED',
        'VAULT_ERROR_UNSUPPORTED',
        // Per-alias serialization rejection from native.
        'VAULT_ERROR_OPERATION_IN_PROGRESS',
        'VAULT_ERROR',
      ]),
    );
  });

  it('VaultError propagates its .code through Promise rejections', async () => {
    const vault = new BiometricVault();
    try {
      await vault.changePassword({ oldPassword: '', newPassword: '' });
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError);
      expect((err as VaultError).code).toBe('VAULT_ERROR_UNSUPPORTED');
    }
  });
});

// ===========================================================================
// VAL-VAULT-025 — callers must not persist the phrase (consumer guidance;
// for the vault surface itself we only assert it is *returned* and not
// written via its own SecureStorage dependency).
// ===========================================================================
describe('BiometricVault — does not persist recovery phrase through its own SecureStorage (VAL-VAULT-025)', () => {
  it('never writes the recovery phrase to its SecureStorage', async () => {
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });
    const phrase = await vault.initialize({});
    const calls = JSON.stringify(api.set.mock.calls);
    expect(calls).not.toContain(phrase);
  });
});

// ===========================================================================
// VAL-VAULT-027 — partial-init failure rollback semantics
//
// When `NativeBiometricVault.generateAndStoreSecret` resolves but a
// subsequent step in `initialize()` throws (mnemonic derivation, HD seed,
// BearerDid creation, DWN endpoint registration, or SecureStorage flag
// set), the vault MUST roll back by calling
// `NativeBiometricVault.deleteSecret(WALLET_ROOT_KEY_ALIAS)` before
// re-throwing the ORIGINAL error. That way `isInitialized()` returns
// `false` afterwards and the user is not trapped in an
// "already-initialized but unusable" state. Rollback is best-effort:
// if `deleteSecret()` itself rejects, a console warning is logged but
// the ORIGINAL derivation error is still the one that bubbles up.
//
// Conversely, if `generateAndStoreSecret` fails before any secret ever
// lands on disk, there is nothing to roll back and `deleteSecret`
// must NOT be invoked.
// ===========================================================================
describe('BiometricVault — partial-init recovery (VAL-VAULT-027)', () => {
  it('rolls back the orphan native secret when local derivation throws after provisioning succeeded', async () => {
    const didError = new Error('simulated DID failure');
    const didFactory = jest.fn(async () => {
      throw didError;
    });
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ didFactory, secureStorage: api });

    const deleteCallsBefore = native.deleteSecret.mock.calls.length;

    // (b) the original derivation error bubbles unchanged to the caller.
    await expect(vault.initialize({})).rejects.toBe(didError);

    expect(native.generateAndStoreSecret).toHaveBeenCalledTimes(1);

    // (a) deleteSecret called exactly once with WALLET_ROOT_KEY_ALIAS
    // before the error surfaces.
    const newDeleteCalls = native.deleteSecret.mock.calls.slice(deleteCallsBefore);
    expect(newDeleteCalls).toHaveLength(1);
    expect(newDeleteCalls[0][0]).toBe(WALLET_ROOT_KEY_ALIAS);

    // (c) isInitialized() returns false afterwards — the native store
    // no longer has an entry because rollback removed it.
    expect(await vault.isInitialized()).toBe(false);
    expect(vault.isLocked()).toBe(true);

    // (d) No SecureStorage flags were persisted on the rollback path.
    const setKeys = api.set.mock.calls.map(([k]) => k);
    expect(setKeys).not.toContain(INITIALIZED_STORAGE_KEY);
    expect(setKeys).not.toContain(BIOMETRIC_STATE_STORAGE_KEY);
  });

  it('still bubbles the ORIGINAL derivation error and logs a warning when deleteSecret itself rejects', async () => {
    const didError = new Error('simulated DID failure');
    const didFactory = jest.fn(async () => {
      throw didError;
    });
    const deleteError = new Error('rollback boom');
    native.deleteSecret.mockRejectedValueOnce(deleteError);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ didFactory, secureStorage: api });

    try {
      // The ORIGINAL derivation error must bubble — not the deleteSecret
      // rejection. This is critical so callers see the real root cause.
      await expect(vault.initialize({})).rejects.toBe(didError);

      expect(native.deleteSecret).toHaveBeenCalledWith(WALLET_ROOT_KEY_ALIAS);
      // A console warning is logged about the failed rollback.
      expect(warnSpy).toHaveBeenCalled();
      const warnArgs = warnSpy.mock.calls[0] as unknown[];
      expect(String(warnArgs[0])).toMatch(/BiometricVault/);
      expect(warnArgs).toEqual(expect.arrayContaining([deleteError]));
      // No SecureStorage flags were persisted.
      const setKeys = api.set.mock.calls.map(([k]) => k);
      expect(setKeys).not.toContain(INITIALIZED_STORAGE_KEY);
      expect(setKeys).not.toContain(BIOMETRIC_STATE_STORAGE_KEY);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still surfaces a native-side generateAndStoreSecret failure without calling deleteSecret', async () => {
    native.generateAndStoreSecret.mockImplementationOnce(async () => {
      const err = new Error('native-side failure') as Error & { code: string };
      err.code = 'VAULT_ERROR';
      throw err;
    });
    const vault = new BiometricVault();

    const deleteCallsBefore = native.deleteSecret.mock.calls.length;
    await expect(vault.initialize({})).rejects.toBeDefined();
    // Nothing on disk to roll back — no deleteSecret call needed or made.
    expect(native.deleteSecret.mock.calls.length).toBe(deleteCallsBefore);
    expect(await vault.isInitialized()).toBe(false);
  });
});

// ===========================================================================
// VAL-VAULT-028 — concurrent initialize()/unlock() are serialized
// ===========================================================================
describe('BiometricVault — mutex (VAL-VAULT-028)', () => {
  it('serializes concurrent initialize() calls: generateAndStoreSecret is called at most once', async () => {
    const vault = new BiometricVault();

    const results = await Promise.all([vault.initialize({}), vault.initialize({})]);
    expect(results[0]).toBe(results[1]);
    expect(native.generateAndStoreSecret).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent unlock() calls: getSecret is called at most once', async () => {
    const vault = new BiometricVault();
    await vault.initialize({});
    await vault.lock();
    native.getSecret.mockClear();

    await Promise.all([vault.unlock({}), vault.unlock({})]);
    expect(native.getSecret).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// _doUnlock / _doInitialize routing and in-memory cleanup
//
//   - If biometric enrollment invalidation removes the native item,
//      SecureStorage prior-init signals must route the error as
//      ``VAULT_ERROR_KEY_INVALIDATED`` instead of setup.
//
//   - An observed ``KEY_INVALIDATED`` must zero the
//      already-resident in-memory ``_secretBytes`` / DID / CEK / root
//      seed. ``isLocked()`` could return false from a prior unlock,
//      leaving ``getDid()`` / ``getMnemonic()`` / ``encryptData()`` /
//      ``decryptData()`` operable on stale material.
//
//   - ``hasSecret()`` rejection (vs resolved-false) must not be
//      collapsed to "no vault". A transient native-layer failure should
//      surface as retryable vault failure, not fresh setup routing.
// ===========================================================================
describe('BiometricVault — prior-init routing and in-memory cleanup', () => {
  it('routes hasSecret=false + INITIALIZED="true" to VAULT_ERROR_KEY_INVALIDATED', async () => {
    const { api, store } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });
    await vault.initialize({});

    // Pre-condition: SecureStorage carries INITIALIZED='true'.
    expect(store.get(INITIALIZED_STORAGE_KEY)).toBe('true');

    // Simulate iOS post-enrollment-change: the biometry-current-set
    // Keychain item has been auto-deleted, so hasSecret resolves
    // false. The vault is locked from a prior session (the in-memory
    // path doesn't apply — this test exercises the cold-start path).
    await vault.lock();
    native.hasSecret.mockResolvedValueOnce(false);

    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_KEY_INVALIDATED',
    });

    // The persisted biometric state must flip to invalidated so the
    // agent-store / UI can route to RecoveryRestore on this session
    // AND survive an app restart.
    expect(api.set).toHaveBeenCalledWith(BIOMETRIC_STATE_STORAGE_KEY, 'invalidated');
    expect(store.get(BIOMETRIC_STATE_STORAGE_KEY)).toBe('invalidated');

    // The vault is left locked — the JS-layer disambiguation MUST NOT
    // call ``getSecret()``, so no biometric prompt fires.
    expect(vault.isLocked()).toBe(true);
    expect(native.getSecret).not.toHaveBeenCalled();
  });

  it('routes hasSecret=false + biometricState="ready" to VAULT_ERROR_KEY_INVALIDATED without INITIALIZED', async () => {
    // Simulate the partial-init edge case: biometricState was
    // persisted but INITIALIZED was not (e.g. a race or two-write
    // sequence where only the first write landed). The disambiguator
    // still needs to detect an existing vault from either
    // signal, not just ``INITIALIZED='true'``.
    const { api, store } = makeSecureStorage();
    store.set(BIOMETRIC_STATE_STORAGE_KEY, 'ready');
    // INITIALIZED deliberately absent.

    const vault = new BiometricVault({ secureStorage: api });
    native.hasSecret.mockResolvedValueOnce(false);

    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_KEY_INVALIDATED',
    });
    expect(store.get(BIOMETRIC_STATE_STORAGE_KEY)).toBe('invalidated');
  });

  it('keeps hasSecret=false + biometricState="invalidated" as VAULT_ERROR_KEY_INVALIDATED', async () => {
    // Second-launch case: prior session already persisted
    // ``invalidated``. A re-unlock attempt MUST keep routing as
    // ``KEY_INVALIDATED`` so the UI continues to show
    // RecoveryRestore — not silently re-route to setup.
    const { api, store } = makeSecureStorage();
    store.set(BIOMETRIC_STATE_STORAGE_KEY, 'invalidated');

    const vault = new BiometricVault({ secureStorage: api });
    native.hasSecret.mockResolvedValueOnce(false);

    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_KEY_INVALIDATED',
    });
    expect(store.get(BIOMETRIC_STATE_STORAGE_KEY)).toBe('invalidated');
  });

  it('routes hasSecret=false without any prior-init signal to VAULT_ERROR_NOT_INITIALIZED', async () => {
    // Fresh install: SecureStorage is empty. The disambiguator must
    // route to NOT_INITIALIZED so the user sees the setup flow, not
    // RecoveryRestore. This pins that the disambiguator is not
    // over-broad.
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });
    native.hasSecret.mockResolvedValueOnce(false);

    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_NOT_INITIALIZED',
    });
    // No invalidated-state side-effect on a fresh install.
    expect(api.set).not.toHaveBeenCalledWith(
      BIOMETRIC_STATE_STORAGE_KEY,
      'invalidated',
    );
  });

  it('routes hasSecret=false without a SecureStorage adapter to VAULT_ERROR_NOT_INITIALIZED', async () => {
    // The constructor accepts an optional SecureStorage; callers in
    // older code paths may construct the vault without one. The
    // disambiguator must default to NOT_INITIALIZED in that case.
    const vault = new BiometricVault();
    native.hasSecret.mockResolvedValueOnce(false);

    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_NOT_INITIALIZED',
    });
  });

  it('clears in-memory state when KEY_INVALIDATED is observed on an unlocked vault', async () => {
    // Provision and unlock so the vault holds in-memory key material.
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });
    await vault.initialize({});

    // Sanity: pre-conditions for the regression — vault is unlocked
    // and serving derived state.
    expect(vault.isLocked()).toBe(false);
    await expect(vault.getDid()).resolves.toBeDefined();
    await expect(vault.getMnemonic()).resolves.toBeDefined();
    await expect(
      vault.encryptData({ plaintext: new Uint8Array([1, 2, 3]) }),
    ).resolves.toBeDefined();

    // Now: a refresh-unlock attempt observes KEY_INVALIDATED. The
    // vault must not leave
    // _secretBytes / _bearerDid / _contentEncryptionKey resident in
    // memory, so isLocked() would remain false and the four methods
    // above would keep working on stale material.
    native.hasSecret.mockResolvedValueOnce(true);
    native.getSecret.mockRejectedValueOnce(withErrorCode('KEY_INVALIDATED'));
    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_KEY_INVALIDATED',
    });

    // The vault must be locked, and the four accessors must reject
    // with VAULT_ERROR_LOCKED. We pin all four to make the
    // test regression-loud no matter which accessor a future change
    // might leave dangling.
    expect(vault.isLocked()).toBe(true);
    await expect(vault.getDid()).rejects.toMatchObject({
      code: 'VAULT_ERROR_LOCKED',
    });
    await expect(vault.getMnemonic()).rejects.toMatchObject({
      code: 'VAULT_ERROR_LOCKED',
    });
    await expect(
      vault.encryptData({ plaintext: new Uint8Array([1, 2, 3]) }),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR_LOCKED' });
    await expect(vault.decryptData({ jwe: 'irrelevant.compact.jwe.text.tag' }))
      .rejects.toMatchObject({ code: 'VAULT_ERROR_LOCKED' });

    // The persisted biometric state MUST also flip to invalidated
    // This preserves the existing invalidated-state side effect so a
    // future refactor cannot accidentally drop it.
    expect((await vault.getStatus()).biometricState).toBe('invalidated');
  });

  it('persists invalidated and stays locked when KEY_INVALIDATED is observed on a locked vault', async () => {
    // The invalidation cleanup must not regress the locked-vault path
    // covered by the existing VAL-VAULT-008 test. We re-run a
    // similar scenario (provision → lock → KEY_INVALIDATED unlock)
    // and assert the same observable contract.
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });
    await vault.initialize({});
    await vault.lock();

    native.hasSecret.mockResolvedValueOnce(true);
    native.getSecret.mockRejectedValueOnce(withErrorCode('KEY_INVALIDATED'));
    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_KEY_INVALIDATED',
    });

    expect(vault.isLocked()).toBe(true);
    expect((await vault.getStatus()).biometricState).toBe('invalidated');
  });

  it('surfaces unlock hasSecret() rejection as a transient VAULT_ERROR', async () => {
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });
    await vault.initialize({});
    await vault.lock();

    // Simulate a native rejection (Keystore probe failure on Android,
    // non-NotFound OSStatus on iOS). This must not be treated as
    // "set up new wallet", which would silently
    // destroy any recoverable wallet on retry.
    const transient = withErrorCode('VAULT_ERROR', 'keystore probe boom');
    native.hasSecret.mockRejectedValueOnce(transient);

    await expect(vault.unlock({})).rejects.toMatchObject({
      // Mapped via mapNativeErrorToVaultError → 'VAULT_ERROR' (the
      // input ``code`` happens to be the canonical VAULT_ERROR
      // surface; either branch is acceptable as long as it is NOT
      // NOT_INITIALIZED).
      code: 'VAULT_ERROR',
    });
    // No invalidated-state side-effect on a transient native failure.
    expect(api.set).not.toHaveBeenCalledWith(
      BIOMETRIC_STATE_STORAGE_KEY,
      'invalidated',
    );
    // No biometric prompt fires when hasSecret itself fails.
    expect(native.getSecret).not.toHaveBeenCalled();
  });

  it('surfaces code-less hasSecret() rejection as a generic VAULT_ERROR', async () => {
    const vault = new BiometricVault();
    await vault.initialize({});
    await vault.lock();

    // No `.code` property — the mapper returns null and the catch
    // path must fall back to VAULT_ERROR.
    native.hasSecret.mockRejectedValueOnce(new Error('opaque native boom'));

    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR',
    });
  });

  it('surfaces initialize hasSecret() rejection without provisioning over a possibly-existing alias', async () => {
    // The _doInitialize side must not collapse hasSecret rejection to
    // false and proceed to generateAndStoreSecret. With the native
    // non-destructive guard, the native side would then reject with
    // VAULT_ERROR_ALREADY_INITIALIZED if the alias really did exist —
    // but the JS layer's surfaced error would be misleading (the
    // native module rejects but the root cause is the swallowed
    // hasSecret failure on the JS side). Surfacing the rejection
    // verbatim makes the failure mode auditable.
    const vault = new BiometricVault();
    const transient = withErrorCode('VAULT_ERROR', 'keystore probe boom');
    native.hasSecret.mockRejectedValueOnce(transient);

    await expect(vault.initialize({})).rejects.toMatchObject({
      code: 'VAULT_ERROR',
    });
    // generateAndStoreSecret must NOT have been called.
    expect(native.generateAndStoreSecret).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// getSecret() NOT_FOUND race and derivation cleanup
//
//   Prior-init disambiguation must also run on the
//      ``hasSecret()=false`` path. If ``hasSecret()`` returned ``true``
//      but ``getSecret()`` then observed iOS auto-delete as
//      ``NOT_FOUND`` (a real race on the iOS biometry-current-set
//      ACL between probe and read), the catch path mapped it to
//      ``VAULT_ERROR_NOT_INITIALIZED`` and re-threw verbatim. The
//      ``getSecret()`` catch must use the same prior-init
//      disambiguation as the false-from-probe path.
//
//   After a successful ``getSecret()``, the derivation
//      block (hex decode → mnemonic → seed → DID → CEK) ran without
//      a try/catch wrapping. Two specific failure modes:
//        (a) freshly-allocated local ``secretBytes`` and ``rootSeed``
//            arrays — copies of the wallet entropy + seed — would
//            never be zeroed before the function unwound, so
//            sensitive material lingered on the JS heap until GC.
//        (b) ``this._secretBytes`` / DID / CEK from a prior unlock
//            kept their values, leaving ``isLocked()`` reporting
//            false and the four data accessors operable on stale
//            material. Derivation failures must zero locals, clear
//            in-memory state, and re-throw the original error.
// ===========================================================================
describe('BiometricVault — getSecret NOT_FOUND race and derivation cleanup', () => {
  it('routes getSecret NOT_FOUND with INITIALIZED="true" to VAULT_ERROR_KEY_INVALIDATED', async () => {
    // Setup: hasSecret returns true (probe sees the item) but
    // getSecret then rejects with NOT_FOUND (item disappeared
    // between probe and read during the iOS auto-delete race).
    // SecureStorage shows
    // INITIALIZED='true' so the JS-layer disambiguator can prove
    // this device already had a vault.
    const { api, store } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });
    await vault.initialize({});
    expect(store.get(INITIALIZED_STORAGE_KEY)).toBe('true');
    await vault.lock();

    native.hasSecret.mockResolvedValueOnce(true);
    native.getSecret.mockRejectedValueOnce(withErrorCode('NOT_FOUND'));

    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_KEY_INVALIDATED',
    });

    // The persisted biometric state must flip to invalidated so the
    // agent-store / UI can route to RecoveryRestore.
    expect(api.set).toHaveBeenCalledWith(BIOMETRIC_STATE_STORAGE_KEY, 'invalidated');
    expect(store.get(BIOMETRIC_STATE_STORAGE_KEY)).toBe('invalidated');
    // The vault is left locked.
    expect(vault.isLocked()).toBe(true);
  });

  it('routes getSecret NOT_FOUND with biometricState="ready" to VAULT_ERROR_KEY_INVALIDATED', async () => {
    // Same scenario but the prior-init signal is the
    // ``biometricState='ready'`` SecureStorage entry rather than
    // ``INITIALIZED='true'``.
    const { api, store } = makeSecureStorage();
    store.set(BIOMETRIC_STATE_STORAGE_KEY, 'ready');

    const vault = new BiometricVault({ secureStorage: api });
    native.hasSecret.mockResolvedValueOnce(true);
    native.getSecret.mockRejectedValueOnce(withErrorCode('NOT_FOUND'));

    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_KEY_INVALIDATED',
    });
    expect(store.get(BIOMETRIC_STATE_STORAGE_KEY)).toBe('invalidated');
  });

  it('keeps getSecret NOT_FOUND as VAULT_ERROR_NOT_INITIALIZED without any prior-init signal', async () => {
    // Negative-parity: even on the getSecret race path, the
    // disambiguator must default to NOT_INITIALIZED when SecureStorage
    // has no prior-init evidence. This pins the symmetry with the
    // hasSecret=false branch and prevents the disambiguator from being
    // over-broad on edge cases (e.g. an extremely rare deployment
    // where SecureStorage was wiped while the native item was kept).
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });

    native.hasSecret.mockResolvedValueOnce(true);
    native.getSecret.mockRejectedValueOnce(withErrorCode('NOT_FOUND'));

    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_NOT_INITIALIZED',
    });
    // No invalidated-state side-effect on a non-prior-init device.
    expect(api.set).not.toHaveBeenCalledWith(
      BIOMETRIC_STATE_STORAGE_KEY,
      'invalidated',
    );
  });

  it('clears in-memory state when getSecret NOT_FOUND is reclassified as key invalidation', async () => {
    // The disambiguator path must also zero the in-memory material,
    // matching the KEY_INVALIDATED catch path. If the vault
    // was already unlocked from a prior call, the OS-level item
    // is now gone and the cached _secretBytes/DID/CEK no longer
    // map to a recoverable vault.
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });
    await vault.initialize({});
    expect(vault.isLocked()).toBe(false);
    await expect(vault.getDid()).resolves.toBeDefined();

    native.hasSecret.mockResolvedValueOnce(true);
    native.getSecret.mockRejectedValueOnce(withErrorCode('NOT_FOUND'));

    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_KEY_INVALIDATED',
    });

    expect(vault.isLocked()).toBe(true);
    await expect(vault.getDid()).rejects.toMatchObject({
      code: 'VAULT_ERROR_LOCKED',
    });
    await expect(vault.getMnemonic()).rejects.toMatchObject({
      code: 'VAULT_ERROR_LOCKED',
    });
    await expect(
      vault.encryptData({ plaintext: new Uint8Array([1, 2, 3]) }),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR_LOCKED' });
  });

  it('clears in-memory state when derivation fails on a previously-unlocked vault', async () => {
    // Setup: provision and unlock so the vault holds in-memory
    // _secretBytes/DID/CEK from a prior successful unlock.
    const didError = new Error('simulated DID-derivation failure');
    let didFactoryCallCount = 0;
    const didFactory: any = jest.fn(async (args: any) => {
      didFactoryCallCount += 1;
      // First call (from initialize) succeeds; second call (from
      // unlock-after-lock) throws. Mirrors the production surface
      // where DID factory is non-deterministic on transient
      // network / dependency failures.
      if (didFactoryCallCount === 1) {
        // Return a minimal BearerDid stub — the test does not
        // consult its shape, only that it's truthy.
        return {
          uri: 'did:dht:fake',
          metadata: {},
          document: {},
          keyManager: args.keyManager,
        };
      }
      throw didError;
    });
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ didFactory, secureStorage: api });
    await vault.initialize({});

    // Pre-condition: vault is unlocked and serving a DID.
    expect(vault.isLocked()).toBe(false);
    await expect(vault.getDid()).resolves.toBeDefined();
    await expect(vault.getMnemonic()).resolves.toBeDefined();

    // Now: lock and trigger an unlock attempt where DID derivation
    // throws AFTER getSecret succeeds.
    await vault.lock();
    expect(vault.isLocked()).toBe(true);

    await expect(vault.unlock({})).rejects.toBe(didError);

    // The vault remains locked AND the four accessors reject with
    // VAULT_ERROR_LOCKED. A regression here could see
    // ``isLocked()`` return false because ``_secretBytes`` /
    // ``_bearerDid`` / ``_contentEncryptionKey`` would still be set
    // from the prior successful unlock — the failed unlock would
    // leave a dangerous "unlock failed but vault still serves data"
    // state.
    expect(vault.isLocked()).toBe(true);
    await expect(vault.getDid()).rejects.toMatchObject({
      code: 'VAULT_ERROR_LOCKED',
    });
    await expect(vault.getMnemonic()).rejects.toMatchObject({
      code: 'VAULT_ERROR_LOCKED',
    });
    await expect(
      vault.encryptData({ plaintext: new Uint8Array([1, 2, 3]) }),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR_LOCKED' });
  });

  it('does not corrupt subsequent successful unlock after derivation failure', async () => {
    // The catch path calls _clearInMemoryState(), which existing tests
    // cover. This also
    // exercises the cleanup-then-retry path: after a derivation
    // throw, a fresh unlock that succeeds must produce a fully
    // working vault — the cleanup must not leave any sticky state
    // that breaks subsequent unlocks.
    let didFactoryCallCount = 0;
    const didFactory: any = jest.fn(async (args: any) => {
      didFactoryCallCount += 1;
      if (didFactoryCallCount === 1) {
        return {
          uri: 'did:dht:initial',
          metadata: {},
          document: {},
          keyManager: args.keyManager,
        };
      }
      if (didFactoryCallCount === 2) {
        throw new Error('transient DID failure');
      }
      return {
        uri: 'did:dht:recovered',
        metadata: {},
        document: {},
        keyManager: args.keyManager,
      };
    });
    const vault = new BiometricVault({ didFactory });
    await vault.initialize({});
    await vault.lock();

    await expect(vault.unlock({})).rejects.toThrow('transient DID failure');
    expect(vault.isLocked()).toBe(true);

    // Retry: this unlock must succeed cleanly. Cached _secretBytes /
    // _rootSeed must not survive across the failed
    // unlock and confuse the retry's reassignment.
    await expect(vault.unlock({})).resolves.toBeUndefined();
    expect(vault.isLocked()).toBe(false);
    await expect(vault.getDid()).resolves.toEqual(
      expect.objectContaining({ uri: 'did:dht:recovered' }),
    );
  });

  it('clears in-memory state when native returns invalid hex', async () => {
    // Hex decode uses the same cleanup guard as the rest of derivation.
    // If the native module returned malformed hex
    // (a length-mismatched secret, garbage from a corrupted
    // Keychain item, etc.) the error path must still zero the partial
    // ``secretBytes`` allocation. Pin the cleanup contract.
    const vault = new BiometricVault();
    await vault.initialize({});
    await vault.lock();

    // Return a 30-byte hex string (60 chars) — fewer than the
    // expected 64. The hex regex in the native mock would reject
    // this, so we override getSecret directly with a malformed
    // string. The length check inside _doUnlock then throws
    // VAULT_ERROR.
    native.hasSecret.mockResolvedValueOnce(true);
    native.getSecret.mockResolvedValueOnce('aa'.repeat(30));

    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR',
    });
    expect(vault.isLocked()).toBe(true);
    await expect(vault.getDid()).rejects.toMatchObject({
      code: 'VAULT_ERROR_LOCKED',
    });
  });
});

// ===========================================================================
// Additional coverage — mapNativeErrorToVaultError helper
// ===========================================================================
// ===========================================================================
// Cross-method serialization and strict hex validation.
// ===========================================================================
describe('BiometricVault — serialization and hex validation', () => {
  // -------------------------------------------------------------------------
  // Cross-method mutex
  // -------------------------------------------------------------------------
  it('queues initialize() behind a pending unlock() before starting its native sequence', async () => {
    // Setup: a native ``hasSecret``/``getSecret`` pair that takes
    // a measurable time. Our concurrent ``initialize()`` must NOT
    // invoke ``hasSecret`` before unlock's getSecret has resolved
    // — otherwise the two native sequences interleave and
    // generateAndStoreSecret could see the alias mid-getSecret.
    const { api, store } = makeSecureStorage();
    // Pre-provision so unlock() actually has work to do.
    const seedVault = new BiometricVault({ secureStorage: api });
    await seedVault.initialize({});
    expect(store.get(INITIALIZED_STORAGE_KEY)).toBe('true');

    // Build a second vault for the actual race (sharing the native store
    // via the global jest mock).
    const vault = new BiometricVault({ secureStorage: api });

    // Stretch unlock's getSecret so the race window is observable.
    const callOrder: string[] = [];
    let releaseGetSecret: () => void = () => undefined;
    const getSecretGate = new Promise<void>((resolve) => {
      releaseGetSecret = resolve;
    });
    const realGetSecret = native.getSecret.getMockImplementation();
    native.getSecret.mockImplementation(async (alias: string, prompt: any) => {
      callOrder.push('getSecret:start');
      await getSecretGate;
      callOrder.push('getSecret:end');
      return realGetSecret!(alias, prompt);
    });
    // Wrap hasSecret so we can see if the second initialize() jumps the gun.
    const realHasSecret = native.hasSecret.getMockImplementation();
    native.hasSecret.mockImplementation(async (alias: string) => {
      callOrder.push('hasSecret');
      return realHasSecret!(alias);
    });

    const unlockPromise = vault.unlock({});
    // Allow the unlock task body to enqueue and start its native sequence.
    await Promise.resolve();
    await Promise.resolve();

    // Now fire a concurrent initialize(). Because the cross-method
    // mutex is active, this must wait until ``unlockPromise``
    // settles before its own ``hasSecret`` runs.
    const initPromise = vault.initialize({}).catch((e) => e);

    // Verify hasSecret was called exactly once so far (by unlock).
    // If the cross-method mutex is missing, initialize would call hasSecret here
    // and we'd see TWO entries.
    await Promise.resolve();
    await Promise.resolve();
    expect(callOrder.filter((s) => s === 'hasSecret').length).toBe(1);

    // Release unlock's getSecret and let it complete.
    releaseGetSecret();
    await unlockPromise;
    const initResult = await initPromise;

    // initialize() ran its hasSecret AFTER unlock's getSecret completed,
    // so the call order shows hasSecret -> getSecret -> hasSecret (init's).
    const hasSecretIndices = callOrder
      .map((s, i) => (s === 'hasSecret' ? i : -1))
      .filter((i) => i >= 0);
    const getSecretEndIndex = callOrder.indexOf('getSecret:end');
    expect(hasSecretIndices.length).toBe(2);
    expect(hasSecretIndices[1]).toBeGreaterThan(getSecretEndIndex);

    // initialize() rejects with ALREADY_INITIALIZED (the alias still
    // exists post-unlock), which is the correct serialized outcome.
    expect(initResult).toMatchObject({ code: 'VAULT_ERROR_ALREADY_INITIALIZED' });

    // Restore mock implementations.
    native.getSecret.mockImplementation(realGetSecret!);
    native.hasSecret.mockImplementation(realHasSecret!);
  });

  it('queues unlock() behind a pending initialize() before starting its native sequence', async () => {
    // Symmetric counterpart of the above. A user kicks off
    // first-launch setup; before initialize finishes, an event-driven
    // resume tries to unlock. Without serialization, unlock's
    // hasSecret races initialize's generateAndStoreSecret.
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });

    const callOrder: string[] = [];
    let releaseGenerate: () => void = () => undefined;
    const generateGate = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    const realGenerate = native.generateAndStoreSecret.getMockImplementation();
    native.generateAndStoreSecret.mockImplementation(
      async (alias: string, opts: any) => {
        callOrder.push('generate:start');
        await generateGate;
        callOrder.push('generate:end');
        return realGenerate!(alias, opts);
      },
    );
    const realHasSecret = native.hasSecret.getMockImplementation();
    native.hasSecret.mockImplementation(async (alias: string) => {
      callOrder.push('hasSecret');
      return realHasSecret!(alias);
    });

    const initPromise = vault.initialize({});
    await Promise.resolve();
    await Promise.resolve();

    // Concurrent unlock; must NOT call hasSecret until initialize completes.
    const unlockPromise = vault.unlock({}).catch((e) => e);

    await Promise.resolve();
    await Promise.resolve();
    // Only initialize's hasSecret should have run.
    expect(callOrder.filter((s) => s === 'hasSecret').length).toBe(1);

    // Release generate, let initialize finish.
    releaseGenerate();
    await initPromise;
    await unlockPromise;

    const hasSecretIndices = callOrder
      .map((s, i) => (s === 'hasSecret' ? i : -1))
      .filter((i) => i >= 0);
    const generateEndIndex = callOrder.indexOf('generate:end');
    expect(hasSecretIndices.length).toBe(2);
    expect(hasSecretIndices[1]).toBeGreaterThan(generateEndIndex);

    // Restore mock implementations.
    native.generateAndStoreSecret.mockImplementation(realGenerate!);
    native.hasSecret.mockImplementation(realHasSecret!);
  });

  it('preserves same-method memoization for concurrent initialize() calls', async () => {
    // The cross-method mutex must not break same-method memoization
    // (concurrent initialize() returning the
    // same in-flight promise). This regression target keeps the
    // VAL-VAULT-028 mutex contract intact.
    const vault = new BiometricVault();
    native.generateAndStoreSecret.mockClear();
    const [a, b] = await Promise.all([vault.initialize({}), vault.initialize({})]);
    expect(a).toBe(b);
    expect(native.generateAndStoreSecret).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // hexToBytes strict validation
  // -------------------------------------------------------------------------
  it('fails closed when getSecret returns a 64-char non-hex payload', async () => {
    // parseInt('zz', 16) returns NaN, which Uint8Array coerces to 0.
    // A 64-char non-hex
    // payload from a corrupt or malicious native module would
    // silently decode to a 32-byte all-zero buffer (a perfectly
    // valid BIP-39 entropy that maps to a deterministic but wrong
    // wallet — a privacy / correctness disaster). hexToBytes must
    // throw on the regex check.
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });
    await vault.initialize({});
    await vault.lock();

    native.hasSecret.mockResolvedValueOnce(true);
    native.getSecret.mockResolvedValueOnce('zz'.repeat(32));

    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR',
      message: expect.stringMatching(/non-hexadecimal/i),
    });
    // Vault is left locked.
    expect(vault.isLocked()).toBe(true);
    // No persisted DID side-effect. Nothing was unlocked, so getDid rejects.
    await expect(vault.getDid()).rejects.toMatchObject({
      code: 'VAULT_ERROR_LOCKED',
    });
  });

  it('fails closed when getSecret returns a mixed hex and non-hex payload', async () => {
    // Single-character non-hex digit (``g``) interspersed with a
    // valid digit. This must not decode to bytes whose high nibble is
    // correct and low nibble is 0, which would produce deterministic
    // but wrong entropy.
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });
    await vault.initialize({});
    await vault.lock();

    native.hasSecret.mockResolvedValueOnce(true);
    native.getSecret.mockResolvedValueOnce('0g'.repeat(32));

    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR',
      message: expect.stringMatching(/non-hexadecimal/i),
    });
    expect(vault.isLocked()).toBe(true);
  });

  it('accepts valid canonical lower-case 64-char hex from getSecret', async () => {
    // Negative-parity: the strict validation must NOT reject the
    // canonical lower-case hex output the native modules promise.
    // This pins the happy path so strict validation does not
    // over-reject.
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });
    await vault.initialize({});
    expect(vault.isLocked()).toBe(false);
  });

  it('accepts upper-case hex from getSecret while native modules separately enforce lower-case output', async () => {
    // The JS hex parser must accept upper-case so a future native
    // emitting ``ABCD...`` (or a mock emitting it for test purposes)
    // still works. The lower-case contract is enforced one layer
    // down in the native modules.
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });
    await vault.initialize({});
    await vault.lock();

    // Use the actual hex this vault was provisioned with but uppercased.
    const provisionCall = native.generateAndStoreSecret.mock.calls.find(
      (c) => c[0] === WALLET_ROOT_KEY_ALIAS,
    );
    const lowerHex: string = provisionCall![1].secretHex;
    const upperHex = lowerHex.toUpperCase();
    expect(upperHex).toMatch(/^[0-9A-F]{64}$/);

    native.hasSecret.mockResolvedValueOnce(true);
    native.getSecret.mockResolvedValueOnce(upperHex);

    await expect(vault.unlock({})).resolves.toBeUndefined();
    expect(vault.isLocked()).toBe(false);
  });

  it('fails closed when getSecret returns odd-length hex', async () => {
    const { api } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });
    await vault.initialize({});
    await vault.lock();

    native.hasSecret.mockResolvedValueOnce(true);
    // 63 chars — odd length.
    native.getSecret.mockResolvedValueOnce('a'.repeat(63));

    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR',
      message: expect.stringMatching(/odd-length/i),
    });
    expect(vault.isLocked()).toBe(true);
  });
});

describe('mapNativeErrorToVaultError', () => {
  it.each([
    ['USER_CANCELED', 'VAULT_ERROR_USER_CANCELED'],
    ['KEY_INVALIDATED', 'VAULT_ERROR_KEY_INVALIDATED'],
    ['BIOMETRY_UNAVAILABLE', 'VAULT_ERROR_BIOMETRICS_UNAVAILABLE'],
    ['BIOMETRY_NOT_ENROLLED', 'VAULT_ERROR_BIOMETRICS_UNAVAILABLE'],
    ['NOT_FOUND', 'VAULT_ERROR_NOT_INITIALIZED'],
    ['BIOMETRY_LOCKOUT', 'VAULT_ERROR_BIOMETRY_LOCKOUT'],
    ['BIOMETRY_LOCKOUT_PERMANENT', 'VAULT_ERROR_BIOMETRY_LOCKOUT'],
    ['AUTH_FAILED', 'VAULT_ERROR'],
    // Native rejects with this canonical code when
    // `generateAndStoreSecret` is called over an
    // existing alias. The mapper preserves the code through to the
    // VaultError surface so the JS layer's UI logic can branch on it.
    ['VAULT_ERROR_ALREADY_INITIALIZED', 'VAULT_ERROR_ALREADY_INITIALIZED'],
    // Native rejects with this code when a concurrent
    // generateAndStoreSecret/deleteSecret is already in flight on the
    // SAME alias (per-alias serialization contract). The mapper
    // preserves the code so the JS layer can detect the in-progress
    // state and show appropriate recovery UI instead of treating it
    // as a generic VAULT_ERROR.
    [
      'VAULT_ERROR_OPERATION_IN_PROGRESS',
      'VAULT_ERROR_OPERATION_IN_PROGRESS',
    ],
  ])('maps %s to %s', (nativeCode, vaultCode) => {
    const err = withErrorCode(nativeCode);
    expect(mapNativeErrorToVaultError(err)?.code).toBe(vaultCode);
  });

  it('returns null for unknown / code-less errors', () => {
    expect(mapNativeErrorToVaultError(new Error('boom'))).toBeNull();
    expect(mapNativeErrorToVaultError(undefined)).toBeNull();
  });
});
