/**
 * Regression tests for the "restoreFromMnemonic does not assign
 * agentDid" scrutiny round-2 blocker (feature
 * `fix-restore-path-assign-agent-did`).
 *
 * Background
 * ----------
 * Upstream `EnboxUserAgent.initialize({ recoveryPhrase })` provisions
 * the vault but does NOT assign `this.agentDid` — that field is only
 * set inside `start()` via `this.agentDid = await this.vault.getDid()`.
 * The mobile `restoreFromMnemonic()` flow deliberately avoids calling
 * `agent.start()` (the vault is already unlocked in memory from the
 * preceding biometric prompt inside `initialize`), so without a
 * compensating assignment the race-gate in `refreshIdentities()` would
 * keep early-returning and the 2s retry poller would time out, leaving
 * restored wallets with a stale / empty identity list even though the
 * agent and DWN layer are fully provisioned.
 *
 * The fix directly assigns `agent.agentDid = await vault.getDid()`
 * after `agent.initialize({ recoveryPhrase })` succeeds — the same
 * assignment upstream's `start()` performs, without triggering a
 * second biometric prompt because the vault is already unlocked.
 *
 * These tests:
 *   1. Pin the assignment by replacing `initializeAgent()` with a
 *      hand-rolled agent/vault pair whose `vault.getDid()` returns a
 *      BearerDid-shaped stub with a `uri` field, then call
 *      `restoreFromMnemonic()` and assert `agent.agentDid.uri` matches
 *      the expected value.
 *   2. Verify `refreshIdentities()` succeeds immediately after the
 *      restore — the race-gate sees `hasAgentDid === true` so the
 *      poller is never scheduled and `agent.identity.list()` is
 *      dispatched on the first call.
 *   3. Cover the defensive `try/catch` branch: when `vault.getDid()`
 *      rejects unexpectedly, `restoreFromMnemonic()` still resolves
 *      and leaves `agent.agentDid` unset (race-gate will early-return
 *      as before and the poller will handle the DID's eventual
 *      arrival).
 */

// -------------------------------------------------------------------
// Virtual mocks for ESM-only @enbox/* packages so `useAgentStore` can
// be imported without pulling in the real runtime. We only stub enough
// surface to satisfy the store's module graph — the actual agent and
// vault instances exercised by the tests come from the `initializeAgent`
// mock below, NOT from these classes.
// -------------------------------------------------------------------

jest.mock(
  '@enbox/agent',
  () => {
    class AgentDwnApi {}
    class AgentCryptoApi {}
    class EnboxUserAgent {}
    class LocalDwnDiscovery {}
    return {
      __esModule: true,
      AgentDwnApi,
      AgentCryptoApi,
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
    AuthManager: { create: jest.fn() },
  }),
  { virtual: true },
);

jest.mock(
  '@enbox/dids',
  () => {
    class BearerDid {}
    return { __esModule: true, BearerDid, DidDht: { create: jest.fn() } };
  },
  { virtual: true },
);

jest.mock(
  '@enbox/crypto',
  () => {
    class LocalKeyManager {}
    return {
      __esModule: true,
      LocalKeyManager,
      computeJwkThumbprint: jest.fn(),
      Ed25519: { sign: jest.fn() },
    };
  },
  { virtual: true },
);

// -------------------------------------------------------------------
// Fake agent / vault factory used by the tests.
// -------------------------------------------------------------------

type FakeAgent = {
  agentDid: { uri: string } | undefined;
  initialize: jest.Mock;
  start: jest.Mock;
  firstLaunch: jest.Mock;
  identity: { list: jest.Mock; create: jest.Mock };
};

type FakeVault = {
  getDid: jest.Mock;
};

function makeFakeAgentAndVault(opts: {
  didUri?: string;
  listResult?: unknown[];
  getDidError?: Error;
}): { agent: FakeAgent; vault: FakeVault } {
  const agent: FakeAgent = {
    // Starts unset — upstream's contract. The fix under test must
    // assign this during `restoreFromMnemonic()`.
    agentDid: undefined,
    initialize: jest.fn(async () => 'ignored-mnemonic'),
    start: jest.fn(async () => undefined),
    firstLaunch: jest.fn(async () => true),
    identity: {
      list: jest.fn(async () => opts.listResult ?? []),
      create: jest.fn(),
    },
  };
  const vault: FakeVault = {
    getDid: jest.fn(
      opts.getDidError
        ? async () => {
            throw opts.getDidError as Error;
          }
        : async () => ({ uri: opts.didUri ?? 'did:dht:restored-alice' }),
    ),
  };
  return { agent, vault };
}

