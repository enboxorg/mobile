/**
 * Focused primitive tests for `useAgentStore.teardown()`.
 *
 * The auto-lock UX hook (Milestone 4, VAL-UX-035) will invoke
 * `teardown()` alongside `BiometricVault.lock()` when the app moves to
 * background. This suite pins the store-side primitive independently
 * of the UX hook wiring so the hook can be layered on with confidence.
 *
 * Contract pinned here:
 *
 *   - `teardown` is an exposed action on the zustand store.
 *   - `teardown()` clears `agent`, `authManager`, `recoveryPhrase`,
 *     `identities`, and (defensively) `vault` / `isInitializing` /
 *     `error` — everything that could hold post-unlock material or
 *     identity references.
 *   - `teardown()` is synchronous and idempotent — repeated calls are
 *     safe and leave the store in the same cleared state.
 *   - `teardown()` does NOT touch NativeBiometricVault (no
 *     `deleteSecret` — that's `reset()`, not `teardown()`). This is the
 *     critical distinction the auto-lock hook relies on: background
 *     events tear down memory but preserve the native secret so the
 *     next foreground requires a fresh biometric prompt.
 *
 * Cross-refs: VAL-VAULT-010 / VAL-VAULT-020 / VAL-VAULT-021.
 */

// ---------------------------------------------------------------------------
// Virtual mocks for ESM-only @enbox packages. Keep the surface small —
// we only need enough of `EnboxUserAgent` / `AuthManager` / DID factory
// for `initializeFirstLaunch()` / `unlockAgent()` to succeed so we can
// then observe `teardown()`'s effect on the populated state.
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

    const identityList = jest.fn(async () => [
      { metadata: { name: 'alice' }, did: { uri: 'did:dht:alice' } },
    ]);
    const firstLaunch = jest.fn(async () => true);
    const initialize = jest.fn(async () => 'teardown test recovery phrase');
    const start = jest.fn(async () => undefined);

    class EnboxUserAgent {
      public vault: unknown;
      public params: any;
      public identity: { list: jest.Mock; create: jest.Mock };
      public firstLaunch: jest.Mock = firstLaunch;
      public initialize: jest.Mock = initialize;
      public start: jest.Mock = start;
      // Mock the post-`start()` state: real `EnboxUserAgent` assigns
      // `agentDid` from `vault.getDid()` inside `start()`. The teardown
      // suite simulates a fully-booted agent so `refreshIdentities()`
      // (which now gates on `agentDid` being set to suppress the race
      // warning) still populates the store.
      public agentDid: { uri: string } = { uri: 'did:dht:teardown-test' };
      constructor(createParams: any) {
        this.params = createParams;
        this.vault = createParams?.agentVault;
        this.identity = { list: identityList, create: jest.fn() };
      }
      static create = jest.fn(
        async (params: any) => new EnboxUserAgent(params),
      );
    }

    // Minimal AgentCryptoApi stub — returns a placeholder JWK. Tests in
    // this file never exercise the derivation path that would use this.
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

// Silence expected console noise from the store during tests.
const consoleSpies: jest.SpyInstance[] = [];
beforeAll(() => {
  consoleSpies.push(jest.spyOn(console, 'log').mockImplementation(() => {}));
  consoleSpies.push(jest.spyOn(console, 'error').mockImplementation(() => {}));
  consoleSpies.push(jest.spyOn(console, 'warn').mockImplementation(() => {}));
});
afterAll(() => {
  for (const s of consoleSpies) s.mockRestore();
});

// ---------------------------------------------------------------------------
// Module under test — imported AFTER the virtual mocks are registered.
// ---------------------------------------------------------------------------
import NativeBiometricVault from '@specs/NativeBiometricVault';

import { useAgentStore } from '@/lib/enbox/agent-store';
import { BiometricVault } from '@/lib/enbox/biometric-vault';

const native = NativeBiometricVault as unknown as {
  hasSecret: jest.Mock;
  deleteSecret: jest.Mock;
};

function resetStore() {
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
  resetStore();
  (globalThis as any).__enboxMobilePatchedAgentDwnApi = false;
});

