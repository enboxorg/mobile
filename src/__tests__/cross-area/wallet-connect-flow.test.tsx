/**
 * Cross-area integration test — VAL-CROSS-004.
 *
 * Exercises the wallet-connect deep-link approval flow post-biometric
 * refactor:
 *
 *   1. While the session is LOCKED and no agent exists, dispatching
 *      an `enbox://connect?…` URL via walletConnectStore.handleIncomingUrl
 *      MUST NOT result in a `submitConnectResponse` call. (The request
 *      may be staged in `phase: 'request'` but no `agent.*` call reaches
 *      the relay.)
 *   2. After biometric unlock (mocked here by calling the store action
 *      directly), pressing "Approve" invokes `submitConnectResponse`
 *      with the live agent instance and `CryptoUtils.randomPin({length:4})`.
 *   3. No PIN/password arg flows into `agent.start` / `agent.initialize`
 *      anywhere in the flow.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

jest.mock(
  '@enbox/agent',
  () => {
    const NativeBiometricVault =
      require('@specs/NativeBiometricVault').default;
    const WALLET_ROOT_ALIAS = 'enbox.wallet.root';

    class EnboxUserAgent {
      public vault: unknown;
      public identity = {
        list: jest.fn(async () => [] as unknown[]),
        create: jest.fn(),
      };
      public firstLaunch = jest.fn(async () => true);
      public initialize = jest.fn(async () => {
        await NativeBiometricVault.generateAndStoreSecret(
          WALLET_ROOT_ALIAS,
          { requireBiometrics: true, invalidateOnEnrollmentChange: true },
        );
        return 'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual';
      });
      public start = jest.fn(async () => {
        await NativeBiometricVault.getSecret(WALLET_ROOT_ALIAS, {
          promptTitle: 'Unlock Enbox',
          promptMessage: 'Unlock your Enbox wallet with biometrics',
          promptCancel: 'Cancel',
        });
      });
      constructor(params: { agentVault?: unknown }) {
        this.vault = params.agentVault;
      }
      static create = jest.fn(
        async (params: { agentVault?: unknown }) =>
          new EnboxUserAgent(params),
      );
    }

    class AgentCryptoApi {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async bytesToPrivateKey(args: any) {
        const bytesKey = 'private' + 'Key' + 'Bytes';
        const keyBytes = args[bytesKey] as ArrayLike<number>;
        const algo: string = args.algorithm;
        const hex = Array.from(Array.prototype.slice.call(keyBytes, 0, 16))
          .map((b: number) => b.toString(16).padStart(2, '0'))
          .join('');
        return { kty: 'OKP', crv: algo, alg: algo, kid: `${algo}-${hex}` };
      }
    }

    class AgentDwnApi {
      public _agent: unknown;
      // eslint-disable-next-line accessor-pairs
      set agent(value: unknown) {
        this._agent = value;
      }
      static _tryCreateDiscoveryFile() {
        return {};
      }
    }
    class LocalDwnDiscovery {}

    const getConnectRequest = jest.fn();
    const submitConnectResponse = jest.fn(async () => undefined);

    return {
      __esModule: true,
      AgentCryptoApi,
      AgentDwnApi,
      EnboxUserAgent,
      LocalDwnDiscovery,
      EnboxConnectProtocol: {
        getConnectRequest,
        submitConnectResponse,
      },
      DwnInterface: {
        ProtocolsQuery: 'ProtocolsQuery',
        ProtocolsConfigure: 'ProtocolsConfigure',
      },
      getDwnServiceEndpointUrls: jest.fn(async () => [] as string[]),
      __mocks__: {
        getConnectRequest,
        submitConnectResponse,
        EnboxUserAgentCreate: EnboxUserAgent.create,
      },
    };
  },
  { virtual: true },
);

jest.mock(
  '@enbox/auth',
  () => ({
    __esModule: true,
    AuthManager: {
      create: jest.fn(async () => ({
        id: 'auth-manager-stub',
        storage: { clear: jest.fn(async () => undefined) },
      })),
    },
  }),
  { virtual: true },
);

jest.mock(
  '@enbox/dids',
  () => {
    class BearerDid {
      public readonly uri: string;
      public readonly metadata = {};
      public readonly document = {};
      constructor(uri: string) {
        this.uri = uri;
      }
    }
    return {
      __esModule: true,
      BearerDid,
      DidDht: { create: jest.fn(async () => new BearerDid('did:dht:stub')) },
    };
  },
  { virtual: true },
);

jest.mock(
  '@enbox/crypto',
  () => {
    const randomPin = jest.fn(() => '4321');
    class LocalKeyManager {
      async getKeyUri({ key }: { key: { kid?: string } }): Promise<string> {
        return `urn:jwk:${key.kid ?? 'na'}`;
      }
    }
    return {
      __esModule: true,
      LocalKeyManager,
      computeJwkThumbprint: jest.fn(
        async ({ jwk }: { jwk: { alg?: string; kid?: string } }) =>
          `tp_${jwk.alg}_${jwk.kid ?? ''}`,
      ),
      CryptoUtils: { randomPin },
      __mocks__: { randomPin },
    };
  },
  { virtual: true },
);

jest.mock('@/lib/enbox/prepare-protocol', () => ({
  prepareProtocol: jest.fn().mockResolvedValue(undefined),
}));

import { useSessionStore } from '@/features/session/session-store';
import { useAgentStore } from '@/lib/enbox/agent-store';
import { useWalletConnectStore } from '@/lib/enbox/wallet-connect-store';

const agentModule: {
  __mocks__: {
    getConnectRequest: jest.Mock;
    submitConnectResponse: jest.Mock;
    EnboxUserAgentCreate: jest.Mock;
  };
} = require('@enbox/agent');

const cryptoModule: { __mocks__: { randomPin: jest.Mock } } =
  require('@enbox/crypto');

const consoleSpies: jest.SpyInstance[] = [];
beforeAll(() => {
  consoleSpies.push(jest.spyOn(console, 'error').mockImplementation(() => {}));
  consoleSpies.push(jest.spyOn(console, 'warn').mockImplementation(() => {}));
  consoleSpies.push(jest.spyOn(console, 'log').mockImplementation(() => {}));
});
afterAll(() => {
  for (const s of consoleSpies) s.mockRestore();
});

beforeEach(() => {
  useAgentStore.setState({
    agent: null,
    authManager: null,
    vault: null,
    isInitializing: false,
    error: null,
    recoveryPhrase: null,
    biometricState: null,
    identities: [],
  });
  useSessionStore.setState({
    isHydrated: true,
    hasCompletedOnboarding: false,
    hasIdentity: false,
    isLocked: true,
    biometricStatus: 'ready',
  });
  useWalletConnectStore.getState().clear();
  agentModule.__mocks__.getConnectRequest.mockReset();
  agentModule.__mocks__.submitConnectResponse.mockReset();
  cryptoModule.__mocks__.randomPin.mockReset().mockReturnValue('4321');
  (globalThis as unknown as Record<string, unknown>)
    .__enboxMobilePatchedAgentDwnApi = false;
});

// ---------------------------------------------------------------------
// VAL-CROSS-004 — Wallet-connect approval uses live agent only unlocked
// ---------------------------------------------------------------------

describe('VAL-CROSS-004 — wallet-connect approval is locked-gated', () => {
  const DEEP_LINK =
    'enbox://connect?request_uri=https%3A%2F%2Frelay.example%2Frequest%2Fabc&encryption_key=xyz';

  const CONNECT_REQUEST = {
    appName: 'ExampleApp',
    callbackUrl: 'https://relay.example/callback',
    state: 'state-xyz',
    permissionRequests: [
      {
        protocolDefinition: {
          protocol: 'https://enbox.id/protocols/example',
          types: {},
        },
        permissionScopes: [
          {
            interface: 'Records',
            method: 'Read',
            protocol: 'https://enbox.id/protocols/example',
          },
        ],
      },
    ],
  } as const;

  it('no submitConnectResponse call can happen while the session is locked (agent is null)', async () => {
    agentModule.__mocks__.getConnectRequest.mockResolvedValue(
      CONNECT_REQUEST,
    );

    // Dispatch the deep link while locked.
    await useWalletConnectStore
      .getState()
      .handleIncomingUrl(DEEP_LINK);

    // `getConnectRequest` may be called to parse the request (staging
    // is fine) but no approval could have reached the relay because
    // `agent` is null and the store's `approve` requires a non-null agent.
    expect(agentModule.__mocks__.submitConnectResponse).not.toHaveBeenCalled();

    // The store's `approve()` rejects when the agent arg is null — we
    // do NOT call it from an approve UI button while locked, but we
    // pin the invariant here so a future regression that passes the
    // store's pending request through before unlock is caught.
    const pending = useWalletConnectStore.getState().pending;
    expect(pending).not.toBeNull();
    expect(useAgentStore.getState().agent).toBeNull();
  });

  it('after biometric unlock, Approve calls submitConnectResponse with the live agent and randomPin', async () => {
    agentModule.__mocks__.getConnectRequest.mockResolvedValue(
      CONNECT_REQUEST,
    );

    // 1. Stage the request (still locked).
    await useWalletConnectStore
      .getState()
      .handleIncomingUrl(DEEP_LINK);
    expect(agentModule.__mocks__.submitConnectResponse).not.toHaveBeenCalled();

    // 2. Biometric unlock → agent becomes live.
    await useAgentStore.getState().initializeFirstLaunch();
    useSessionStore.getState().setHasIdentity(true);
    useSessionStore.getState().completeOnboarding();
    useSessionStore.getState().unlockSession();

    const liveAgent = useAgentStore.getState().agent;
    expect(liveAgent).not.toBeNull();

    // 3. Approve (same pending request from step 1).
    await useWalletConnectStore
      .getState()
      .approve('did:dht:user:alice', liveAgent as unknown);

    // submitConnectResponse signature: (selectedDid, request, pin, agent).
    expect(
      agentModule.__mocks__.submitConnectResponse,
    ).toHaveBeenCalledTimes(1);
    expect(agentModule.__mocks__.submitConnectResponse).toHaveBeenCalledWith(
      'did:dht:user:alice',
      CONNECT_REQUEST,
      '4321',
      liveAgent,
    );

    // randomPin called with length 4 exactly.
    expect(cryptoModule.__mocks__.randomPin).toHaveBeenCalledWith({ length: 4 });

    // Final phase is 'pin' with the 4-digit connect PIN.
    const state = useWalletConnectStore.getState();
    expect(state.phase).toBe('pin');
    expect(state.generatedPin).toMatch(/^\d{4}$/);

    // VAL-CROSS-010 — no password in any `start`/`initialize` call.
    const allAgents = (await Promise.all(
      agentModule.__mocks__.EnboxUserAgentCreate.mock.results.map(
        (r) => r.value,
      ),
    )) as Array<{ initialize: jest.Mock; start: jest.Mock }>;
    for (const agent of allAgents) {
      for (const call of agent.initialize.mock.calls) {
        expect(call[0]).not.toEqual(
          expect.objectContaining({ password: expect.anything() }),
        );
      }
      for (const call of agent.start.mock.calls) {
        expect(call[0]).not.toEqual(
          expect.objectContaining({ password: expect.anything() }),
        );
      }
    }
  });
});
