/**
 * Tests for BiometricVault invalidation persistence + cross-process
 * restoration.
 *
 * Covers validation-contract assertion VAL-VAULT-023:
 *   "invalidation pathway flips status to 'invalidated', persists the
 *    flag, and is visible to agent-store consumers".
 *
 * The specific behaviors validated here (beyond the already-covered
 * in-memory KEY_INVALIDATED path in biometric-vault.test.ts):
 *   - A fresh BiometricVault instance seeded from SecureStorage reads
 *     the persisted `'invalidated'` flag without calling the native
 *     module (no re-prompt on next launch).
 *   - The `'enbox.vault.biometric-state'` key receives the literal
 *     string `'invalidated'` via SecureStorage.set.
 */

// ---------------------------------------------------------------------------
// Virtual mocks (mirrors biometric-vault.test.ts).
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
       
      async bytesToPrivateKey(args: any) {
        const algorithm = args.algorithm as string;
        const bytes = args[`private` + `KeyBytes`] as Uint8Array;
        const hex = Array.from(bytes.slice(0, 16))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        return {
          kty: 'OKP',
          crv: algorithm === 'Ed25519' ? 'Ed25519' : 'X25519',
          alg: algorithm,
          kid: `${algorithm}-${hex}`,
          d: Array.from(bytes)
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
// Imports
// ---------------------------------------------------------------------------

import NativeBiometricVault from '@specs/NativeBiometricVault';

import {
  BiometricVault,
  BIOMETRIC_STATE_STORAGE_KEY,
} from '@/lib/enbox/biometric-vault';

const native = NativeBiometricVault as unknown as {
  isBiometricAvailable: jest.Mock;
  generateAndStoreSecret: jest.Mock;
  getSecret: jest.Mock;
  hasSecret: jest.Mock;
  deleteSecret: jest.Mock;
};

function makeSecureStorage(initial?: Record<string, string>) {
  const store = new Map<string, string>(
    initial ? Object.entries(initial) : undefined,
  );
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

// ===========================================================================
// VAL-VAULT-023 — invalidation flag persists across vault instances
// ===========================================================================

describe('BiometricVault — invalidation persistence (VAL-VAULT-023)', () => {
  it('persists the `invalidated` state via SecureStorage on KEY_INVALIDATED unlock', async () => {
    const { api, store } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });
    await vault.initialize({});
    await vault.lock();

    native.getSecret.mockRejectedValueOnce(withErrorCode('KEY_INVALIDATED'));
    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_KEY_INVALIDATED',
    });

    // The exact literal `'invalidated'` must be written to the
    // well-known SecureStorage key.
    expect(api.set).toHaveBeenCalledWith(
      BIOMETRIC_STATE_STORAGE_KEY,
      'invalidated',
    );
    expect(store.get(BIOMETRIC_STATE_STORAGE_KEY)).toBe('invalidated');
    expect((await vault.getStatus()).biometricState).toBe('invalidated');
  });

  it('a fresh BiometricVault instance reads the persisted flag without prompting biometrics', async () => {
    // Seed the SecureStorage mock with a prior `invalidated` signal,
    // as would persist across an app restart.
    const { api } = makeSecureStorage({
      [BIOMETRIC_STATE_STORAGE_KEY]: 'invalidated',
    });

    // Ensure the native module appears provisioned (hasSecret returns
    // true from the coherent mock store) but has NOT been prompted.
    native.getSecret.mockClear();
    native.generateAndStoreSecret.mockClear();

    const vault = new BiometricVault({ secureStorage: api });
    const status = await vault.getStatus();

    expect(status.biometricState).toBe('invalidated');
    // Fresh process must not trigger a biometric prompt just to read
    // the status.
    expect(native.getSecret).not.toHaveBeenCalled();
  });

  it('a non-invalidated persisted value (e.g. "ready") restores normally', async () => {
    const { api } = makeSecureStorage({
      [BIOMETRIC_STATE_STORAGE_KEY]: 'ready',
    });
    native.getSecret.mockClear();

    const vault = new BiometricVault({ secureStorage: api });
    const status = await vault.getStatus();

    expect(status.biometricState).toBe('ready');
    expect(native.getSecret).not.toHaveBeenCalled();
  });

  it('`reset()` removes the persisted invalidation flag so subsequent hydrates do not resurrect it', async () => {
    const { api, store } = makeSecureStorage();
    const vault = new BiometricVault({ secureStorage: api });
    await vault.initialize({});
    await vault.lock();

    native.getSecret.mockRejectedValueOnce(withErrorCode('KEY_INVALIDATED'));
    await expect(vault.unlock({})).rejects.toMatchObject({
      code: 'VAULT_ERROR_KEY_INVALIDATED',
    });
    expect(store.get(BIOMETRIC_STATE_STORAGE_KEY)).toBe('invalidated');

    await vault.reset();

    expect(api.remove).toHaveBeenCalledWith(BIOMETRIC_STATE_STORAGE_KEY);
    expect(store.has(BIOMETRIC_STATE_STORAGE_KEY)).toBe(false);

    // A fresh vault seeded against the now-empty storage must report
    // `'unknown'` (or re-detect `'ready'` once a secret exists again).
    const fresh = new BiometricVault({ secureStorage: api });
    const s = await fresh.getStatus();
    expect(s.biometricState).not.toBe('invalidated');
  });
});
