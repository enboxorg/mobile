/**
 * Tests for the mobile agent-init wiring.
 *
 * Covers validation-contract assertions:
 *   - VAL-VAULT-016: agent-init constructs a `BiometricVault` and passes it
 *     as `agentVault` to `EnboxUserAgent.create`; no `HdIdentityVault`
 *     reference survives in the mobile wiring layer.
 *   - VAL-VAULT-019: the existing mobile monkey patch (the
 *     `AgentDwnApi.agent` setter that skips `LocalDwnDiscovery` when
 *     `localDwnStrategy === 'off'`) is still installed after adopting
 *     `BiometricVault`.
 *
 * `@enbox/agent`, `@enbox/auth`, `@enbox/dids`, and `@enbox/crypto` are
 * ESM-only packages that Jest cannot transform, so they are virtually
 * mocked here. jest.fn()s are created inside the factories and exposed
 * via the mocked modules so tests can drive them without tripping Jest's
 * factory hoisting rule.
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

// Import modules under test AFTER all mocks are registered.
import { initializeAgent, createBiometricVault } from '@/lib/enbox/agent-init';
import { BiometricVault } from '@/lib/enbox/biometric-vault';
 
const agentModule: any = require('@enbox/agent');
const { AgentDwnApi, LocalDwnDiscovery } = agentModule;
const mockAgentCreate = agentModule.EnboxUserAgent.create as jest.Mock;
const mockAgentFirstLaunch = agentModule.__mocks__.firstLaunch as jest.Mock;
const mockAgentInitialize = agentModule.__mocks__.initialize as jest.Mock;
const mockAgentStart = agentModule.__mocks__.start as jest.Mock;

const AGENT_INIT_PATH = resolve(__dirname, '../agent-init.ts');
const AGENT_STORE_PATH = resolve(__dirname, '../agent-store.ts');

beforeEach(() => {
  mockAgentCreate.mockClear();
  mockAgentFirstLaunch.mockReset().mockResolvedValue(true);
  mockAgentInitialize.mockReset().mockResolvedValue('stub recovery phrase');
  mockAgentStart.mockReset().mockResolvedValue(undefined);
  (globalThis as any).__enboxMobilePatchedAgentDwnApi = false;
});

// ---------------------------------------------------------------------------
// VAL-VAULT-016 — agent-init wires BiometricVault, not HdIdentityVault
// ---------------------------------------------------------------------------

describe('agent-init.ts — BiometricVault wiring (VAL-VAULT-016)', () => {
  it('constructs a BiometricVault and passes it as agentVault to EnboxUserAgent.create', async () => {
    const { agent, vault } = await initializeAgent();

    expect(mockAgentCreate).toHaveBeenCalledTimes(1);
    const createParams = mockAgentCreate.mock.calls[0][0];
    expect(createParams).toBeDefined();
    expect(createParams.agentVault).toBeInstanceOf(BiometricVault);
    expect(createParams.dataPath).toBe('ENBOX_AGENT');
    expect(createParams.localDwnStrategy).toBe('off');

    // The returned vault and agent.vault refer to the same BiometricVault.
    expect(vault).toBeInstanceOf(BiometricVault);
    expect(createParams.agentVault).toBe(vault);
    expect((agent as any).vault).toBe(vault);
  });

  it('createBiometricVault() returns a BiometricVault instance usable as agentVault', () => {
    const vault = createBiometricVault();
    expect(vault).toBeInstanceOf(BiometricVault);
    // Structural spot-checks against the IdentityVault interface.
    expect(typeof vault.initialize).toBe('function');
    expect(typeof vault.unlock).toBe('function');
    expect(typeof vault.lock).toBe('function');
    expect(typeof vault.isLocked).toBe('function');
    expect(typeof vault.isInitialized).toBe('function');
    expect(typeof vault.getDid).toBe('function');
    expect(typeof vault.getStatus).toBe('function');
  });

  it('source file does NOT import or reference HdIdentityVault', () => {
    const src = readFileSync(AGENT_INIT_PATH, 'utf8');
    expect(src).not.toMatch(/HdIdentityVault/);
  });

  it('agent-store source file does NOT import or reference HdIdentityVault', () => {
    const src = readFileSync(AGENT_STORE_PATH, 'utf8');
    expect(src).not.toMatch(/HdIdentityVault/);
  });
});

// ---------------------------------------------------------------------------
// VAL-VAULT-019 — existing AgentDwnApi monkey patch still applied
// ---------------------------------------------------------------------------

describe('agent-init.ts — preserves AgentDwnApi mobile monkey patch (VAL-VAULT-019)', () => {
  it('installs the patch flag on globalThis during initializeAgent()', async () => {
    expect((globalThis as any).__enboxMobilePatchedAgentDwnApi).toBe(false);
    await initializeAgent();
    expect((globalThis as any).__enboxMobilePatchedAgentDwnApi).toBe(true);
  });

  it('skips LocalDwnDiscovery construction when _localDwnStrategy === "off"', async () => {
    await initializeAgent();

    // Simulate the agent-wiring code doing `dwnApi.agent = fakeAgent` via
    // the patched setter.
    const instance = new AgentDwnApi();
    instance._localDwnStrategy = 'off';
    (instance as any).agent = { rpc: {} };

    expect(instance._agent).toEqual({ rpc: {} });
    expect(instance._localDwnDiscovery).toBeUndefined();
  });

  it('constructs LocalDwnDiscovery when _localDwnStrategy is not "off"', async () => {
    await initializeAgent();

    const instance = new AgentDwnApi();
    instance._localDwnStrategy = 'local';
    (instance as any).agent = { rpc: {} };

    expect(instance._localDwnDiscovery).toBeInstanceOf(LocalDwnDiscovery);
  });

  it('is idempotent across multiple initializeAgent() calls (flag stays true)', async () => {
    await initializeAgent();
    const flagBefore = (globalThis as any).__enboxMobilePatchedAgentDwnApi;
    await initializeAgent();
    const flagAfter = (globalThis as any).__enboxMobilePatchedAgentDwnApi;
    expect(flagBefore).toBe(true);
    expect(flagAfter).toBe(true);
  });
});
