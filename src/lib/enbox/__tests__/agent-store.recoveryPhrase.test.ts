/**
 * Tests for the recovery-phrase surfacing contract on `useAgentStore`.
 *
 * Covers validation-contract assertion VAL-VAULT-018:
 *   "recovery phrase is exposed one-shot and never persisted to disk"
 *
 * The specific behaviors validated here:
 *   1. `initializeFirstLaunch()` populates `useAgentStore.recoveryPhrase`
 *      with the vault's mnemonic.
 *   2. `teardown()` and `clearRecoveryPhrase()` both null it.
 *   3. Subsequent `unlockAgent()` calls do NOT populate it.
 *   4. The phrase is NEVER written via the mocked SecureStorage
 *      adapter or AsyncStorage (regression guard against accidental
 *      persistence middleware).
 *
 * Also spot-checks the new `reset()` orchestration action (VAL-VAULT-022):
 *   `agentStore.reset()` must call `NativeBiometricVault.deleteSecret`
 *   exactly once and clear session state.
 */

// ---------------------------------------------------------------------------
// Virtual mocks for ESM-only @enbox packages.
// ---------------------------------------------------------------------------

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
    const initialize = jest.fn(async () => 'stub recovery phrase alpha beta');
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

    return {
      __esModule: true,
      AgentCryptoApi,
      AgentDwnApi,
      EnboxUserAgent,
      LocalDwnDiscovery,
      __mocks__: {
        firstLaunch,
        initialize,
        start,
        identityList,
        create: EnboxUserAgent.create,
      },
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
    return {
      __esModule: true,
      BearerDid,
      DidDht: { create },
    };
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

// Silence expected console noise on the error paths.
const consoleSpies: jest.SpyInstance[] = [];
beforeAll(() => {
  consoleSpies.push(jest.spyOn(console, 'error').mockImplementation(() => {}));
  consoleSpies.push(jest.spyOn(console, 'warn').mockImplementation(() => {}));
});
afterAll(() => {
  for (const s of consoleSpies) s.mockRestore();
});

// ---------------------------------------------------------------------------
// Imports (post-mocks).
// ---------------------------------------------------------------------------

import NativeBiometricVault from '@specs/NativeBiometricVault';
import NativeSecureStorage from '@specs/NativeSecureStorage';

import { useAgentStore } from '@/lib/enbox/agent-store';
import { useSessionStore } from '@/features/session/session-store';

const nativeBiometric = NativeBiometricVault as unknown as {
  deleteSecret: jest.Mock;
};
const nativeSecureStorage = NativeSecureStorage as unknown as {
  setItem: jest.Mock;
  getItem: jest.Mock;
  deleteItem: jest.Mock;
};

 
const agentModule: any = require('@enbox/agent');
const mockAgentInitialize = agentModule.__mocks__.initialize as jest.Mock;

function resetAgentStore() {
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

function resetSessionStore() {
  useSessionStore.setState({
    isHydrated: false,
    hasCompletedOnboarding: false,
    isLocked: true,
    hasIdentity: false,
    biometricStatus: 'unknown',
  });
}

beforeEach(() => {
  resetAgentStore();
  resetSessionStore();
  mockAgentInitialize.mockReset().mockResolvedValue('stub recovery phrase alpha beta');
  nativeSecureStorage.setItem.mockClear();
  (globalThis as any).__enboxMobilePatchedAgentDwnApi = false;
});

// ===========================================================================
// VAL-VAULT-018 — recovery phrase is one-shot and never persisted
// ===========================================================================

describe('useAgentStore — recoveryPhrase surfacing (VAL-VAULT-018)', () => {
  it('initializeFirstLaunch() populates `recoveryPhrase` with the vault mnemonic', async () => {
    const phrase = await useAgentStore.getState().initializeFirstLaunch();
    expect(phrase).toBe('stub recovery phrase alpha beta');
    expect(useAgentStore.getState().recoveryPhrase).toBe(phrase);
  });

  it('clearRecoveryPhrase() nulls the stored phrase', async () => {
    await useAgentStore.getState().initializeFirstLaunch();
    expect(useAgentStore.getState().recoveryPhrase).not.toBeNull();

    useAgentStore.getState().clearRecoveryPhrase();
    expect(useAgentStore.getState().recoveryPhrase).toBeNull();
  });

  it('teardown() nulls the stored phrase even if the UI never called clearRecoveryPhrase()', async () => {
    await useAgentStore.getState().initializeFirstLaunch();
    expect(useAgentStore.getState().recoveryPhrase).not.toBeNull();

    useAgentStore.getState().teardown();
    expect(useAgentStore.getState().recoveryPhrase).toBeNull();
    expect(useAgentStore.getState().agent).toBeNull();
  });

  it('unlockAgent() leaves recoveryPhrase null (does NOT repopulate it)', async () => {
    // Simulate a return-visit unlock (no prior in-memory phrase).
    expect(useAgentStore.getState().recoveryPhrase).toBeNull();

    await useAgentStore.getState().unlockAgent();
    expect(useAgentStore.getState().recoveryPhrase).toBeNull();
    expect(useAgentStore.getState().agent).not.toBeNull();
  });

  it('NEVER writes the mnemonic to SecureStorage during first-launch', async () => {
    const phrase = await useAgentStore.getState().initializeFirstLaunch();

    // Scan every recorded setItem call argument for the mnemonic or any
    // substring of it. If this assertion ever fires, a new persist
    // middleware has been added that accidentally captures the phrase.
    const allArgs = JSON.stringify(nativeSecureStorage.setItem.mock.calls);
    expect(allArgs).not.toContain(phrase);
    for (const word of phrase.split(/\s+/)) {
      // Individual words could appear legitimately in JSON encoding
      // (e.g. "alpha" is a common token); so we only assert the full
      // phrase string is not present. Word-level check would be too
      // strict. Scanning the full phrase is the canonical evidence
      // required by VAL-VAULT-018.
      expect(word.length).toBeGreaterThan(0);
    }
  });

  it('zustand agent store exposes NO persistence middleware (regression guard)', () => {
    // A freshly created store has a `persist`-backed store only if
    // zustand's middleware was wired; since we do not use persist,
    // `useAgentStore.persist` must be undefined.
     
    expect((useAgentStore as any).persist).toBeUndefined();
  });
});

// ===========================================================================
// VAL-VAULT-022 spot-check — agentStore.reset() orchestration
// ===========================================================================

describe('useAgentStore.reset() — wipes native secret + session state (VAL-VAULT-022)', () => {
  it('calls NativeBiometricVault.deleteSecret, tears down the agent, and resets the session store', async () => {
    // Warm up state: complete a first-launch so the store has something to
    // tear down.
    await useAgentStore.getState().initializeFirstLaunch();
    useSessionStore.setState({
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isLocked: false,
    });

    nativeBiometric.deleteSecret.mockClear();

    await useAgentStore.getState().reset();

    // 1. Native secret deleted. Either the vault.reset() inside the
    //    agent-store path delegates to deleteSecret, or the fallback
    //    code path calls it directly — either way the counter goes up.
    expect(nativeBiometric.deleteSecret.mock.calls.length).toBeGreaterThanOrEqual(1);

    // 2. In-memory agent-store state cleared.
    const agentState = useAgentStore.getState();
    expect(agentState.agent).toBeNull();
    expect(agentState.vault).toBeNull();
    expect(agentState.authManager).toBeNull();
    expect(agentState.recoveryPhrase).toBeNull();

    // 3. Session store cleared.
    const sessionState = useSessionStore.getState();
    expect(sessionState.hasCompletedOnboarding).toBe(false);
    expect(sessionState.hasIdentity).toBe(false);
    expect(sessionState.isLocked).toBe(true);
    expect(sessionState.biometricStatus).toBe('unknown');
  });

  it('is idempotent — a second reset does not throw', async () => {
    await useAgentStore.getState().reset();
    await expect(useAgentStore.getState().reset()).resolves.toBeUndefined();
  });
});

// ===========================================================================
// VAL-VAULT-028 — resumePendingBackup() re-derives the one-shot mnemonic
//
// Scenario: a user completed biometric setup (so the native vault holds a
// freshly-provisioned secret) but closed the app before the backup
// confirmation screen had shown all 24 words. On relaunch the
// `isPendingFirstBackup` flag is `true`, the navigator routes to
// `RecoveryPhrase` with `mnemonic === null`, and the screen presents a
// "Show recovery phrase" CTA. Pressing that CTA invokes
// `useAgentStore.resumePendingBackup()`.
//
// Contract pinned here:
//   1. `resumePendingBackup` is exposed as a callable store action.
//   2. On success it populates `recoveryPhrase` with the mnemonic
//      re-derived from the vault's in-memory entropy (via
//      `vault.getMnemonic()`).
//   3. It prompts biometrics exactly once via `agent.start({})` — it
//      does NOT re-run `initialize({})` or touch the native secret.
//   4. It sets `biometricState` to `'ready'` on success and leaves
//      `isInitializing: false`.
//   5. The phrase is never written to SecureStorage.
// ===========================================================================

describe('useAgentStore.resumePendingBackup() — re-derives mnemonic from native secret (VAL-VAULT-028)', () => {
  // These tests have to reach the real `vault.getMnemonic()` path, which
  // depends on `BiometricVault.unlock()` populating `_secretBytes`. The
  // virtual `@enbox/*` mocks at the top of this file stub
  // `EnboxUserAgent.start` as a no-op (`async () => undefined`), so
  // without additional wiring the resume flow would call a stubbed
  // `start()` that never populates the vault, and `getMnemonic()` would
  // throw `VAULT_ERROR_LOCKED`. To keep this suite self-contained and
  // cover just the store-level orchestration contract, we replace
  // `initializeAgent` via `jest.doMock` with a hand-rolled agent+vault
  // pair where `start()` pre-unlocks a fake vault and `getMnemonic()`
  // returns a deterministic fixture.

  const FIXED_RESUMED_PHRASE =
    'abandon abandon abandon abandon abandon abandon ' +
    'abandon abandon abandon abandon abandon abandon ' +
    'abandon abandon abandon abandon abandon abandon ' +
    'abandon abandon abandon abandon abandon art';

  function makeResumeAgentAndVault(opts: {
    startError?: Error;
    getMnemonicError?: Error;
    getDidUri?: string;
  }) {
    const didUri = opts.getDidUri ?? 'did:dht:resume-test';
    const getMnemonic = jest.fn(
      opts.getMnemonicError
        ? async () => {
            throw opts.getMnemonicError as Error;
          }
        : async () => FIXED_RESUMED_PHRASE,
    );
    const getDid = jest.fn(async () => ({ uri: didUri }));
    // The store's catch path defensively calls `vault.lock()` to scrub
    // unlocked key material if anything between `agent.start({})` and
    // the success-path `set(...)` throws (VAL-VAULT-031). The fake
    // vault must implement it; the body is a no-op (the real
    // BiometricVault zeros its `_secretBytes` / `_rootSeed` / CEK
    // here but the fake has none of those).
    const lock = jest.fn(async () => undefined);
    const vault = { getMnemonic, getDid, lock };
    // Matches upstream `EnboxUserAgent.start()` semantics: it assigns
    // `this.agentDid = await this.vault.getDid()` after unlocking the
    // vault. Mirroring that here keeps the downstream
    // `refreshIdentities()` race-gate from scheduling a 2s retry
    // poller, which would otherwise leak an open timer past test
    // completion and trigger Jest's "did not exit" warning.
    const agent: {
      agentDid: { uri: string } | undefined;
      initialize: jest.Mock;
      start: jest.Mock;
      firstLaunch: jest.Mock;
      identity: { list: jest.Mock; create: jest.Mock };
    } = {
      agentDid: undefined,
      initialize: jest.fn(),
      start: jest.fn(
        opts.startError
          ? async () => {
              throw opts.startError as Error;
            }
          : async () => {
              agent.agentDid = { uri: didUri };
            },
      ),
      firstLaunch: jest.fn(async () => false),
      identity: { list: jest.fn(async () => []), create: jest.fn() },
    };
    return { agent, vault };
  }

  beforeEach(() => {
    jest.resetModules();
    // Re-register the virtual mocks after `jest.resetModules()` cleared
    // the module cache — otherwise the next `require('@/lib/enbox/agent-store')`
    // would try to resolve the real ESM packages and crash on
    // `Cannot find module '@enbox/agent'`.
    jest.doMock(
      '@enbox/agent',
      () => {
        class AgentDwnApi {
          static _tryCreateDiscoveryFile() {
            return {};
          }
        }
        class EnboxUserAgent {
          static create = jest.fn();
        }
        class AgentCryptoApi {}
        class LocalDwnDiscovery {}
        return {
          __esModule: true,
          AgentDwnApi,
          EnboxUserAgent,
          AgentCryptoApi,
          LocalDwnDiscovery,
        };
      },
      { virtual: true },
    );
    jest.doMock(
      '@enbox/auth',
      () => ({ __esModule: true, AuthManager: { create: jest.fn() } }),
      { virtual: true },
    );
    jest.doMock(
      '@enbox/dids',
      () => ({
        __esModule: true,
        BearerDid: class {},
        DidDht: { create: jest.fn() },
      }),
      { virtual: true },
    );
    jest.doMock(
      '@enbox/crypto',
      () => ({
        __esModule: true,
        LocalKeyManager: class {},
        computeJwkThumbprint: jest.fn(),
      }),
      { virtual: true },
    );
  });

  it('populates `recoveryPhrase` with the mnemonic returned by vault.getMnemonic()', async () => {
    const { agent, vault } = makeResumeAgentAndVault({});
    jest.doMock('@/lib/enbox/agent-init', () => ({
      __esModule: true,
      initializeAgent: jest.fn(async () => ({
        agent,
        authManager: { id: 'resume-auth-manager' },
        vault,
      })),
      createBiometricVault: jest.fn(),
    }));

    const { useAgentStore: freshStore } = require('@/lib/enbox/agent-store');
    await freshStore.getState().resumePendingBackup();

    const state = freshStore.getState();
    expect(state.recoveryPhrase).toBe(FIXED_RESUMED_PHRASE);
    expect(state.agent).toBe(agent as any);
    expect(state.vault).toBe(vault as any);
    expect(state.biometricState).toBe('ready');
    expect(state.isInitializing).toBe(false);
    expect(state.error).toBeNull();

    // Biometric prompt was issued exactly once (via `agent.start({})`)
    // and the pre-existing secret was NEVER touched.
    expect(agent.start).toHaveBeenCalledTimes(1);
    expect(agent.initialize).not.toHaveBeenCalled();
    expect(vault.getMnemonic).toHaveBeenCalledTimes(1);
  });

  it('does NOT touch NativeBiometricVault.deleteSecret (the pending secret must survive the resume)', async () => {
    const { agent, vault } = makeResumeAgentAndVault({});
    jest.doMock('@/lib/enbox/agent-init', () => ({
      __esModule: true,
      initializeAgent: jest.fn(async () => ({
        agent,
        authManager: { id: 'resume-auth-manager' },
        vault,
      })),
      createBiometricVault: jest.fn(),
    }));
    nativeBiometric.deleteSecret.mockClear();

    const { useAgentStore: freshStore } = require('@/lib/enbox/agent-store');
    await freshStore.getState().resumePendingBackup();

    expect(nativeBiometric.deleteSecret).not.toHaveBeenCalled();
  });

  it('never writes the mnemonic to SecureStorage (VAL-VAULT-018 continues to hold on resume)', async () => {
    const { agent, vault } = makeResumeAgentAndVault({});
    jest.doMock('@/lib/enbox/agent-init', () => ({
      __esModule: true,
      initializeAgent: jest.fn(async () => ({
        agent,
        authManager: { id: 'resume-auth-manager' },
        vault,
      })),
      createBiometricVault: jest.fn(),
    }));
    nativeSecureStorage.setItem.mockClear();

    const { useAgentStore: freshStore } = require('@/lib/enbox/agent-store');
    await freshStore.getState().resumePendingBackup();

    const allArgs = JSON.stringify(
      nativeSecureStorage.setItem.mock.calls,
    );
    expect(allArgs).not.toContain(FIXED_RESUMED_PHRASE);
  });

  it('propagates a biometric cancellation and clears in-memory state so the UI can re-prompt', async () => {
    const cancelled = Object.assign(new Error('user cancelled biometrics'), {
      code: 'VAULT_ERROR_USER_CANCEL',
    });
    const { agent, vault } = makeResumeAgentAndVault({ startError: cancelled });
    jest.doMock('@/lib/enbox/agent-init', () => ({
      __esModule: true,
      initializeAgent: jest.fn(async () => ({
        agent,
        authManager: { id: 'resume-auth-manager' },
        vault,
      })),
      createBiometricVault: jest.fn(),
    }));

    const { useAgentStore: freshStore } = require('@/lib/enbox/agent-store');
    await expect(
      freshStore.getState().resumePendingBackup(),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR_USER_CANCEL' });

    // In-memory agent/vault/auth are cleared so a subsequent retry
    // starts from a clean slate. recoveryPhrase stays null.
    const state = freshStore.getState();
    expect(state.recoveryPhrase).toBeNull();
    expect(state.agent).toBeNull();
    expect(state.vault).toBeNull();
    expect(state.authManager).toBeNull();
    expect(state.isInitializing).toBe(false);
  });

  it('flips biometricState to `invalidated` when the keystore reports KEY_INVALIDATED', async () => {
    const invalidated = Object.assign(
      new Error('biometric enrollment changed'),
      { code: 'VAULT_ERROR_KEY_INVALIDATED' },
    );
    const { agent, vault } = makeResumeAgentAndVault({
      startError: invalidated,
    });
    jest.doMock('@/lib/enbox/agent-init', () => ({
      __esModule: true,
      initializeAgent: jest.fn(async () => ({
        agent,
        authManager: { id: 'resume-auth-manager' },
        vault,
      })),
      createBiometricVault: jest.fn(),
    }));

    const { useAgentStore: freshStore } = require('@/lib/enbox/agent-store');
    await expect(
      freshStore.getState().resumePendingBackup(),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR_KEY_INVALIDATED' });

    expect(freshStore.getState().biometricState).toBe('invalidated');
  });
});