describe('useAgentStore.teardown() — primitive contract (auto-lock prerequisite)', () => {
  it('is exposed as a callable action on the store', () => {
    const fn = useAgentStore.getState().teardown;
    expect(typeof fn).toBe('function');
  });

  it('clears agent, authManager, recoveryPhrase, identities after first-launch init', async () => {
    const phrase = await useAgentStore.getState().initializeFirstLaunch();
    expect(phrase).toBe('teardown test recovery phrase');

    // Sanity: the store is fully populated pre-teardown.
    {
      const state = useAgentStore.getState();
      expect(state.agent).not.toBeNull();
      expect(state.authManager).not.toBeNull();
      expect(state.vault).toBeInstanceOf(BiometricVault);
      expect(state.recoveryPhrase).toBe(phrase);
    }

    // Populate identities via the store's refresh action to cover the
    // identities-cleared assertion explicitly.
    await useAgentStore.getState().refreshIdentities();
    expect(useAgentStore.getState().identities.length).toBeGreaterThan(0);

    // Teardown must be synchronous — no promise contract here.
    const teardownReturn = useAgentStore.getState().teardown();
    expect(teardownReturn).toBeUndefined();

    const cleared = useAgentStore.getState();
    expect(cleared.agent).toBeNull();
    expect(cleared.authManager).toBeNull();
    expect(cleared.recoveryPhrase).toBeNull();
    expect(cleared.identities).toEqual([]);
  });

  it('clears the vault reference and resets transient flags (isInitializing, error)', async () => {
    // Force a non-default populated state so we can observe teardown
    // resetting `isInitializing` and `error` as well.
    useAgentStore.setState({
      agent: { fake: 'agent' } as any,
      authManager: { fake: 'authManager' } as any,
      vault: new BiometricVault(),
      isInitializing: true,
      error: 'stale error that should be cleared',
      recoveryPhrase: 'stale phrase',
      identities: [
        { metadata: { name: 'stale' }, did: { uri: 'did:dht:stale' } } as any,
      ],
    });

    useAgentStore.getState().teardown();

    const cleared = useAgentStore.getState();
    expect(cleared.agent).toBeNull();
    expect(cleared.authManager).toBeNull();
    expect(cleared.vault).toBeNull();
    expect(cleared.isInitializing).toBe(false);
    expect(cleared.error).toBeNull();
    expect(cleared.recoveryPhrase).toBeNull();
    expect(cleared.identities).toEqual([]);
  });

  it('does NOT touch NativeBiometricVault — preserves the native secret for next unlock', async () => {
    await useAgentStore.getState().initializeFirstLaunch();

    // After init the native mock has a secret at the wallet-root alias.
    // Record the call counts BEFORE tearing down so we can assert no new
    // native module interactions happen during teardown.
    const hasSecretCallsBefore = native.hasSecret.mock.calls.length;
    const deleteCallsBefore = native.deleteSecret.mock.calls.length;

    useAgentStore.getState().teardown();

    expect(native.hasSecret.mock.calls.length).toBe(hasSecretCallsBefore);
    expect(native.deleteSecret.mock.calls.length).toBe(deleteCallsBefore);
  });

  it('is idempotent — repeated teardown() calls are safe and keep the store cleared', async () => {
    await useAgentStore.getState().initializeFirstLaunch();

    useAgentStore.getState().teardown();
    useAgentStore.getState().teardown();
    useAgentStore.getState().teardown();

    const state = useAgentStore.getState();
    expect(state.agent).toBeNull();
    expect(state.authManager).toBeNull();
    expect(state.vault).toBeNull();
    expect(state.recoveryPhrase).toBeNull();
    expect(state.identities).toEqual([]);
    expect(state.isInitializing).toBe(false);
    expect(state.error).toBeNull();
  });

  it('is safe when called on a never-populated store (no-op semantics)', () => {
    // Start already-empty (beforeEach).
    expect(() => useAgentStore.getState().teardown()).not.toThrow();
    const state = useAgentStore.getState();
    expect(state.agent).toBeNull();
    expect(state.authManager).toBeNull();
    expect(state.vault).toBeNull();
    expect(state.recoveryPhrase).toBeNull();
    expect(state.identities).toEqual([]);
  });
});
