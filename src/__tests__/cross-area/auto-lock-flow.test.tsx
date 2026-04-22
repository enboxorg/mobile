/**
 * Cross-area integration test — VAL-CROSS-005.
 *
 * Auto-lock on background tears down the agent + locks the session,
 * and foreground MUST NOT auto-call `NativeBiometricVault.getSecret`
 * (biometric prompt is user-initiated only after a background/foreground
 * cycle).
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
    return {
      __esModule: true,
      AgentCryptoApi,
      AgentDwnApi,
      EnboxUserAgent,
      LocalDwnDiscovery,
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
      CryptoUtils: { randomPin: jest.fn(() => '0000') },
    };
  },
  { virtual: true },
);

import { AppState } from 'react-native';
import { act, render } from '@testing-library/react-native';

import { useAutoLock } from '@/hooks/use-auto-lock';
import { useSessionStore } from '@/features/session/session-store';
import { useAgentStore } from '@/lib/enbox/agent-store';

const nativeBiometric =
  (global as unknown as {
    __enboxBiometricVaultMock: {
      generateAndStoreSecret: jest.Mock;
      getSecret: jest.Mock;
      hasSecret: jest.Mock;
      deleteSecret: jest.Mock;
      isBiometricAvailable: jest.Mock;
    };
  }).__enboxBiometricVaultMock;

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
  (globalThis as unknown as Record<string, unknown>)
    .__enboxMobilePatchedAgentDwnApi = false;
});

// ---------------------------------------------------------------------
// VAL-CROSS-005 — AppState background tears down agent + foreground is
// biometric-gated
// ---------------------------------------------------------------------

describe('VAL-CROSS-005 — AppState background teardown + biometric re-unlock', () => {
  it('background drops agent + locks session; foreground does NOT auto-prompt biometrics', async () => {
    // --- Setup: user is unlocked with a live agent ---
    await useAgentStore.getState().initializeFirstLaunch();
    useSessionStore.getState().setHasIdentity(true);
    useSessionStore.getState().completeOnboarding();
    useSessionStore.getState().unlockSession();
    useAgentStore.getState().clearRecoveryPhrase();

    expect(useAgentStore.getState().agent).not.toBeNull();
    expect(useSessionStore.getState().isLocked).toBe(false);

    // Count of `getSecret` calls BEFORE the AppState edge so we can
    // assert no additional calls happen on foreground auto-prompt.
    const getSecretCallsBefore =
      nativeBiometric.getSecret.mock.calls.length;

    // Mount a host that installs the auto-lock hook (its effect
    // registers the AppState listener).
    function Host() {
      useAutoLock();
      return null;
    }
    render(<Host />);

    // react-native's Jest mock exposes AppState.addEventListener as a
    // plain jest.fn(); drive the handler directly.
    const addListenerMock =
      AppState.addEventListener as unknown as jest.Mock;
    const lastCall =
      addListenerMock.mock.calls[addListenerMock.mock.calls.length - 1];
    expect(lastCall?.[0]).toBe('change');
    const handler: (s: 'active' | 'background' | 'inactive') => void =
      lastCall?.[1];

    // Capture spies BEFORE the edge.
    const lockSpy = jest.spyOn(useSessionStore.getState(), 'lock');
    const teardownSpy = jest.spyOn(useAgentStore.getState(), 'teardown');

    // --- Act: active → background edge ---
    await act(async () => {
      handler('background');
    });

    expect(lockSpy).toHaveBeenCalledTimes(1);
    expect(teardownSpy).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().isLocked).toBe(true);
    expect(useAgentStore.getState().agent).toBeNull();
    expect(useAgentStore.getState().authManager).toBeNull();
    expect(useAgentStore.getState().recoveryPhrase).toBeNull();
    expect(useAgentStore.getState().identities).toEqual([]);

    // --- Act: background → active edge ---
    await act(async () => {
      handler('active');
    });

    // Foreground must NOT auto-issue a biometric prompt. The navigator
    // renders BiometricUnlock and waits for the user to tap.
    expect(nativeBiometric.getSecret.mock.calls.length).toBe(
      getSecretCallsBefore,
    );

    // Session still locked; agent still null. User must press CTA.
    expect(useSessionStore.getState().isLocked).toBe(true);
    expect(useAgentStore.getState().agent).toBeNull();

    // --- Act: explicit user-initiated unlock ---
    await useAgentStore.getState().unlockAgent();
    expect(nativeBiometric.getSecret.mock.calls.length).toBeGreaterThan(
      getSecretCallsBefore,
    );
    expect(useAgentStore.getState().agent).not.toBeNull();

    lockSpy.mockRestore();
    teardownSpy.mockRestore();
  });

  it('inactive → background transition (already non-active) does NOT double-teardown', async () => {
    // Arrange unlocked state.
    await useAgentStore.getState().initializeFirstLaunch();
    useSessionStore.getState().setHasIdentity(true);
    useSessionStore.getState().completeOnboarding();
    useSessionStore.getState().unlockSession();

    function Host() {
      useAutoLock();
      return null;
    }
    render(<Host />);

    const addListenerMock =
      AppState.addEventListener as unknown as jest.Mock;
    const handler: (s: 'active' | 'background' | 'inactive') => void =
      addListenerMock.mock.calls[
        addListenerMock.mock.calls.length - 1
      ]?.[1];

    const teardownSpy = jest.spyOn(useAgentStore.getState(), 'teardown');

    // First edge: active → inactive (fires teardown).
    await act(async () => {
      handler('inactive');
    });
    expect(teardownSpy).toHaveBeenCalledTimes(1);

    // Second edge: inactive → background — must be a no-op.
    await act(async () => {
      handler('background');
    });
    expect(teardownSpy).toHaveBeenCalledTimes(1);

    teardownSpy.mockRestore();
  });
});