// -------------------------------------------------------------------
// Mock `@/lib/enbox/agent-init` so the store's `restoreFromMnemonic`
// gets our fake agent+vault pair instead of spinning up the real
// upstream/native-module stack. The `initializeAgent` implementation
// is swapped per-test via `mockInitializeAgent.mockResolvedValueOnce`.
// -------------------------------------------------------------------

const mockInitializeAgent = jest.fn();
jest.mock('@/lib/enbox/agent-init', () => ({
  __esModule: true,
  initializeAgent: (...args: unknown[]) => mockInitializeAgent(...args),
  createBiometricVault: jest.fn(),
}));

// -------------------------------------------------------------------
// Silence expected console noise.
// -------------------------------------------------------------------

let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
  errorSpy.mockRestore();
  mockInitializeAgent.mockReset();
});

// -------------------------------------------------------------------
// Module under test (imported AFTER mocks are registered).
// -------------------------------------------------------------------

import {
  __getPendingIdentityPollerForTests,
  useAgentStore,
} from '@/lib/enbox/agent-store';

function resetStore() {
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
  resetStore();
});

afterEach(() => {
  resetStore();
});

// ===================================================================
// Core regression: restoreFromMnemonic() must assign agent.agentDid
// from vault.getDid() so refreshIdentities() can list identities.
// ===================================================================

describe('useAgentStore.restoreFromMnemonic() — assigns agentDid from vault.getDid()', () => {
  it('sets agent.agentDid to the BearerDid returned by vault.getDid() after initialize', async () => {
    const { agent, vault } = makeFakeAgentAndVault({
      didUri: 'did:dht:restored-alice',
    });
    mockInitializeAgent.mockResolvedValueOnce({
      agent,
      authManager: { id: 'auth-manager-stub' },
      vault,
    });

    await useAgentStore
      .getState()
      .restoreFromMnemonic(
        'plum neck ring tail arm dune shuffle cruise boss arrow bleak ' +
          'shield thumb curious tape trial tongue ozone vivid flame soap ' +
          'equal cradle auction',
      );

    // The restore flow must have (a) called `agent.initialize` with the
    // supplied mnemonic and (b) assigned `agent.agentDid` to the
    // BearerDid returned by `vault.getDid()`.
    expect(agent.initialize).toHaveBeenCalledTimes(1);
    const initArgs = agent.initialize.mock.calls[0][0] as {
      recoveryPhrase?: string;
    };
    expect(initArgs?.recoveryPhrase).toMatch(/^plum /);
    expect(vault.getDid).toHaveBeenCalledTimes(1);
    expect(agent.agentDid).toBeDefined();
    expect(agent.agentDid?.uri).toBe('did:dht:restored-alice');
    // agent.start() must NOT be called — the whole point of the fix is
    // to avoid a second biometric prompt. Upstream's start() would
    // trigger `vault.unlock()` (biometric) before its own assignment.
    expect(agent.start).not.toHaveBeenCalled();
  });

  it('restored agent is visible on the store with biometricState="ready"', async () => {
    const { agent, vault } = makeFakeAgentAndVault({
      didUri: 'did:dht:restored-bob',
    });
    mockInitializeAgent.mockResolvedValueOnce({
      agent,
      authManager: { id: 'auth-manager-stub' },
      vault,
    });

    await useAgentStore
      .getState()
      .restoreFromMnemonic('abandon '.repeat(23).trim() + ' about');

    const state = useAgentStore.getState();
    expect(state.agent).toBe(agent as unknown as typeof state.agent);
    expect(state.vault).toBe(vault as unknown as typeof state.vault);
    expect(state.biometricState).toBe('ready');
    expect(state.isInitializing).toBe(false);
    expect(state.error).toBeNull();
    // Recovery phrase must stay null — we just restored from the user
    // typing it, so it must not be mirrored back into JS memory.
    expect(state.recoveryPhrase).toBeNull();
  });
});

// ===================================================================
// After restore, refreshIdentities() reaches identity.list() directly
// — no race-gate skip, no retry poller scheduled.
// ===================================================================

