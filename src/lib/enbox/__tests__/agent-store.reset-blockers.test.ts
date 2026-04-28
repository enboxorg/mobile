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
    return {
      __esModule: true,
      AuthManager: { create },
      // Round-12 F3: surface the canonical STORAGE_KEYS so
      // `useAgentStore.reset()` can iterate them and wipe persisted
      // AuthManager material from SecureStorage. Mirrors the real
      // export from `@enbox/auth/types.ts`.
      STORAGE_KEYS: {
        PREVIOUSLY_CONNECTED: 'enbox:auth:previouslyConnected',
        ACTIVE_IDENTITY: 'enbox:auth:activeIdentity',
        DELEGATE_DID: 'enbox:auth:delegateDid',
        CONNECTED_DID: 'enbox:auth:connectedDid',
        DELEGATE_DECRYPTION_KEYS: 'enbox:auth:delegateDecryptionKeys',
        DELEGATE_CONTEXT_KEYS: 'enbox:auth:delegateContextKeys',
        DELEGATE_MULTI_PARTY_PROTOCOLS:
          'enbox:auth:delegateMultiPartyProtocols',
        LOCAL_DWN_ENDPOINT: 'enbox:auth:localDwnEndpoint',
        REGISTRATION_TOKENS: 'enbox:auth:registrationTokens',
        SESSION_REVOCATIONS: 'enbox:auth:sessionRevocations',
        REVOCATION_RETRY_CONTEXT: 'enbox:auth:revocationRetryContext',
      },
      __mocks__: { create },
    };
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
  // `teardown()` also cancels the refreshIdentities() agentDid-race
  // poller that `initializeFirstLaunch` may have scheduled when the mock
  // agent leaves `agentDid` unset. Without this the real setInterval
  // ticks past test completion and Jest emits "did not exit one second
  // after the test run".
  useAgentStore.getState().teardown();
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

  // Round-9 F4: the previous test pinned the SWALLOWED-error contract
  // ("reset() resolves cleanly even when destroyDB throws"). That
  // hides genuine wipe failures from the caller and leaves stale
  // identities / DWN records on disk that the next
  // `initializeFirstLaunch()` resurrects via the LevelDB handle the
  // agent opens against `dataPath`. The new contract is fail-LOUD:
  //   1. The in-memory state is torn down (agent / vault / phrase null).
  //   2. A `LEVELDB_CLEANUP_PENDING_KEY` sentinel is persisted to
  //      SecureStorage so the next agent-init flow retries the wipe
  //      before opening any LevelDB handle.
  //   3. The LevelDB error is RETHROWN so callers (Settings,
  //      recovery-restore-screen) can surface the failure and offer a
  //      retry, instead of reporting success on a half-completed wipe.
  it('rethrows LevelDB.destroyDB failure AND persists a cleanup-pending sentinel (Round-9 F4)', async () => {
    await useAgentStore.getState().initializeFirstLaunch();

    // First destroy rejects — subsequent ones still run but reset()
    // must rethrow after persisting the retry sentinel.
    mockDestroyDB.mockImplementationOnce(() => {
      throw new Error('simulated on-disk wipe failure');
    });

    let thrown: unknown = null;
    try {
      await useAgentStore.getState().reset();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    // ``destroyAgentLevelDatabases`` aggregates per-subpath failures
    // into a single Error whose message lists the failed subpaths
    // and whose ``cause`` is the original failure list. The cause
    // must include the simulated failure so a developer reading
    // logs can correlate to the test.
    const errMessage = (thrown as Error).message;
    expect(errMessage).toMatch(/destroyAgentLevelDatabases.*subpaths failed to wipe/);
    const cause = (thrown as unknown as { cause?: unknown }).cause;
    expect(Array.isArray(cause)).toBe(true);
    const causes = cause as Array<{ subpath: string; error: Error }>;
    expect(causes.length).toBeGreaterThanOrEqual(1);
    expect(causes[0].error).toBeInstanceOf(Error);
    expect(causes[0].error.message).toMatch(/simulated on-disk wipe failure/);

    // Agent-store state IS still torn down even though the wipe threw.
    // The throw happens AFTER teardown so a caller swallowing it still
    // ends up in a consistent in-memory state.
    const s = useAgentStore.getState();
    expect(s.agent).toBeNull();
    expect(s.vault).toBeNull();
    expect(s.recoveryPhrase).toBeNull();

    // The retry sentinel was persisted under the canonical key.
    // The SecureStorageAdapter prefixes every key with 'enbox:' before
    // writing through NativeSecureStorage, so the on-disk key is
    // `enbox:` + `enbox.agent.leveldb-cleanup-pending`.
    const sentinelWrites = nativeSecure.setItem.mock.calls.filter(
      (c) => c[0] === 'enbox:enbox.agent.leveldb-cleanup-pending',
    );
    expect(sentinelWrites.length).toBeGreaterThanOrEqual(1);
    expect(sentinelWrites[0][1]).toBe('true');
  });

  // Round-9 F4 cont.: regression test for the recovery path. After a
  // failed reset() persists the sentinel, the very NEXT
  // `initializeFirstLaunch()` MUST retry the wipe before opening the
  // LevelDB handle. We pin this here so a future refactor that drops
  // `runPendingLevelDbCleanup()` from the init flow is caught by CI.
  it('next initializeFirstLaunch() retries the LevelDB wipe via the sentinel', async () => {
    // Stub SecureStorage.get to report the sentinel as set on first
    // read (simulating the post-failed-reset state on a cold launch).
    nativeSecure.getItem.mockImplementation(async (key: string) => {
      if (key === 'enbox:enbox.agent.leveldb-cleanup-pending') return 'true';
      return null;
    });
    // Reset the destroyDB spy so we only count the calls made by the
    // pending-cleanup retry (NOT a baseline reset).
    mockDestroyDB.mockReset();
    mockDestroyDB.mockImplementation(() => undefined);

    await useAgentStore.getState().initializeFirstLaunch();

    // The retry must run the destroyDB call against the canonical
    // sub-databases — same surface as a real reset() wipe.
    expect(mockDestroyDB).toHaveBeenCalled();
    const destroyedNames = mockDestroyDB.mock.calls.map((c) => c[0]);
    expect(destroyedNames).toEqual(
      expect.arrayContaining(['ENBOX_AGENT__VAULT_STORE']),
    );
    // And the sentinel was deleted after the successful retry.
    const sentinelDeletes = nativeSecure.deleteItem.mock.calls.filter(
      (c) => c[0] === 'enbox:enbox.agent.leveldb-cleanup-pending',
    );
    expect(sentinelDeletes.length).toBeGreaterThanOrEqual(1);
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

  // Round-10 F2: pre-fix this test codified the SWALLOWED-error
  // contract ("reset() resolves cleanly even when native deleteSecret
  // throws"). That hides genuine native wipe failures from the caller
  // and leaves the OS-gated secret alive while the app reports
  // success and routes back to setup. The new contract is fail-LOUD:
  //   1. The SecureStorage flags are STILL cleared (defense in depth).
  //   2. The `VAULT_RESET_PENDING_KEY` sentinel is persisted (so the
  //      next agent-init flow retries the native wipe via
  //      `runPendingVaultResetCleanup()`).
  //   3. The native error is RETHROWN so callers (Settings,
  //      recovery-restore-screen) can surface the failure and offer
  //      a retry instead of reporting success on a half-completed wipe.
  it('rethrows native deleteSecret failure AND persists a vault-reset-pending sentinel (Round-10 F2)', async () => {
    resetStoreState();
    nativeBiometric.deleteSecret.mockRejectedValueOnce(
      Object.assign(new Error('simulated native error'), { code: 'VAULT_ERROR' }),
    );

    await expect(useAgentStore.getState().reset()).rejects.toThrow(
      /simulated native error/,
    );

    // SecureStorage flags STILL cleared (defense in depth — even
    // though the native delete failed, removing the flags ensures the
    // hydrate gate can route to onboarding instead of an unlock loop).
    const deletedKeys = nativeSecure.deleteItem.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        'enbox:enbox.vault.initialized',
        'enbox:enbox.vault.biometric-state',
      ]),
    );

    // The vault-reset-pending sentinel was persisted under the
    // canonical key. SecureStorageAdapter prefixes every key with
    // 'enbox:' so the on-disk key is `enbox:enbox.vault.reset-pending`.
    const sentinelWrites = nativeSecure.setItem.mock.calls.filter(
      (c) => c[0] === 'enbox:enbox.vault.reset-pending',
    );
    expect(sentinelWrites.length).toBeGreaterThanOrEqual(1);
    expect(sentinelWrites[0][1]).toBe('true');

    // The sentinel was NOT cleared (it stays set so the next
    // agent-init flow retries the native wipe).
    const sentinelDeletes = nativeSecure.deleteItem.mock.calls.filter(
      (c) => c[0] === 'enbox:enbox.vault.reset-pending',
    );
    expect(sentinelDeletes.length).toBe(0);
  });

  // Round-10 F2 cont.: regression test for the recovery path. After a
  // failed reset persists the sentinel, the very NEXT agent-init flow
  // MUST retry the native delete + SecureStorage clears before any
  // unlock / setup proceeds.
  it('next initializeFirstLaunch() retries the native wipe via the vault-reset sentinel (Round-10 F2)', async () => {
    nativeSecure.getItem.mockImplementation(async (key: string) => {
      if (key === 'enbox:enbox.vault.reset-pending') return 'true';
      return null;
    });
    nativeBiometric.deleteSecret.mockClear();

    await useAgentStore.getState().initializeFirstLaunch();

    // The retry must call native deleteSecret with the canonical alias.
    const deleteCalls = nativeBiometric.deleteSecret.mock.calls.filter(
      (c) => c[0] === 'enbox.wallet.root',
    );
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    // And the sentinel was deleted after the retry succeeded.
    const sentinelDeletes = nativeSecure.deleteItem.mock.calls.filter(
      (c) => c[0] === 'enbox:enbox.vault.reset-pending',
    );
    expect(sentinelDeletes.length).toBeGreaterThanOrEqual(1);
  });

  // Round-10 F3: the LevelDB cleanup helper now fails CLOSED on
  // SecureStorage read failures. Pre-fix it logged a warning and
  // returned `true` ("no pending cleanup"), which let a transient
  // SecureStorage failure route the next agent init past a
  // still-unreaped LevelDB. The unknown-state path MUST throw.
  it('runPendingLevelDbCleanup propagates SecureStorage.get failures so a stale LevelDB cannot leak through (Round-10 F3)', async () => {
    const { runPendingLevelDbCleanup } = require('@/lib/enbox/agent-store');
    const stubError = Object.assign(new Error('SecureStorage temporarily unavailable'), {
      code: 'SECURE_STORAGE_LOCKED',
    });
    const stubStorage = {
      get: jest.fn(async () => {
        throw stubError;
      }),
      remove: jest.fn(async () => undefined),
    };
    await expect(runPendingLevelDbCleanup(stubStorage)).rejects.toThrow(
      /SecureStorage temporarily unavailable/,
    );
    // The retry never ran because we couldn't read the sentinel —
    // confirms we are NOT silently calling destroyAgentLevelDatabases
    // on every cold launch as a "fail-pessimistic" workaround.
    expect(stubStorage.remove).not.toHaveBeenCalled();
  });

  // Round-10 F4: resumePendingBackup MUST gate on the same cleanup
  // helpers as the other init flows. Pre-fix it jumped straight to
  // `initializeAgent()`, so a backup-pending session that interleaved
  // with a failed reset would open the stale LevelDB / unlock the
  // stale OS-gated secret here. The store-mocked `agent.start({})`
  // does not actually unlock the vault (that requires the real
  // BiometricVault wiring), so `vault.getMnemonic()` will throw
  // VAULT_ERROR_LOCKED — which is fine, the cleanup MUST already have
  // run by then. We assert on the cleanup call ordering, not on
  // resumePendingBackup completing successfully.
  it('resumePendingBackup retries the LevelDB wipe via the cleanup-pending sentinel BEFORE creating the agent (Round-10 F4)', async () => {
    nativeSecure.getItem.mockImplementation(async (key: string) => {
      if (key === 'enbox:enbox.agent.leveldb-cleanup-pending') return 'true';
      return null;
    });
    mockDestroyDB.mockReset();
    mockDestroyDB.mockImplementation(() => undefined);

    // Don't fail the test on the locked-vault rejection from the
    // virtual-mocked agent.start({}). The wiring assertion is the
    // contract here.
    await useAgentStore.getState().resumePendingBackup().catch(() => undefined);

    expect(mockDestroyDB).toHaveBeenCalled();
    const destroyedNames = mockDestroyDB.mock.calls.map((c) => c[0]);
    expect(destroyedNames).toEqual(
      expect.arrayContaining(['ENBOX_AGENT__VAULT_STORE']),
    );
    const sentinelDeletes = nativeSecure.deleteItem.mock.calls.filter(
      (c) => c[0] === 'enbox:enbox.agent.leveldb-cleanup-pending',
    );
    expect(sentinelDeletes.length).toBeGreaterThanOrEqual(1);
  });

  // Round-10 F4: also assert resumePendingBackup runs the vault-reset
  // cleanup so a stale OS-gated secret cannot survive a backup-pending
  // resume. Same wiring approach as the LevelDB test above.
  it('resumePendingBackup retries the native vault wipe via the vault-reset sentinel BEFORE creating the agent (Round-10 F4)', async () => {
    nativeSecure.getItem.mockImplementation(async (key: string) => {
      if (key === 'enbox:enbox.vault.reset-pending') return 'true';
      return null;
    });
    nativeBiometric.deleteSecret.mockClear();

    await useAgentStore.getState().resumePendingBackup().catch(() => undefined);

    const deleteCalls = nativeBiometric.deleteSecret.mock.calls.filter(
      (c) => c[0] === 'enbox.wallet.root',
    );
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    const sentinelDeletes = nativeSecure.deleteItem.mock.calls.filter(
      (c) => c[0] === 'enbox:enbox.vault.reset-pending',
    );
    expect(sentinelDeletes.length).toBeGreaterThanOrEqual(1);
  });

  // Round-12 F3: parallel coverage for the AUTH_RESET sentinel —
  // every agent-init flow MUST also retry the auth wipe so a
  // stale `enbox:auth:*` keystore cannot survive a backup-pending
  // resume / first-launch / unlock / restore that interleaved with
  // a failed reset.
  it('resumePendingBackup retries the AUTH wipe via the auth-reset sentinel BEFORE creating the agent (Round-12 F3)', async () => {
    nativeSecure.getItem.mockImplementation(async (key: string) => {
      if (key === 'enbox:enbox.auth.reset-pending') return 'true';
      return null;
    });
    nativeSecure.deleteItem.mockClear();

    await useAgentStore.getState().resumePendingBackup().catch(() => undefined);

    // The 11 STORAGE_KEYS were each removed via the SecureStorage
    // adapter (which prefixes 'enbox:' before NativeSecureStorage).
    const deletedKeys = nativeSecure.deleteItem.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        'enbox:enbox:auth:previouslyConnected',
        'enbox:enbox:auth:activeIdentity',
        'enbox:enbox:auth:delegateDid',
        'enbox:enbox:auth:delegateDecryptionKeys',
      ]),
    );
    // And the sentinel was deleted after the retry succeeded.
    const sentinelDeletes = nativeSecure.deleteItem.mock.calls.filter(
      (c) => c[0] === 'enbox:enbox.auth.reset-pending',
    );
    expect(sentinelDeletes.length).toBeGreaterThanOrEqual(1);
  });

  it('initializeFirstLaunch retries the AUTH wipe via the auth-reset sentinel BEFORE creating the agent (Round-12 F3)', async () => {
    nativeSecure.getItem.mockImplementation(async (key: string) => {
      if (key === 'enbox:enbox.auth.reset-pending') return 'true';
      return null;
    });
    nativeSecure.deleteItem.mockClear();

    await useAgentStore.getState().initializeFirstLaunch();

    const deletedKeys = nativeSecure.deleteItem.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        'enbox:enbox:auth:activeIdentity',
        'enbox:enbox:auth:delegateDecryptionKeys',
      ]),
    );
    const sentinelDeletes = nativeSecure.deleteItem.mock.calls.filter(
      (c) => c[0] === 'enbox:enbox.auth.reset-pending',
    );
    expect(sentinelDeletes.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// Round-10 F2 — runPendingVaultResetCleanup helper contract
// ===========================================================================
describe('runPendingVaultResetCleanup — Round-10 F2', () => {
  it('is a no-op when the sentinel is absent', async () => {
    const { runPendingVaultResetCleanup } = require('@/lib/enbox/agent-store');
    const sentinelStorage = {
      get: jest.fn(async () => null),
      set: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
    };
    const stubNative = { deleteSecret: jest.fn(async () => undefined) };
    const stubVaultStorage = {
      remove: jest.fn(async () => undefined),
    };
    await expect(
      runPendingVaultResetCleanup(sentinelStorage, stubNative, stubVaultStorage),
    ).resolves.toBe(true);
    expect(stubNative.deleteSecret).not.toHaveBeenCalled();
    expect(stubVaultStorage.remove).not.toHaveBeenCalled();
    // Sentinel was not cleared because it was not set.
    expect(sentinelStorage.remove).not.toHaveBeenCalled();
  });

  it('runs deleteSecret + clears both vault flags when the sentinel is set', async () => {
    const { runPendingVaultResetCleanup } = require('@/lib/enbox/agent-store');
    const sentinelStorage = {
      get: jest.fn(async () => 'true'),
      set: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
    };
    const stubNative = { deleteSecret: jest.fn(async () => undefined) };
    const stubVaultStorage = {
      remove: jest.fn(async () => undefined),
    };
    await expect(
      runPendingVaultResetCleanup(sentinelStorage, stubNative, stubVaultStorage),
    ).resolves.toBe(true);
    expect(stubNative.deleteSecret).toHaveBeenCalledWith('enbox.wallet.root');
    expect(stubVaultStorage.remove).toHaveBeenCalledWith('enbox.vault.initialized');
    expect(stubVaultStorage.remove).toHaveBeenCalledWith('enbox.vault.biometric-state');
    expect(sentinelStorage.remove).toHaveBeenCalledWith('enbox.vault.reset-pending');
  });

  it('propagates the native delete failure and keeps the sentinel set for retry', async () => {
    const { runPendingVaultResetCleanup } = require('@/lib/enbox/agent-store');
    const sentinelStorage = {
      get: jest.fn(async () => 'true'),
      set: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
    };
    const stubNative = {
      deleteSecret: jest.fn(async () => {
        throw Object.assign(new Error('Keystore unreachable'), {
          code: 'VAULT_ERROR',
        });
      }),
    };
    const stubVaultStorage = {
      remove: jest.fn(async () => undefined),
    };
    await expect(
      runPendingVaultResetCleanup(sentinelStorage, stubNative, stubVaultStorage),
    ).rejects.toThrow(/Keystore unreachable/);
    // Sentinel NOT cleared — next launch retries.
    expect(sentinelStorage.remove).not.toHaveBeenCalled();
  });

  it('propagates SecureStorage.get failures so an unreadable sentinel cannot leak through (Round-10 F3 parity)', async () => {
    const { runPendingVaultResetCleanup } = require('@/lib/enbox/agent-store');
    const stubError = Object.assign(new Error('SecureStorage IO error'), {
      code: 'SECURE_STORAGE_IO',
    });
    const sentinelStorage = {
      get: jest.fn(async () => {
        throw stubError;
      }),
      set: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
    };
    const stubNative = { deleteSecret: jest.fn(async () => undefined) };
    const stubVaultStorage = { remove: jest.fn(async () => undefined) };
    await expect(
      runPendingVaultResetCleanup(sentinelStorage, stubNative, stubVaultStorage),
    ).rejects.toThrow(/SecureStorage IO error/);
    expect(stubNative.deleteSecret).not.toHaveBeenCalled();
    expect(stubVaultStorage.remove).not.toHaveBeenCalled();
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

// ===========================================================================
// Round-11 F3 — useAgentStore.reset() fails CLOSED when sentinel write fails
// ===========================================================================
//
// Pre-fix `agent-store.reset()` swallowed `SecureStorage.set()` failures
// when persisting the VAULT_RESET_PENDING_KEY sentinel via `console.warn`
// and continued into the wipe steps. That defeated the entire crash-
// resilience contract: if SecureStorage is unwritable AND the
// subsequent native delete fails (or the process dies mid-reset), the
// next launch has no sentinel to force the cleanup retry. The user
// lands in a half-cleaned state with no automatic recovery.
//
// The fix: throw before touching the native vault / LevelDB / session
// store. The user (via the new Settings UI alert) can retry — typical
// SecureStorage failures are transient. A persistent SecureStorage
// failure is a system-level problem the user must resolve before any
// reset can land.
describe('useAgentStore.reset() — fail-CLOSED on sentinel write failure (Round-11 F3)', () => {
  it('throws (does NOT proceed to wipe) when the sentinel-set step fails', async () => {
    await useAgentStore.getState().initializeFirstLaunch();
    expect(useAgentStore.getState().vault).toBeInstanceOf(BiometricVault);

    nativeSecure.deleteItem.mockClear();

    // Make every SecureStorage WRITE fail. The sentinel persistence
    // is the FIRST WRITE issued by reset(), so the stub will trip
    // there and reset() must throw before any native delete /
    // SecureStorage REMOVE / LevelDB destroy runs.
    const setError = Object.assign(new Error('SecureStorage out of disk space'), {
      code: 'SECURE_STORAGE_IO',
    });
    nativeSecure.setItem.mockImplementationOnce(async () => {
      throw setError;
    });

    await expect(useAgentStore.getState().reset()).rejects.toThrow(
      /SecureStorage out of disk space/,
    );

    // CRITICAL: nothing destructive should have run. The sentinel
    // could not be written, so the retry path is unavailable;
    // failing CLOSED keeps the user's wallet intact for a manual
    // retry once SecureStorage recovers.
    //
    // We assert the BIOMETRIC vault native delete was never called.
    // (The session store reset / LevelDB destroy paths are also
    // skipped by the same throw — they're invoked AFTER the native
    // delete in the reset() ordering.)
    const biometricMock = (global as any).__enboxBiometricVaultMock as {
      deleteSecret: jest.Mock;
    };
    expect(biometricMock.deleteSecret).not.toHaveBeenCalled();
  });

  it('proceeds normally when the sentinel-set step succeeds (control)', async () => {
    await useAgentStore.getState().initializeFirstLaunch();
    expect(useAgentStore.getState().vault).toBeInstanceOf(BiometricVault);

    nativeSecure.deleteItem.mockClear();
    const biometricMock = (global as any).__enboxBiometricVaultMock as {
      deleteSecret: jest.Mock;
    };
    biometricMock.deleteSecret.mockClear();

    // Default mock impl from jest.setup.js resolves all writes.
    await useAgentStore.getState().reset();

    // The native delete ran AND the SecureStorage REMOVE for the
    // sentinel ran (sentinel was cleared after a successful wipe).
    expect(biometricMock.deleteSecret).toHaveBeenCalled();
    const deletedKeys = nativeSecure.deleteItem.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toEqual(
      expect.arrayContaining(['enbox:enbox.vault.reset-pending']),
    );
  });
});

// ===========================================================================
// Round-12 F1 — LevelDB cleanup-pending sentinel is written BEFORE the wipe
// ===========================================================================
//
// Pre-fix `agent-store.reset()` only wrote `LEVELDB_CLEANUP_PENDING_KEY`
// inside the destroy-failed catch block. A SIGKILL / OOM / JS engine
// death during the multi-subpath wipe (8 sub-databases) left LevelDB
// partially deleted with NO sentinel on disk — `runPendingLevelDbCleanup()`
// would skip the retry on the next launch, and `EnboxUserAgent.create()`
// would open a corrupt / half-deleted database.
//
// The fix mirrors the round-11 F3 pattern: write the sentinel FIRST
// (in step 0 of reset()), fail-CLOSED on write failure, clear ONLY
// after the wipe succeeds.
describe('useAgentStore.reset() — LevelDB sentinel written BEFORE the wipe (Round-12 F1)', () => {
  it('persists LEVELDB_CLEANUP_PENDING_KEY BEFORE destroyAgentLevelDatabases is invoked', async () => {
    await useAgentStore.getState().initializeFirstLaunch();
    expect(useAgentStore.getState().vault).toBeInstanceOf(BiometricVault);

    // Snapshot the order of native calls so we can prove the
    // sentinel write happened BEFORE the destroyDB call. We use a
    // single timeline array fed by both `setItem` and the
    // `destroyDB` mock.
    const timeline: Array<{ kind: 'set' | 'destroy'; key?: string }> = [];
    nativeSecure.setItem.mockImplementation(async (key: string) => {
      timeline.push({ kind: 'set', key });
    });
    mockDestroyDB.mockImplementation(() => {
      timeline.push({ kind: 'destroy' });
      return undefined;
    });

    await useAgentStore.getState().reset();

    // Find the index of the FIRST LevelDB sentinel write and the
    // FIRST destroyDB call. The write MUST appear before the call.
    const firstSentinelWrite = timeline.findIndex(
      (e) =>
        e.kind === 'set' && e.key === 'enbox:enbox.agent.leveldb-cleanup-pending',
    );
    const firstDestroy = timeline.findIndex((e) => e.kind === 'destroy');
    expect(firstSentinelWrite).toBeGreaterThanOrEqual(0);
    expect(firstDestroy).toBeGreaterThanOrEqual(0);
    expect(firstSentinelWrite).toBeLessThan(firstDestroy);
  });

  it('keeps LEVELDB_CLEANUP_PENDING_KEY set when destroyAgentLevelDatabases throws mid-wipe (crash resilience)', async () => {
    await useAgentStore.getState().initializeFirstLaunch();
    expect(useAgentStore.getState().vault).toBeInstanceOf(BiometricVault);

    nativeSecure.deleteItem.mockClear();
    nativeSecure.setItem.mockClear();

    // Force ALL destroyDB calls to throw (simulating a permission
    // denied / IO error mid-wipe). The reset() should rethrow the
    // LevelDB error AND leave the sentinel SET on disk so the next
    // cold launch retries the wipe.
    mockDestroyDB.mockImplementation(() => {
      throw new Error('IO error: lock /data/.../LOCK: Permission denied');
    });

    // The destroyAgentLevelDatabases() helper aggregates the
    // sub-path failures into a single Error whose message starts
    // with "destroyAgentLevelDatabases:" — that's what reset()
    // rethrows on the failure path.
    await expect(useAgentStore.getState().reset()).rejects.toThrow(
      /destroyAgentLevelDatabases:/,
    );

    // Sentinel was written (step 0 of reset()).
    const sentinelWrites = nativeSecure.setItem.mock.calls.filter(
      (c) => c[0] === 'enbox:enbox.agent.leveldb-cleanup-pending',
    );
    expect(sentinelWrites.length).toBeGreaterThanOrEqual(1);
    // Sentinel was NOT cleared (step 6's clear is gated on a
    // successful wipe; failure leaves the sentinel set).
    const sentinelDeletes = nativeSecure.deleteItem.mock.calls.filter(
      (c) => c[0] === 'enbox:enbox.agent.leveldb-cleanup-pending',
    );
    expect(sentinelDeletes.length).toBe(0);
  });

  it('rolls back already-written sentinels when a later sentinel write fails (fail-CLOSED)', async () => {
    await useAgentStore.getState().initializeFirstLaunch();
    expect(useAgentStore.getState().vault).toBeInstanceOf(BiometricVault);

    nativeSecure.deleteItem.mockClear();
    nativeSecure.setItem.mockClear();

    // Make the LEVELDB sentinel write specifically fail. The vault
    // sentinel write (the first call) succeeds; the leveldb sentinel
    // (the second call) fails. The reset() MUST throw AND
    // best-effort roll back the vault sentinel via the deleteItem
    // path.
    nativeSecure.setItem.mockImplementation(async (key: string) => {
      if (key === 'enbox:enbox.agent.leveldb-cleanup-pending') {
        throw new Error('SecureStorage IO error');
      }
    });

    await expect(useAgentStore.getState().reset()).rejects.toThrow(
      /SecureStorage IO error/,
    );

    // Vault sentinel was rolled back (deleteItem called for it).
    const vaultSentinelRollback = nativeSecure.deleteItem.mock.calls.filter(
      (c) => c[0] === 'enbox:enbox.vault.reset-pending',
    );
    expect(vaultSentinelRollback.length).toBeGreaterThanOrEqual(1);

    // Critical: NO destructive operations ran (vault deleteSecret,
    // destroyDB).
    const biometricMock = (global as any).__enboxBiometricVaultMock as {
      deleteSecret: jest.Mock;
    };
    expect(biometricMock.deleteSecret).not.toHaveBeenCalled();
    expect(mockDestroyDB).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Round-12 F2 — session reset deferred until ALL critical wipes succeed
// ===========================================================================
//
// Pre-fix `agent-store.reset()` ALWAYS called `useSessionStore.getState().reset()`
// before rethrowing. `session.reset()` sets `biometricStatus: 'unknown'`
// which the navigator routes to `Loading` (see `getInitialRoute` rule 3).
// The Settings UI showed the reset-failure Alert ON TOP of the transition,
// but dismissing it left the user stranded on a permanent Loading screen
// until they backgrounded the app.
//
// The fix: skip session reset on failure. The session-store keeps its
// prior `hasIdentity=true` / `biometricStatus='ready'` flags so the
// Settings screen stays mounted and the follow-up Alert renders against
// a stable navigator. Retry sentinels handle next-launch recovery.
describe('useAgentStore.reset() — defers session-store reset on failure (Round-12 F2)', () => {
  it('does NOT reset session-store when LevelDB wipe fails', async () => {
    await useAgentStore.getState().initializeFirstLaunch();
    expect(useAgentStore.getState().vault).toBeInstanceOf(BiometricVault);

    // Pre-populate the session-store with a "main app" snapshot so
    // we can detect a reset() afterwards.
    const { useSessionStore } = require('@/features/session/session-store');
    useSessionStore.setState({
      hasIdentity: true,
      isLocked: false,
      hasCompletedOnboarding: true,
      biometricStatus: 'ready',
      isHydrated: true,
    });

    // Force the LevelDB destroy to fail. Vault wipe / auth wipe
    // remain on the default success mocks.
    mockDestroyDB.mockImplementation(() => {
      throw new Error('LevelDB unavailable');
    });

    // destroyAgentLevelDatabases wraps sub-path failures in an
    // aggregate Error whose message starts with
    // "destroyAgentLevelDatabases:".
    await expect(useAgentStore.getState().reset()).rejects.toThrow(
      /destroyAgentLevelDatabases:/,
    );

    // The session-store snapshot MUST be unchanged. A pre-fix
    // reset() would have flipped `biometricStatus` to `'unknown'`
    // and `hasIdentity` to `false`, routing the navigator to
    // `Loading`.
    const session = useSessionStore.getState();
    expect(session.hasIdentity).toBe(true);
    expect(session.isLocked).toBe(false);
    expect(session.hasCompletedOnboarding).toBe(true);
    expect(session.biometricStatus).toBe('ready');
  });

  it('does NOT reset session-store when vault wipe fails', async () => {
    await useAgentStore.getState().initializeFirstLaunch();

    const { useSessionStore } = require('@/features/session/session-store');
    useSessionStore.setState({
      hasIdentity: true,
      isLocked: false,
      hasCompletedOnboarding: true,
      biometricStatus: 'ready',
      isHydrated: true,
    });

    // Force vault.reset() to fail by stubbing native deleteSecret.
    nativeBiometric.deleteSecret.mockRejectedValueOnce(
      Object.assign(new Error('Keystore unreachable'), { code: 'VAULT_ERROR' }),
    );

    await expect(useAgentStore.getState().reset()).rejects.toThrow(
      /Keystore unreachable/,
    );

    // Session-store snapshot unchanged.
    const session = useSessionStore.getState();
    expect(session.hasIdentity).toBe(true);
    expect(session.biometricStatus).toBe('ready');
  });

  it('DOES reset session-store on successful reset (control — happy path)', async () => {
    await useAgentStore.getState().initializeFirstLaunch();

    const { useSessionStore } = require('@/features/session/session-store');
    useSessionStore.setState({
      hasIdentity: true,
      isLocked: false,
      hasCompletedOnboarding: true,
      biometricStatus: 'ready',
      isHydrated: true,
    });

    // Default mocks all succeed.
    await useAgentStore.getState().reset();

    // Session-store WAS reset to the canonical post-reset snapshot.
    const session = useSessionStore.getState();
    expect(session.hasIdentity).toBe(false);
    expect(session.hasCompletedOnboarding).toBe(false);
    // session.reset() sets `biometricStatus: 'unknown'` which the
    // Settings UI handler then re-resolves via `hydrate()`.
    expect(session.biometricStatus).toBe('unknown');
  });
});

// ===========================================================================
// Round-12 F3 — wallet reset clears persisted AuthManager / Web5 connect material
// ===========================================================================
//
// Pre-fix `agent-store.reset()` cleared vault + LevelDB + session state
// but NEVER touched the `enbox:auth:*` keys that `AuthManager` writes
// through its `SecureStorageAdapter`. The new wallet inherited the
// previous wallet's `activeIdentity` DID, `delegateDid` +
// `delegateDecryptionKeys` (cryptographic material), `connectedDid`,
// `registrationTokens`, and `sessionRevocations`. A Web5 dApp that the
// previous wallet had connected to could be silently re-authorised
// under the new wallet's identity.
//
// The fix iterates `STORAGE_KEYS` from `@enbox/auth` and removes each
// key. The new `AUTH_RESET_PENDING_KEY` sentinel guards against
// crash-during-iteration leaks, and `runPendingAuthResetCleanup()`
// retries the iteration on the next agent-init.
describe('useAgentStore.reset() — wipes persisted AuthManager material (Round-12 F3)', () => {
  it('removes all 11 enbox:auth:* keys via SecureStorage on a successful reset', async () => {
    await useAgentStore.getState().initializeFirstLaunch();

    nativeSecure.deleteItem.mockClear();

    await useAgentStore.getState().reset();

    const deletedKeys = nativeSecure.deleteItem.mock.calls.map((c) => c[0]);
    // The 11 STORAGE_KEYS, each prefixed with 'enbox:' by
    // SecureStorageAdapter. The leading 'enbox:' is the adapter
    // prefix; the trailing 'enbox:auth:*' is the canonical key.
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        'enbox:enbox:auth:previouslyConnected',
        'enbox:enbox:auth:activeIdentity',
        'enbox:enbox:auth:delegateDid',
        'enbox:enbox:auth:connectedDid',
        'enbox:enbox:auth:delegateDecryptionKeys',
        'enbox:enbox:auth:delegateContextKeys',
        'enbox:enbox:auth:delegateMultiPartyProtocols',
        'enbox:enbox:auth:localDwnEndpoint',
        'enbox:enbox:auth:registrationTokens',
        'enbox:enbox:auth:sessionRevocations',
        'enbox:enbox:auth:revocationRetryContext',
      ]),
    );
  });

  it('persists AUTH_RESET_PENDING_KEY before iterating + clears it after success', async () => {
    await useAgentStore.getState().initializeFirstLaunch();

    nativeSecure.setItem.mockClear();
    nativeSecure.deleteItem.mockClear();

    await useAgentStore.getState().reset();

    const sentinelWrites = nativeSecure.setItem.mock.calls.filter(
      (c) => c[0] === 'enbox:enbox.auth.reset-pending',
    );
    expect(sentinelWrites.length).toBeGreaterThanOrEqual(1);
    expect(sentinelWrites[0][1]).toBe('true');

    const sentinelDeletes = nativeSecure.deleteItem.mock.calls.filter(
      (c) => c[0] === 'enbox:enbox.auth.reset-pending',
    );
    expect(sentinelDeletes.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps AUTH_RESET_PENDING_KEY set when an auth-storage remove fails (rethrow + retry path)', async () => {
    await useAgentStore.getState().initializeFirstLaunch();

    nativeSecure.deleteItem.mockClear();

    // Pass-through default delete behaviour; reject only the
    // `enbox:enbox:auth:delegateDecryptionKeys` remove. Every other
    // remove succeeds. We capture the failure and rethrow so the
    // caller knows the wipe was incomplete.
    nativeSecure.deleteItem.mockImplementation(async (key: string) => {
      if (key === 'enbox:enbox:auth:delegateDecryptionKeys') {
        throw new Error('Keychain entry locked');
      }
    });

    await expect(useAgentStore.getState().reset()).rejects.toThrow(
      /Keychain entry locked/,
    );

    // Sentinel was NOT cleared (failure path).
    const sentinelDeletes = nativeSecure.deleteItem.mock.calls.filter(
      (c) => c[0] === 'enbox:enbox.auth.reset-pending',
    );
    expect(sentinelDeletes.length).toBe(0);
  });

  it('runPendingAuthResetCleanup retries the iteration on a subsequent agent-init flow', async () => {
    const { runPendingAuthResetCleanup } = require('@/lib/enbox/agent-store');
    const removed: string[] = [];
    const sentinelStorage = {
      get: jest.fn(async () => 'true'),
      set: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
    };
    const authStorage = {
      remove: jest.fn(async (key: string) => {
        removed.push(key);
      }),
    };

    await expect(
      runPendingAuthResetCleanup(sentinelStorage, authStorage),
    ).resolves.toBe(true);

    // All 11 STORAGE_KEYS were removed.
    expect(removed).toEqual(
      expect.arrayContaining([
        'enbox:auth:previouslyConnected',
        'enbox:auth:activeIdentity',
        'enbox:auth:delegateDid',
        'enbox:auth:connectedDid',
        'enbox:auth:delegateDecryptionKeys',
        'enbox:auth:delegateContextKeys',
        'enbox:auth:delegateMultiPartyProtocols',
        'enbox:auth:localDwnEndpoint',
        'enbox:auth:registrationTokens',
        'enbox:auth:sessionRevocations',
        'enbox:auth:revocationRetryContext',
      ]),
    );
    expect(removed.length).toBe(11);
    // Sentinel cleared after success.
    expect(sentinelStorage.remove).toHaveBeenCalledWith(
      'enbox.auth.reset-pending',
    );
  });

  it('runPendingAuthResetCleanup is a no-op when sentinel absent', async () => {
    const { runPendingAuthResetCleanup } = require('@/lib/enbox/agent-store');
    const sentinelStorage = {
      get: jest.fn(async () => null),
      set: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
    };
    const authStorage = { remove: jest.fn(async () => undefined) };

    await expect(
      runPendingAuthResetCleanup(sentinelStorage, authStorage),
    ).resolves.toBe(true);
    expect(authStorage.remove).not.toHaveBeenCalled();
    expect(sentinelStorage.remove).not.toHaveBeenCalled();
  });

  it('runPendingAuthResetCleanup propagates SecureStorage.get failures (Round-10 F3 parity)', async () => {
    const { runPendingAuthResetCleanup } = require('@/lib/enbox/agent-store');
    const stubError = Object.assign(new Error('SecureStorage temporarily unavailable'), {
      code: 'SECURE_STORAGE_LOCKED',
    });
    const sentinelStorage = {
      get: jest.fn(async () => {
        throw stubError;
      }),
      set: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
    };
    const authStorage = { remove: jest.fn(async () => undefined) };

    await expect(
      runPendingAuthResetCleanup(sentinelStorage, authStorage),
    ).rejects.toThrow(/SecureStorage temporarily unavailable/);
    expect(authStorage.remove).not.toHaveBeenCalled();
  });
});
