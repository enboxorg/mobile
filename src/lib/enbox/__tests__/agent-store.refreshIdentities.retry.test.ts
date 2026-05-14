/**
 * Auto-retry tests for `useAgentStore.refreshIdentities()`.
 *
 * Background (from feature `fix-agent-did-race-retry-when-ready`):
 *
 * The race-gate fix in `misc-suppress-agent-did-race-warnings` silenced
 * the transient `agentDid`-not-set warning by early-returning from
 * `refreshIdentities()` when `hasAgentDid(agent)` is false. That
 * eliminated the noise but left a latent correctness risk: if a caller
 * fires `refreshIdentities()` BEFORE `agent.start()` assigns `agentDid`,
 * and no later caller happens to re-trigger, the store's `identities`
 * list stays stale forever.
 *
 * The retry mechanism closes the gap with a short-lived polling timer
 * started from `refreshIdentities()`'s early-return path. The poller:
 *
 *   - ticks every 50ms for at most 40 iterations (2s cap);
 *   - retriggers `refreshIdentities()` the moment `agentDid` is observed;
 *   - gives up silently on the 2s cap with no `identity.list()` dispatch
 *     and no warning;
 *   - is idempotent — concurrent early-skip calls don't start multiple
 *     pollers;
 *   - is cancelled on `teardown()` / lock / reset so intervals don't leak.
 *
 * These tests pin the above contract at the store primitive layer. They
 * sidestep the heavier onboarding harness (used by the `.test.ts` suite)
 * by planting fake agent instances directly via `useAgentStore.setState`.
 */

// A lightweight fake agent that models upstream `EnboxUserAgent`'s
// `agentDid` getter contract: the getter throws when `_agentDid` is
// undefined, and returns the value when assigned. `identity.list` is a
// jest.fn so we can assert whether `refreshIdentities()` dispatched.
type FakeAgent = {
  _agentDid: { uri: string } | undefined;
  readonly agentDid: { uri: string };
  identity: { list: jest.Mock; create: jest.Mock };
};

function makeFakeAgent(opts: {
  agentDid?: { uri: string };
  listResult?: unknown[];
  listError?: Error;
}): FakeAgent {
  const listImpl = opts.listError
    ? jest.fn(async () => {
        throw opts.listError;
      })
    : jest.fn(async () => opts.listResult ?? []);
  const agent: FakeAgent = {
    _agentDid: opts.agentDid,
    get agentDid() {
      if (this._agentDid === undefined) {
        throw new Error(
          'EnboxUserAgent: The "agentDid" property is not set. Ensure the agent is properly ' +
            'initialized and a DID is assigned.',
        );
      }
      return this._agentDid;
    },
    identity: {
      list: listImpl,
      create: jest.fn(),
    },
  };
  return agent;
}