describe('useAgentStore.refreshIdentities() after restore — no race-gate skip', () => {
  it('dispatches agent.identity.list() immediately after restoreFromMnemonic', async () => {
    const { agent, vault } = makeFakeAgentAndVault({
      didUri: 'did:dht:restored-alice',
      listResult: [
        { metadata: { name: 'alice' }, did: { uri: 'did:dht:restored-alice' } },
      ],
    });
    mockInitializeAgent.mockResolvedValueOnce({
      agent,
      authManager: { id: 'auth-manager-stub' },
      vault,
    });

    // setInterval spy — the retry poller must NOT be scheduled once the
    // agentDid assignment has happened.
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    await useAgentStore
      .getState()
      .restoreFromMnemonic('abandon '.repeat(23).trim() + ' about');

    // `restoreFromMnemonic` fires a fire-and-forget `refreshIdentities`
    // (`get().refreshIdentities().catch(() => {})`). Flush the
    // microtask queue so the awaited `identity.list()` inside it
    // settles.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(agent.identity.list).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().identities).toHaveLength(1);
    expect(useAgentStore.getState().identities[0]).toMatchObject({
      metadata: { name: 'alice' },
    });
    // No retry poller scheduled — agentDid was observable on the first
    // `refreshIdentities()` call.
    expect(__getPendingIdentityPollerForTests()).toBeNull();
    // No setInterval call from refreshIdentities' early-return path.
    // (The fake agent never leaves agentDid unset by the time
    // refreshIdentities runs, so the early-return branch is not taken.)
    expect(setIntervalSpy).not.toHaveBeenCalled();

    setIntervalSpy.mockRestore();
  });

  it('explicit refreshIdentities() after restore resolves without errors', async () => {
    const { agent, vault } = makeFakeAgentAndVault({
      didUri: 'did:dht:restored-charlie',
      listResult: [
        { metadata: { name: 'charlie' } },
        { metadata: { name: 'charlie-alt' } },
      ],
    });
    mockInitializeAgent.mockResolvedValueOnce({
      agent,
      authManager: { id: 'auth-manager-stub' },
      vault,
    });

    await useAgentStore
      .getState()
      .restoreFromMnemonic('abandon '.repeat(23).trim() + ' about');

    // Wait for the fire-and-forget refresh spawned by restore to finish
    // before asserting on the explicit refresh so the test is not
    // accidentally satisfied by the first implicit call alone.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Explicit refresh — must resolve normally and must NOT schedule a
    // retry poller. Counter increments to 2.
    await useAgentStore.getState().refreshIdentities();

    expect(agent.identity.list).toHaveBeenCalledTimes(2);
    expect(useAgentStore.getState().identities).toHaveLength(2);
    expect(__getPendingIdentityPollerForTests()).toBeNull();

    // Sanity: no `identity list failed` warning was emitted (that would
    // indicate the race gate fired unexpectedly).
    const identityFailedWarns = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' && call[0].includes('identity list failed'),
    );
    expect(identityFailedWarns).toEqual([]);
  });
});

// ===================================================================
// Defensive branch: vault.getDid() throws → restore still resolves,
// agentDid stays unset, race-gate reverts to retry-poller behavior.
// ===================================================================

describe('useAgentStore.restoreFromMnemonic() — resilient when vault.getDid() throws', () => {
  it('swallows a getDid() rejection (agentDid stays unset; restore still succeeds)', async () => {
    const { agent, vault } = makeFakeAgentAndVault({
      getDidError: Object.assign(new Error('vault locked unexpectedly'), {
        code: 'VAULT_ERROR_LOCKED',
      }),
    });
    mockInitializeAgent.mockResolvedValueOnce({
      agent,
      authManager: { id: 'auth-manager-stub' },
      vault,
    });

    await expect(
      useAgentStore
        .getState()
        .restoreFromMnemonic('abandon '.repeat(23).trim() + ' about'),
    ).resolves.toBeUndefined();

    // getDid was attempted and threw.
    expect(vault.getDid).toHaveBeenCalledTimes(1);
    // agent.agentDid was NOT assigned — the catch branch only logs a
    // warning and moves on.
    expect(agent.agentDid).toBeUndefined();

    // Store still flipped to ready (the restore itself succeeded; the
    // agentDid assignment is purely a latency optimization).
    const state = useAgentStore.getState();
    expect(state.error).toBeNull();
    expect(state.biometricState).toBe('ready');
    expect(state.agent).toBe(agent as unknown as typeof state.agent);

    // A diagnostic warning mentioning the restore path was emitted so
    // operators can correlate the subsequent race-gate retries.
    const assignWarns = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('restoreFromMnemonic: could not assign agentDid'),
    );
    expect(assignWarns.length).toBeGreaterThanOrEqual(1);
  });
});
