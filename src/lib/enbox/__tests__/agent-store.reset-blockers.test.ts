/**
 * Targeted regression tests for the two `useAgentStore.reset()`
 * scrutiny blockers fixed by `fix-biometric-vault-js-scrutiny-blockers`:
 *
 *   BLOCKER 3 — reset() must wipe the persistent ENBOX_AGENT LevelDB
 *               data on disk so a post-reset relaunch doesn't resurrect
 *               identities / DWN records / sync cursors from the
 *               previous wallet. The wipe is delegated to
 *               `destroyAgentLevelDatabases` in `rn-level.ts`.
 *
 *   BLOCKER 4 — reset()'s fallback path (no vault instance in the
 *               store, e.g. after `invalidated` recovery) must clear
 *               BOTH `enbox.vault.initialized` and
 *               `enbox.vault.biometric-state` from SecureStorage so a
 *               subsequent cold launch does not misroute away from
 *               clean onboarding.
 *
 * Uses the same virtual mocks as `agent-store.test.ts` for the
 * ESM-only @enbox packages and spies on `destroyAgentLevelDatabases`
 * + the NativeSecureStorage mock to assert the wipe calls happen.
 */

jest.mock(
  '@enbox/agent',
  () => {
    class AgentDwnApi {
      public _agent: unknown;
      public _localDwnStrategy: string | undefined;
      public _localDwnDiscovery: unknown;
      public _localManagedDidCache: Map<string, unknown> = new Map();
       
      set agent(value: unknown) {
        this._agent = value;
      }
      static _tryCreateDiscoveryFile() {
        return {};
      }
    }
    class LocalDwnDiscovery {}

    const identityList = jest.fn(async () => [] as unknown[]);
    const firstLaunch = jest.fn(async () => true);
    const initialize = jest.fn(async () => 'reset-blockers test recovery phrase');
    const start = jest.fn(async () => undefined);

    class EnboxUserAgent {
      public vault: unknown;
      public params: any;
      public identity: { list: jest.Mock; create: jest.Mock };
      public firstLaunch: jest.Mock = firstLaunch;
      public initialize: jest.Mock = initialize;
      public start: jest.Mock = start;
      constructor(createParams: any) {
        this.params = createParams;
        this.vault = createParams?.agentVault;
        this.identity = { list: identityList, create: jest.fn() };
      }
      static create = jest.fn(
        async (params: any) => new EnboxUserAgent(params),
      );
    }

    class AgentCryptoApi {
      async bytesToPrivateKey(params: any) {
        const algorithm: string = params.algorithm ?? 'Ed25519';
        return {
          kty: 'OKP',
          crv: algorithm === 'Ed25519' ? 'Ed25519' : 'X25519',
          alg: algorithm,
          kid: `${algorithm}-stub`,
          d: 'stub',
        };
      }
    }

    return {
      __esModule: true,
      AgentCryptoApi,
      AgentDwnApi,
      EnboxUserAgent,
      LocalDwnDiscovery,
      __mocks__: { firstLaunch, initialize, start, identityList, create: EnboxUserAgent.create },
    };
  },
  { virtual: true },
);

jest.mock(
  '@enbox/auth',
  () => {
    const create = jest.fn(async () => ({ id: 'auth-manager-stub' }));
    return { __esModule: true, AuthManager: { create }, __mocks__: { create } };
  },
  { virtual: true },
);

jest.mock(
  '@enbox/dids',
  () => {
    class BearerDid {
      public readonly uri: string;
      public readonly metadata = {};
      public readonly document = {};
      public readonly keyManager: any;
      constructor(uri: string, keyManager?: any) {
        this.uri = uri;
        this.keyManager = keyManager;
      }
    }
    const create = jest.fn(async ({ keyManager, options }: any) => {
      const keys = Array.from(
        (keyManager as any)._predefinedKeys?.values?.() ?? [],
      );
      const first = keys[0] as any;
      const kid = first?.kid ?? 'no-key';
      const svcPart = options?.services?.[0]?.id
        ? `:${options.services[0].id}`
        : '';
      return new BearerDid(`did:dht:${kid}${svcPart}`, keyManager);
    });
    return { __esModule: true, BearerDid, DidDht: { create } };
  },
  { virtual: true },
);

jest.mock(
  '@enbox/crypto',
  () => {
    class LocalKeyManager {
      async getKeyUri({ key }: { key: any }): Promise<string> {
        return `urn:jwk:${key.kid}`;
      }
    }
    return {
      __esModule: true,
      LocalKeyManager,
      computeJwkThumbprint: jest.fn(
        async ({ jwk }: any) => `tp_${jwk.alg}_${jwk.kid ?? ''}`,
      ),
    };
  },
  { virtual: true },
);