// Silence deliberate warning/log noise from the store.
let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  // Modern fake timers so we can deterministically advance the 50ms
  // polling interval without blocking on real wall-clock time.
  jest.useFakeTimers();
});
afterEach(() => {
  // Ensure no test leaks a real timer into the next.
  jest.clearAllTimers();
  jest.useRealTimers();
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

// -------------------------------------------------------------------
// Minimal virtual mocks so `useAgentStore` can be imported without
// spinning up the full ESM-only `@enbox/*` / native-module harness.
// Nothing in these tests exercises the real initializeAgent() path.
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
// Module under test (imported AFTER virtual mocks register).
// -------------------------------------------------------------------
import {
  __getPendingIdentityPollerForTests,
  useAgentStore,
} from '@/lib/enbox/agent-store';

function resetStore() {
  // teardown() also cancels any in-flight poller, which matters
  // between tests so we don't leak a timer reference.
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

/**
 * Helper: flush pending microtasks that were resolved during
 * `jest.advanceTimersByTime`. We still need to yield to the real
 * microtask queue because the poller's retrigger calls
 * `refreshIdentities()` (async) and its `await agent.identity.list()`
 * resolves on a microtask.
 */
async function flushMicrotasks(): Promise<void> {
  // Two ticks: one for the poller's call to `refreshIdentities()`,
  // one for the awaited `identity.list()` resolution.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('useAgentStore.refreshIdentities() — polling auto-retry', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    // Double-safety — if an assertion mid-test left a poller alive,
    // stop it now so the next test starts clean.
    useAgentStore.getState().teardown();
  });

  it('early-returns silently and does NOT warn when agentDid is unset', async () => {
    const agent = makeFakeAgent({ agentDid: undefined });
    useAgentStore.setState({ agent: agent as unknown as any });

    await useAgentStore.getState().refreshIdentities();

    expect(agent.identity.list).not.toHaveBeenCalled();
    // Silent: no `identity list failed` warning (that was the whole
    // point of the original race-gate; the retry must not regress it).
    const identityFailedWarns = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' && call[0].includes('identity list failed'),
    );
    expect(identityFailedWarns).toEqual([]);
  });

  it('starts a polling timer on early-return (poller becomes non-null)', async () => {
    // Use a setInterval spy to prove a timer was scheduled from the
    // refresh path, as required by the feature's verificationSteps
    // (`rg 'setInterval|notifyAgentDidReady' ...`).
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    const agent = makeFakeAgent({ agentDid: undefined });
    useAgentStore.setState({ agent: agent as unknown as any });

    expect(__getPendingIdentityPollerForTests()).toBeNull();
    await useAgentStore.getState().refreshIdentities();

    // setInterval was called at least once from the refreshIdentities
    // early-return, and the module-scoped poller reference is now set.
    expect(setIntervalSpy).toHaveBeenCalled();
    const poller = __getPendingIdentityPollerForTests();
    expect(poller).not.toBeNull();
    expect(poller?.agent).toBe(agent);

    setIntervalSpy.mockRestore();
  });

  it('retriggers refreshIdentities() automatically once agentDid becomes observable', async () => {
    const agent = makeFakeAgent({
      agentDid: undefined,
      listResult: [
        { metadata: { name: 'alice' }, did: { uri: 'did:dht:alice' } },
      ],
    });
    useAgentStore.setState({ agent: agent as unknown as any });

    // 1. First call — gate closed, poller starts.
    await useAgentStore.getState().refreshIdentities();
    expect(agent.identity.list).not.toHaveBeenCalled();
    expect(__getPendingIdentityPollerForTests()).not.toBeNull();

    // 2. Advance a single poll tick with the DID still unset — poller
    //    should keep waiting, list not yet called.
    jest.advanceTimersByTime(50);
    await flushMicrotasks();
    expect(agent.identity.list).not.toHaveBeenCalled();
    expect(__getPendingIdentityPollerForTests()).not.toBeNull();

    // 3. Simulate upstream `agent.start()` assigning the DID from
    //    `vault.getDid()`.
    agent._agentDid = { uri: 'did:dht:alice' };

    // 4. Advance one more tick. The poller observes the DID, clears
    //    itself, and retriggers `refreshIdentities()`.
    jest.advanceTimersByTime(50);
    await flushMicrotasks();

    expect(agent.identity.list).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().identities).toHaveLength(1);
    expect(useAgentStore.getState().identities[0]).toMatchObject({
      metadata: { name: 'alice' },
    });
    // Poller cleaned up after success.
    expect(__getPendingIdentityPollerForTests()).toBeNull();
  });

  it('gives up cleanly after the 2s cap — no list() call, no warning, poller cleared', async () => {
    const agent = makeFakeAgent({ agentDid: undefined });
    useAgentStore.setState({ agent: agent as unknown as any });

    await useAgentStore.getState().refreshIdentities();
    expect(__getPendingIdentityPollerForTests()).not.toBeNull();

    // 40 iterations * 50ms = 2000ms — exactly the cap. Advance a bit
    // past that so the 40th tick's cap check fires.
    jest.advanceTimersByTime(2100);
    await flushMicrotasks();

    expect(agent.identity.list).not.toHaveBeenCalled();
    // Poller is cleared.
    expect(__getPendingIdentityPollerForTests()).toBeNull();
    // No warnings — the whole point of giving up silently.
    const identityFailedWarns = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' && call[0].includes('identity list failed'),
    );
    expect(identityFailedWarns).toEqual([]);
    // Store identities remain untouched.
    expect(useAgentStore.getState().identities).toEqual([]);
  });

  it('is idempotent — concurrent early-skip calls do NOT start multiple pollers', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const agent = makeFakeAgent({ agentDid: undefined });
    useAgentStore.setState({ agent: agent as unknown as any });

    // Fire three back-to-back early-skip refreshes.
    await Promise.all([
      useAgentStore.getState().refreshIdentities(),
      useAgentStore.getState().refreshIdentities(),
      useAgentStore.getState().refreshIdentities(),
    ]);

    // Exactly one setInterval scheduled despite three early-returns.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(__getPendingIdentityPollerForTests()).not.toBeNull();

    setIntervalSpy.mockRestore();
  });

  it('teardown() cancels an in-flight poller so no retrigger fires later', async () => {
    const agent = makeFakeAgent({
      agentDid: undefined,
      listResult: [
        { metadata: { name: 'alice' }, did: { uri: 'did:dht:alice' } },
      ],
    });
    useAgentStore.setState({ agent: agent as unknown as any });

    await useAgentStore.getState().refreshIdentities();
    expect(__getPendingIdentityPollerForTests()).not.toBeNull();

    // Tear down — poller must be cancelled immediately.
    useAgentStore.getState().teardown();
    expect(__getPendingIdentityPollerForTests()).toBeNull();

    // Re-plant the SAME agent with agentDid set AFTER teardown to
    // simulate a racy world where the agent's DID eventually becomes
    // available after the store was locked. Advance a long time to
    // give any lingering interval (if the fix regressed) a chance to
    // fire and trigger a rogue identity.list().
    agent._agentDid = { uri: 'did:dht:alice' };
    jest.advanceTimersByTime(5000);
    await flushMicrotasks();

    // The dead poller must NOT have retriggered refresh. Since we
    // cleared the store's agent during teardown, any rogue call would
    // be a no-op at the top-level `if (!agent) return;` anyway, but
    // we still assert `identity.list` was never invoked to pin the
    // cancellation semantics explicitly.
    expect(agent.identity.list).not.toHaveBeenCalled();
  });

  it('stops polling early if the store agent is replaced (new unlock / lock-then-unlock)', async () => {
    const agent1 = makeFakeAgent({ agentDid: undefined });
    useAgentStore.setState({ agent: agent1 as unknown as any });

    await useAgentStore.getState().refreshIdentities();
    const pollerForAgent1 = __getPendingIdentityPollerForTests();
    expect(pollerForAgent1).not.toBeNull();
    expect(pollerForAgent1?.agent).toBe(agent1);

    // Simulate: app was locked + unlocked with a brand-new agent
    // instance BEFORE agent1's DID ever became available.
    const agent2 = makeFakeAgent({
      agentDid: { uri: 'did:dht:bob' },
      listResult: [{ metadata: { name: 'bob' } }],
    });
    useAgentStore.setState({ agent: agent2 as unknown as any });

    // Advance one tick. The poller sees `getStoreAgent() !== agent1`
    // and exits without retriggering.
    jest.advanceTimersByTime(50);
    await flushMicrotasks();

    expect(agent1.identity.list).not.toHaveBeenCalled();
    // Poller cleared (not re-armed for agent2 — only an explicit
    // `refreshIdentities()` call would start a new poller, and agent2
    // doesn't need one because its DID is already set).
    expect(__getPendingIdentityPollerForTests()).toBeNull();
  });

  it('does NOT start a poller when agentDid is already set (happy-path refresh)', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const agent = makeFakeAgent({
      agentDid: { uri: 'did:dht:alice' },
      listResult: [{ metadata: { name: 'alice' } }],
    });
    useAgentStore.setState({ agent: agent as unknown as any });

    await useAgentStore.getState().refreshIdentities();

    expect(agent.identity.list).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().identities).toHaveLength(1);
    // No poller started for the happy path — it would be pure waste.
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(__getPendingIdentityPollerForTests()).toBeNull();

    setIntervalSpy.mockRestore();
  });
});
