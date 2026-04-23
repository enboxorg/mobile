/**
 * Tests for the mobile agent-store wiring.
 *
 * Covers validation-contract assertions:
 *   - VAL-VAULT-014: initializeFirstLaunch() takes no args, wires the
 *     biometric vault into EnboxUserAgent.create, returns the recovery
 *     phrase (and stashes it on the store).
 *   - VAL-VAULT-015: unlockAgent() takes no args, calls agent.start() and
 *     leaves the agent live with no recoveryPhrase populated.
 *   - VAL-VAULT-016: no HdIdentityVault import in agent-init/agent-store.
 *   - VAL-VAULT-017: BIOMETRICS_UNAVAILABLE propagates with .code intact,
 *     `error` is a non-empty string, and `agent` stays null.
 *
 * The ESM-only `@enbox/*` packages are virtually mocked with jest.fn()s
 * owned by the factory itself and exposed via an `__mocks__` object so
 * tests can drive them without tripping Jest's factory hoisting rule.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
    const initialize = jest.fn(async () => 'stub recovery phrase');
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

// Silence expected `console.error` / `console.warn` calls that the store
// emits on failure paths so the test output stays focused.
const consoleSpies: jest.SpyInstance[] = [];
beforeAll(() => {
  consoleSpies.push(jest.spyOn(console, 'error').mockImplementation(() => {}));
  consoleSpies.push(jest.spyOn(console, 'warn').mockImplementation(() => {}));
});
afterAll(() => {
  for (const s of consoleSpies) s.mockRestore();
});

// ---------------------------------------------------------------------------
// Import modules under test AFTER mocks are registered.
// ---------------------------------------------------------------------------
import { useAgentStore } from '@/lib/enbox/agent-store';
import { BiometricVault } from '@/lib/enbox/biometric-vault';
 
const agentModule: any = require('@enbox/agent');
const mockAgentCreate = agentModule.EnboxUserAgent.create as jest.Mock;
const mockAgentFirstLaunch = agentModule.__mocks__.firstLaunch as jest.Mock;
const mockAgentInitialize = agentModule.__mocks__.initialize as jest.Mock;
const mockAgentStart = agentModule.__mocks__.start as jest.Mock;
const mockIdentityList = agentModule.__mocks__.identityList as jest.Mock;

const AGENT_STORE_PATH = resolve(__dirname, '../agent-store.ts');

function resetStore() {
  useAgentStore.setState({
    agent: null,
    authManager: null,
    vault: null,
    isInitializing: false,
    error: null,
    recoveryPhrase: null,
    identities: [],
  });
}

beforeEach(() => {
  resetStore();
  mockAgentCreate.mockClear();
  mockAgentFirstLaunch.mockReset().mockResolvedValue(true);
  mockAgentInitialize.mockReset().mockResolvedValue('stub recovery phrase');
  mockAgentStart.mockReset().mockResolvedValue(undefined);
  mockIdentityList.mockReset().mockResolvedValue([]);
  (globalThis as any).__enboxMobilePatchedAgentDwnApi = false;
});

// ---------------------------------------------------------------------------
// VAL-VAULT-014 — initializeFirstLaunch() takes no args + wires BiometricVault
// ---------------------------------------------------------------------------

describe('agent-store.initializeFirstLaunch() — VAL-VAULT-014', () => {
  it('accepts zero arguments and returns the agent recovery phrase', async () => {
    // Compile-time: the action's signature is `() => Promise<string>`.
    const fn: () => Promise<string> =
      useAgentStore.getState().initializeFirstLaunch;
    expect(typeof fn).toBe('function');

    const phrase = await fn();
    expect(typeof phrase).toBe('string');
    expect(phrase).toBe('stub recovery phrase');

    const state = useAgentStore.getState();
    expect(state.recoveryPhrase).toBe(phrase);
    expect(state.agent).not.toBeNull();
    expect(state.vault).toBeInstanceOf(BiometricVault);
    expect(state.isInitializing).toBe(false);
    expect(state.error).toBeNull();
  });

  it('wires the BiometricVault into EnboxUserAgent.create as agentVault', async () => {
    await useAgentStore.getState().initializeFirstLaunch();

    expect(mockAgentCreate).toHaveBeenCalledTimes(1);
    const params = mockAgentCreate.mock.calls[0][0];
    expect(params.agentVault).toBeInstanceOf(BiometricVault);
    expect(params.dataPath).toBe('ENBOX_AGENT');
    expect(params.localDwnStrategy).toBe('off');
  });

  it('calls agent.initialize WITHOUT a password key at all (scrutiny blocker 2)', async () => {
    await useAgentStore.getState().initializeFirstLaunch();

    expect(mockAgentInitialize).toHaveBeenCalledTimes(1);
    const params = mockAgentInitialize.mock.calls[0][0];
    // The mobile vault does not take a password. The store must NOT
    // include a `password` property at all (stronger than the earlier
    // "empty string" shape) so the downstream biometric-only contract
    // is preserved.
    expect(params).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(params, 'password')).toBe(false);
    // Defensive guard in case a future refactor sets password=undefined.
    expect((params as Record<string, unknown>).password).toBeUndefined();
  });

  it('returns empty string and calls agent.start when firstLaunch is false', async () => {
    mockAgentFirstLaunch.mockResolvedValue(false);

    const phrase = await useAgentStore.getState().initializeFirstLaunch();
    expect(phrase).toBe('');
    expect(mockAgentStart).toHaveBeenCalledTimes(1);
    expect(mockAgentInitialize).not.toHaveBeenCalled();
  });

  it('preserves the AgentDwnApi monkey patch after running', async () => {
    expect((globalThis as any).__enboxMobilePatchedAgentDwnApi).toBe(false);
    await useAgentStore.getState().initializeFirstLaunch();
    expect((globalThis as any).__enboxMobilePatchedAgentDwnApi).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-VAULT-015 — unlockAgent() takes no args and delegates to the vault
// ---------------------------------------------------------------------------

describe('agent-store.unlockAgent() — VAL-VAULT-015', () => {
  it('accepts zero arguments and leaves the agent live without populating recoveryPhrase', async () => {
    const fn: () => Promise<void> = useAgentStore.getState().unlockAgent;
    expect(typeof fn).toBe('function');

    await fn();

    const state = useAgentStore.getState();
    expect(state.agent).not.toBeNull();
    expect(state.vault).toBeInstanceOf(BiometricVault);
    expect(state.recoveryPhrase).toBeNull();
    expect(state.isInitializing).toBe(false);
    expect(state.error).toBeNull();
  });

  it('calls agent.start WITHOUT a password key at all (scrutiny blocker 2)', async () => {
    await useAgentStore.getState().unlockAgent();

    expect(mockAgentStart).toHaveBeenCalledTimes(1);
    const params = mockAgentStart.mock.calls[0][0];
    expect(params).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(params, 'password')).toBe(false);
    expect((params as Record<string, unknown>).password).toBeUndefined();
  });

  it('passes the BiometricVault instance as agentVault to EnboxUserAgent.create', async () => {
    await useAgentStore.getState().unlockAgent();

    expect(mockAgentCreate).toHaveBeenCalledTimes(1);
    const params = mockAgentCreate.mock.calls[0][0];
    expect(params.agentVault).toBeInstanceOf(BiometricVault);
  });
});

// ---------------------------------------------------------------------------
// VAL-VAULT-016 — regression guard: no HdIdentityVault in store source
// ---------------------------------------------------------------------------

describe('agent-store.ts — no HdIdentityVault reference (VAL-VAULT-016)', () => {
  it('source file does not import or reference HdIdentityVault', () => {
    const src = readFileSync(AGENT_STORE_PATH, 'utf8');
    expect(src).not.toMatch(/HdIdentityVault/);
  });
});

// ---------------------------------------------------------------------------
// VAL-VAULT-017 — BIOMETRICS_UNAVAILABLE propagates cleanly
// ---------------------------------------------------------------------------

describe('agent-store.initializeFirstLaunch() — biometrics unavailable (VAL-VAULT-017)', () => {
  it('propagates VAULT_ERROR_BIOMETRICS_UNAVAILABLE with .code intact', async () => {
    const err: Error & { code: string } = Object.assign(
      new Error('Biometrics are not available on this device'),
      { code: 'VAULT_ERROR_BIOMETRICS_UNAVAILABLE' },
    );
    mockAgentInitialize.mockImplementationOnce(async () => {
      throw err;
    });

    await expect(
      useAgentStore.getState().initializeFirstLaunch(),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR_BIOMETRICS_UNAVAILABLE' });

    const state = useAgentStore.getState();
    expect(state.error).toEqual(expect.any(String));
    expect(state.error).not.toBeNull();
    expect((state.error ?? '').length).toBeGreaterThan(0);
    expect(state.isInitializing).toBe(false);
    expect(state.agent).toBeNull();
    expect(state.vault).toBeNull();
  });

  it('propagates biometrics-unavailable from unlockAgent() too, leaving agent=null', async () => {
    const err: Error & { code: string } = Object.assign(
      new Error('Biometrics are not available on this device'),
      { code: 'VAULT_ERROR_BIOMETRICS_UNAVAILABLE' },
    );
    mockAgentStart.mockImplementationOnce(async () => {
      throw err;
    });

    await expect(
      useAgentStore.getState().unlockAgent(),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR_BIOMETRICS_UNAVAILABLE' });

    const state = useAgentStore.getState();
    expect(state.error).toEqual(expect.any(String));
    expect((state.error ?? '').length).toBeGreaterThan(0);
    expect(state.isInitializing).toBe(false);
    expect(state.agent).toBeNull();
    expect(state.vault).toBeNull();
  });

  it('clearError() resets the recoverable error state', async () => {
    const err = Object.assign(new Error('biometrics unavailable'), {
      code: 'VAULT_ERROR_BIOMETRICS_UNAVAILABLE',
    });
    mockAgentInitialize.mockImplementationOnce(async () => {
      throw err;
    });
    await expect(
      useAgentStore.getState().initializeFirstLaunch(),
    ).rejects.toBeDefined();
    expect(useAgentStore.getState().error).not.toBeNull();

    useAgentStore.getState().clearError();
    expect(useAgentStore.getState().error).toBeNull();
  });
});
