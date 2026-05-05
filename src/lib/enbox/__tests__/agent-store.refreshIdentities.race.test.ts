/**
 * Race-gate regression tests for `useAgentStore.refreshIdentities()`.
 *
 * Background (from feature `misc-suppress-agent-did-race-warnings`):
 *
 * The debug-emulator CI artifact (`logcat-rn.txt`) surfaced two benign
 * but noisy W-level lines during onboarding:
 *
 *   W/ReactNativeJS([agent] identity list failed: Error:
 *      EnboxUserAgent: The "agentDid" property is not set. ...)
 *
 * Root cause: upstream `EnboxUserAgent.initialize({})` sets up the vault
 * but does NOT assign `this.agentDid` — that field is only populated by
 * `start()` via `this.agentDid = yield this.vault.getDid()`. Between
 * `await agent.initialize({})` returning and whatever later code path
 * sets `agentDid`, `refreshIdentities()` optimistically calls
 * `agent.identity.list()`, which dereferences `agent.agentDid.uri`
 * through `AgentIdentityApi.tenant` and triggers the upstream throw
 * via the getter.
 *
 * The fix gates `refreshIdentities()` on a safe `agent.agentDid` probe
 * and returns silently when the DID has not yet been observed. Once
 * the DID is assigned, `refreshIdentities()` resumes normal behavior.
 *
 * These tests pin the gate semantics at the store primitive layer by
 * directly planting fake agent instances via `useAgentStore.setState`,
 * sidestepping the heavier onboarding harness used elsewhere in the
 * suite. They intentionally do NOT import `@enbox/*` packages so no
 * virtual-mock factory is required.
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

// Silence deliberate-warning assertions from one test so Jest output
// stays clean; we restore immediately after each test.
let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
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
import { useAgentStore } from '@/lib/enbox/agent-store';

function resetStore() {
  // teardown() also cancels any in-flight agentDid-race poller that
  // `refreshIdentities()` may have scheduled during the previous test.
  // Without this, the real setInterval (this suite runs on real timers)
  // keeps ticking past test completion and produces Jest's
  // "asynchronous operations that weren't stopped" warning.
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

describe('useAgentStore.refreshIdentities() — agentDid race gate', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    // Ensure the post-race-gate poller (`setInterval` scheduled by the
    // early-return path in `refreshIdentities()`) is stopped before the
    // next test runs. `teardown()` cancels it idempotently.
    useAgentStore.getState().teardown();
  });

  it('is a no-op when no agent is set (pre-existing contract)', async () => {
    await useAgentStore.getState().refreshIdentities();
    expect(useAgentStore.getState().identities).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('SKIPS identity.list() and does NOT warn when agent.agentDid is not yet assigned', async () => {
    // Simulate the race: agent has been set into the store, but
    // `_agentDid` has not yet been populated by the vault.
    const agent = makeFakeAgent({ agentDid: undefined });
    useAgentStore.setState({ agent: agent as unknown as any });

    await useAgentStore.getState().refreshIdentities();

    // The gate must prevent the native identity.list() dispatch entirely.
    expect(agent.identity.list).not.toHaveBeenCalled();
    // Store must retain its prior identities — no empty-out side effect
    // that could paper over real errors when list() runs for real.
    expect(useAgentStore.getState().identities).toEqual([]);
    // Critically: NO W-level warning line. That's the whole point of
    // the fix — incident responders greppying `logcat` for 'identity'
    // must not see this transient benign state.
    const identityFailedWarns = warnSpy.mock.calls.filter((call) =>
      typeof call[0] === 'string' && call[0].includes('identity list failed'),
    );
    expect(identityFailedWarns).toEqual([]);
  });

  it('CALLS identity.list() and stores the result once agentDid is observed', async () => {
    // Plant a fully-booted agent (post-`start()` state): `agentDid` is
    // set to a non-empty URI, list resolves with one identity.
    const agent = makeFakeAgent({
      agentDid: { uri: 'did:dht:alice' },
      listResult: [
        { metadata: { name: 'alice' }, did: { uri: 'did:dht:alice' } },
      ],
    });
    useAgentStore.setState({ agent: agent as unknown as any });

    await useAgentStore.getState().refreshIdentities();

    expect(agent.identity.list).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().identities).toHaveLength(1);
    expect(useAgentStore.getState().identities[0]).toMatchObject({
      metadata: { name: 'alice' },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resumes populating identities after the race resolves (unset → set transition)', async () => {
    // Plant a mutable agent starting out with no agentDid.
    const agent = makeFakeAgent({
      agentDid: undefined,
      listResult: [
        { metadata: { name: 'alice' }, did: { uri: 'did:dht:alice' } },
      ],
    });
    useAgentStore.setState({ agent: agent as unknown as any });

    // Pre-DID: gate skips.
    await useAgentStore.getState().refreshIdentities();
    expect(agent.identity.list).not.toHaveBeenCalled();
    expect(useAgentStore.getState().identities).toEqual([]);

    // Simulate upstream assigning agentDid (what `agent.start()` or a
    // later wiring does via `vault.getDid()`).
    agent._agentDid = { uri: 'did:dht:alice' };

    // Re-fire — list is now invoked, identities populate.
    await useAgentStore.getState().refreshIdentities();
    expect(agent.identity.list).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().identities).toHaveLength(1);
  });

  it('still surfaces a W-level warning for NON-race failures (genuine list errors)', async () => {
    // agentDid is set, so the gate opens. `list()` rejects with an
    // unrelated error — the warning path must fire so real problems
    // remain visible to developers and CI grep.
    const agent = makeFakeAgent({
      agentDid: { uri: 'did:dht:alice' },
      listError: new Error('DWN unreachable'),
    });
    useAgentStore.setState({ agent: agent as unknown as any });

    await useAgentStore.getState().refreshIdentities();

    expect(agent.identity.list).toHaveBeenCalledTimes(1);
    // Identities stay empty, but the warn call must be present to aid
    // debugging — this confirms the fix did not silently swallow all
    // errors, only the agentDid-race class.
    expect(useAgentStore.getState().identities).toEqual([]);
    const identityFailedWarns = warnSpy.mock.calls.filter((call) =>
      typeof call[0] === 'string' && call[0].includes('identity list failed'),
    );
    expect(identityFailedWarns.length).toBeGreaterThan(0);
  });

  it('treats an agentDid object with a missing/empty `uri` as "not set" and skips the call', async () => {
    // Defensive: a future refactor might set `agentDid = {}` before the
    // URI is fully resolved. The gate must still skip in that case so
    // the warning does not creep back.
    const agent = makeFakeAgent({
      agentDid: { uri: '' },
      listResult: [],
    });
    useAgentStore.setState({ agent: agent as unknown as any });

    await useAgentStore.getState().refreshIdentities();
    expect(agent.identity.list).not.toHaveBeenCalled();
    const identityFailedWarns = warnSpy.mock.calls.filter((call) =>
      typeof call[0] === 'string' && call[0].includes('identity list failed'),
    );
    expect(identityFailedWarns).toEqual([]);
  });
});