// Mock react-native-leveldb at the native-module level so we can
// (a) assert BLOCKER 3 by spying on destroyDB calls, and
// (b) keep the real `destroyAgentLevelDatabases` helper code path
//     exercised (it's what `useAgentStore.reset()` imports) rather
//     than stubbing the helper itself.
// Mock `react-native-leveldb` so `destroyAgentLevelDatabases()` has a
// spy-observable surface during tests. The factory is invoked EAGERLY
// by Jest when it first resolves the module (before any `const` in
// this file runs), so we construct the spy INSIDE the factory and
// retrieve it via `jest.requireMock` after the imports finish.
jest.mock('react-native-leveldb', () => {
  const destroyDB = jest.fn();
  function MockLevelDB(this: any) {
    this.getStr = () => null;
    this.put = () => undefined;
    this.delete = () => undefined;
    this.close = () => undefined;
    this.newIterator = () => ({
      seek: () => undefined,
      seekToFirst: () => undefined,
      seekLast: () => undefined,
      valid: () => false,
      keyStr: () => '',
      valueStr: () => '',
      next: () => undefined,
      prev: () => undefined,
      close: () => undefined,
    });
  }
  (MockLevelDB as any).destroyDB = destroyDB;
  return { __esModule: true, LevelDB: MockLevelDB };
});

// Silence expected console.warn noise from the reset paths.
const consoleSpies: jest.SpyInstance[] = [];
beforeAll(() => {
  consoleSpies.push(jest.spyOn(console, 'log').mockImplementation(() => {}));
  consoleSpies.push(jest.spyOn(console, 'warn').mockImplementation(() => {}));
  consoleSpies.push(jest.spyOn(console, 'error').mockImplementation(() => {}));
});
afterAll(() => {
  for (const s of consoleSpies) s.mockRestore();
});

import NativeSecureStorage from '@specs/NativeSecureStorage';
import NativeBiometricVault from '@specs/NativeBiometricVault';

import { useAgentStore } from '@/lib/enbox/agent-store';
import { BiometricVault } from '@/lib/enbox/biometric-vault';

// Retrieve the destroyDB spy from the hoisted jest.mock factory. The
// factory builds the `jest.fn()` internally (to dodge the TDZ trap
// where module-level `const`s are not yet initialised when Jest calls
// the factory eagerly) and exposes it as `LevelDB.destroyDB`.
const { LevelDB: _MockLevelDB } = jest.requireMock('react-native-leveldb') as {
  LevelDB: { destroyDB: jest.Mock };
};
const mockDestroyDB = _MockLevelDB.destroyDB;

const nativeSecure = NativeSecureStorage as unknown as {
  getItem: jest.Mock;
  setItem: jest.Mock;
  deleteItem: jest.Mock;
};

const nativeBiometric = NativeBiometricVault as unknown as {
  deleteSecret: jest.Mock;
};

function resetStoreState() {
  useAgentStore.setState({
    agent: null,
    authManager: null,
    vault: null,
    isInitializing: false,
    error: null,
    biometricState: null,
    recoveryPhrase: null,
    identities: [],
  });
}

beforeEach(() => {
  resetStoreState();
  mockDestroyDB.mockReset();
  mockDestroyDB.mockImplementation(() => undefined);
  nativeSecure.getItem.mockReset().mockResolvedValue(null);
  nativeSecure.setItem.mockReset().mockResolvedValue(undefined);
  nativeSecure.deleteItem.mockReset().mockResolvedValue(undefined);
  (globalThis as any).__enboxMobilePatchedAgentDwnApi = false;
});

