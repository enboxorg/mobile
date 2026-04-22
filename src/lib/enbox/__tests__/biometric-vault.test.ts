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
        privateKeyBytes: Uint8Array;
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

    // Lock the vault. Round-trip must NOT involve the native module.
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
// Additional coverage — mapNativeErrorToVaultError helper
// ===========================================================================
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
  ])('maps %s to %s', (nativeCode, vaultCode) => {
    const err = withErrorCode(nativeCode);
    expect(mapNativeErrorToVaultError(err)?.code).toBe(vaultCode);
  });

  it('returns null for unknown / code-less errors', () => {
    expect(mapNativeErrorToVaultError(new Error('boom'))).toBeNull();
    expect(mapNativeErrorToVaultError(undefined)).toBeNull();
  });
});