// ===========================================================================
// BLOCKER 3 — reset() wipes persistent ENBOX_AGENT LevelDB data
// ===========================================================================
describe('useAgentStore.reset() — LevelDB wipe (scrutiny blocker 3)', () => {
  it('destroys every ENBOX_AGENT sub-database via react-native-leveldb.destroyDB', async () => {
    // Warm up state so there's a vault + agent to tear down.
    await useAgentStore.getState().initializeFirstLaunch();
    mockDestroyDB.mockClear();

    await useAgentStore.getState().reset();

    // reset() delegates to destroyAgentLevelDatabases('ENBOX_AGENT')
    // which enumerates the known sub-locations and invokes
    // LevelDB.destroyDB(name, true) for each. Every destroyDB call
    // must pass `force: true` so an open handle is closed first.
    expect(mockDestroyDB).toHaveBeenCalled();
    for (const call of mockDestroyDB.mock.calls) {
      expect(call[0]).toMatch(/^ENBOX_AGENT__/);
      expect(call[1]).toBe(true);
    }
    // The canonical ENBOX_AGENT sub-databases must all be wiped in one
    // reset() call. At minimum VAULT_STORE and DWN_DATASTORE are
    // included; exact count is pinned in rn-level's
    // AGENT_LEVEL_DB_SUBPATHS export.
    const destroyedNames = mockDestroyDB.mock.calls.map((c) => c[0]);
    expect(destroyedNames).toEqual(expect.arrayContaining([
      'ENBOX_AGENT__VAULT_STORE',
      'ENBOX_AGENT__DWN_DATASTORE',
    ]));
  });

  it('still completes reset() even if LevelDB.destroyDB throws (idempotent)', async () => {
    await useAgentStore.getState().initializeFirstLaunch();

    // First destroy rejects — subsequent ones still run but reset()
    // must swallow the error and return cleanly.
    mockDestroyDB.mockImplementationOnce(() => {
      throw new Error('simulated on-disk wipe failure');
    });

    await expect(useAgentStore.getState().reset()).resolves.toBeUndefined();

    // Agent-store state is still torn down even though one wipe threw.
    const s = useAgentStore.getState();
    expect(s.agent).toBeNull();
    expect(s.vault).toBeNull();
    expect(s.recoveryPhrase).toBeNull();
  });

  it('also wipes LevelDB on the no-vault fallback path', async () => {
    // Ensure the store has NO vault instance before calling reset.
    resetStoreState();
    expect(useAgentStore.getState().vault).toBeNull();

    await useAgentStore.getState().reset();

    expect(mockDestroyDB).toHaveBeenCalled();
    const destroyedNames = mockDestroyDB.mock.calls.map((c) => c[0]);
    expect(destroyedNames).toEqual(expect.arrayContaining([
      'ENBOX_AGENT__VAULT_STORE',
    ]));
  });
});

// ===========================================================================
// BLOCKER 4 — reset() fallback (no vault) clears SecureStorage keys
// ===========================================================================
describe('useAgentStore.reset() — no-vault fallback clears SecureStorage keys (scrutiny blocker 4)', () => {
  it('deletes enbox.vault.initialized AND enbox.vault.biometric-state even when state.vault is null', async () => {
    // Fallback path precondition: state.vault is null.
    resetStoreState();
    expect(useAgentStore.getState().vault).toBeNull();

    await useAgentStore.getState().reset();

    // The two keys that BiometricVault.reset() would have cleared must
    // also be cleared by the fallback path. SecureStorageAdapter
    // prefixes keys with `enbox:`, so the raw NativeSecureStorage
    // deleteItem calls use `enbox:enbox.vault.initialized` and
    // `enbox:enbox.vault.biometric-state`.
    const deletedKeys = nativeSecure.deleteItem.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        'enbox:enbox.vault.initialized',
        'enbox:enbox.vault.biometric-state',
      ]),
    );

    // The native secret is also deleted directly via the native module.
    expect(nativeBiometric.deleteSecret).toHaveBeenCalledWith('enbox.wallet.root');
  });

  it('still clears SecureStorage keys even when NativeBiometricVault.deleteSecret rejects', async () => {
    resetStoreState();
    nativeBiometric.deleteSecret.mockRejectedValueOnce(
      Object.assign(new Error('simulated native error'), { code: 'VAULT_ERROR' }),
    );

    await expect(useAgentStore.getState().reset()).resolves.toBeUndefined();

    const deletedKeys = nativeSecure.deleteItem.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        'enbox:enbox.vault.initialized',
        'enbox:enbox.vault.biometric-state',
      ]),
    );
  });

  it('the main-path (with vault) also leaves those SecureStorage keys cleared', async () => {
    // Construct a vault whose SecureStorage is NativeSecureStorage-backed
    // so we can prove the ultimate storage is wiped end-to-end. The
    // store's `initializeFirstLaunch` plumbs a SecureStorageAdapter-backed
    // vault automatically via createBiometricVault().
    await useAgentStore.getState().initializeFirstLaunch();
    expect(useAgentStore.getState().vault).toBeInstanceOf(BiometricVault);

    nativeSecure.deleteItem.mockClear();

    await useAgentStore.getState().reset();

    const deletedKeys = nativeSecure.deleteItem.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        'enbox:enbox.vault.initialized',
        'enbox:enbox.vault.biometric-state',
      ]),
    );
  });
});
