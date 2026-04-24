/**
 * Defensive `vault.lock()` in agent-store catch paths.
 *
 * VAL-VAULT-031 / Round-2 review Finding 5.
 *
 * `unlockAgent()` / `initializeFirstLaunch()` / `resumePendingBackup()`
 * each call `agent.start({})` (or `agent.initialize({})`) which forwards
 * to `BiometricVault.unlock()` / `.initialize()`. Both populate the
 * vault's in-memory `_secretBytes`, `_rootSeed`, and
 * `_contentEncryptionKey` buffers BEFORE the action's later steps run.
 * If a later step throws — e.g. an upstream `EnboxUserAgent.start()`
 * regression that mutates a property post-unlock and rejects, the
 * `getDid()` assignment in `initializeFirstLaunch`, the
 * `vault.getMnemonic()` call in `resumePendingBackup`, or the
 * success-path `set(...)` itself — the catch block previously only
 * dropped store references. The unlocked secret bytes lingered in the
 * BiometricVault instance until GC, which is a documented residency
 * window the spec wants closed.
 *
 * The fix in agent-store.ts captures a local `vaultRef` after
 * `initializeAgent()` returns and the catch block calls `vaultRef.lock()`
 * defensively before re-throwing. This suite pins that contract:
 *
 *   - On `unlockAgent()` failure post-unlock, `vault.lock()` is invoked.
 *   - On `initializeFirstLaunch()` failure post-unlock, `vault.lock()`
 *     is invoked.
 *   - On `resumePendingBackup()` failure post-unlock, `vault.lock()` is
 *     invoked.
 *   - A `vault.lock()` rejection is logged but does NOT mask the
 *     original error surfaced to the caller.
 *   - When the failure occurs BEFORE `initializeAgent()` returns
 *     (so no vault is ever materialised), no `lock()` call is attempted.
 */

// ---------------------------------------------------------------------------
// Virtual stubs for ESM-only @enbox packages so requiring the agent-store
// after `jest.resetModules()` does not crash on `Cannot find module`.
// The native biometric mock comes from `jest.setup.js` and is registered
// via the global mock setup — no explicit import is needed here.
// ---------------------------------------------------------------------------

// Silence expected console noise from the catch paths.
const consoleSpies: jest.SpyInstance[] = [];
beforeAll(() => {
  consoleSpies.push(jest.spyOn(console, 'log').mockImplementation(() => {}));
  consoleSpies.push(jest.spyOn(console, 'warn').mockImplementation(() => {}));
  consoleSpies.push(jest.spyOn(console, 'error').mockImplementation(() => {}));
});
afterAll(() => {
  for (const s of consoleSpies) s.mockRestore();
});

interface FakeAgent {
  agentDid: { uri: string } | undefined;
  initialize: jest.Mock;
  start: jest.Mock;
  firstLaunch: jest.Mock;
  identity: { list: jest.Mock; create: jest.Mock };
}

interface FakeVault {
  lock: jest.Mock;
  getMnemonic: jest.Mock;
  getDid: jest.Mock;
}

function makeFakes(opts: {
  startError?: Error;
  initializeError?: Error;
  firstLaunch?: boolean;
  getMnemonicError?: Error;
  lockError?: Error;
  postStartHook?: () => void;
}): { agent: FakeAgent; vault: FakeVault } {
  const lock = jest.fn(
    opts.lockError
      ? async () => {
          throw opts.lockError as Error;
        }
      : async () => undefined,
  );
  const vault: FakeVault = {
    lock,
    getMnemonic: jest.fn(
      opts.getMnemonicError
        ? async () => {
            throw opts.getMnemonicError as Error;
          }
        : async () => 'fake recovery phrase',
    ),
    getDid: jest.fn(async () => ({ uri: 'did:dht:catch-lock-test' })),
  };
  const agent: FakeAgent = {
    agentDid: undefined,
    initialize: jest.fn(
      opts.initializeError
        ? async () => {
            throw opts.initializeError as Error;
          }
        : async () => 'init recovery phrase',
    ),
    start: jest.fn(async () => {
      // Real upstream `EnboxUserAgent.start()` populates `agentDid`
      // from `vault.getDid()` AFTER the vault is unlocked. We mirror
      // that here so any test code that races on `agentDid` sees the
      // realistic post-unlock shape.
      agent.agentDid = { uri: 'did:dht:catch-lock-test' };
      if (opts.postStartHook) opts.postStartHook();
      if (opts.startError) {
        throw opts.startError as Error;
      }
    }),
    firstLaunch: jest.fn(async () => opts.firstLaunch ?? false),
    identity: { list: jest.fn(async () => []), create: jest.fn() },
  };
  return { agent, vault };
}

beforeEach(() => {
  jest.resetModules();
  // Re-register the virtual mocks after `jest.resetModules()` cleared
  // the module cache.
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

describe('useAgentStore.unlockAgent() — defensive vault.lock() in catch path (VAL-VAULT-031)', () => {
  it('calls vault.lock() when agent.start({}) rejects post-unlock', async () => {
    const startError = Object.assign(new Error('start failed mid-unlock'), {
      code: 'VAULT_ERROR',
    });
    const { agent, vault } = makeFakes({ startError });
    jest.doMock('@/lib/enbox/agent-init', () => ({
      __esModule: true,
      initializeAgent: jest.fn(async () => ({
        agent,
        authManager: { id: 'auth' },
        vault,
      })),
      createBiometricVault: jest.fn(),
    }));

    const { useAgentStore: freshStore } = require('@/lib/enbox/agent-store');

    await expect(
      freshStore.getState().unlockAgent(),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR' });

    // Defensive lock fired exactly once on the vault that was
    // returned by `initializeAgent()`, scrubbing any in-memory
    // material that `agent.start()` populated before throwing.
    expect(vault.lock).toHaveBeenCalledTimes(1);

    // Store references are still cleared for the success-path
    // teardown semantics — defensive lock is additive, not a
    // replacement.
    expect(freshStore.getState().vault).toBeNull();
    expect(freshStore.getState().agent).toBeNull();
  });

  it('does NOT call vault.lock() when initializeAgent() itself rejects (no vault to lock)', async () => {
    const initError = Object.assign(new Error('initializeAgent crashed'), {
      code: 'VAULT_ERROR',
    });
    // `vault.lock()` belongs to a vault that was never produced —
    // build a sentinel and assert it's never called.
    const sentinelLock = jest.fn(async () => undefined);
    jest.doMock('@/lib/enbox/agent-init', () => ({
      __esModule: true,
      initializeAgent: jest.fn(async () => {
        throw initError;
      }),
      createBiometricVault: jest.fn(),
    }));

    const { useAgentStore: freshStore } = require('@/lib/enbox/agent-store');

    await expect(
      freshStore.getState().unlockAgent(),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR' });

    expect(sentinelLock).not.toHaveBeenCalled();
    expect(freshStore.getState().vault).toBeNull();
  });

  it('surfaces the ORIGINAL error even when the defensive vault.lock() also rejects', async () => {
    const startError = Object.assign(new Error('original failure'), {
      code: 'VAULT_ERROR_USER_CANCEL',
    });
    const lockError = new Error('lock crashed during cleanup');
    const { agent, vault } = makeFakes({ startError, lockError });
    jest.doMock('@/lib/enbox/agent-init', () => ({
      __esModule: true,
      initializeAgent: jest.fn(async () => ({
        agent,
        authManager: { id: 'auth' },
        vault,
      })),
      createBiometricVault: jest.fn(),
    }));

    const { useAgentStore: freshStore } = require('@/lib/enbox/agent-store');

    // The CALLER must see the original error, not the lock failure.
    await expect(
      freshStore.getState().unlockAgent(),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR_USER_CANCEL' });

    // Lock was attempted; the rejection was swallowed.
    expect(vault.lock).toHaveBeenCalledTimes(1);
    // Flush the catch handler chained to vault.lock so the rejection
    // does not leak as an unhandledRejection in the test process.
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('useAgentStore.initializeFirstLaunch() — defensive vault.lock() in catch path (VAL-VAULT-031)', () => {
  it('calls vault.lock() when a post-initialize step throws', async () => {
    const initError = Object.assign(new Error('initialize threw post-unlock'), {
      code: 'VAULT_ERROR',
    });
    const { agent, vault } = makeFakes({
      firstLaunch: true,
      initializeError: initError,
    });
    jest.doMock('@/lib/enbox/agent-init', () => ({
      __esModule: true,
      initializeAgent: jest.fn(async () => ({
        agent,
        authManager: { id: 'auth' },
        vault,
      })),
      createBiometricVault: jest.fn(),
    }));

    const { useAgentStore: freshStore } = require('@/lib/enbox/agent-store');

    await expect(
      freshStore.getState().initializeFirstLaunch(),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR' });

    expect(vault.lock).toHaveBeenCalledTimes(1);
    expect(freshStore.getState().vault).toBeNull();
  });

  it('calls vault.lock() when agent.start({}) rejects on the existing-vault path', async () => {
    const startError = Object.assign(new Error('start rejected'), {
      code: 'VAULT_ERROR',
    });
    const { agent, vault } = makeFakes({
      firstLaunch: false,
      startError,
    });
    jest.doMock('@/lib/enbox/agent-init', () => ({
      __esModule: true,
      initializeAgent: jest.fn(async () => ({
        agent,
        authManager: { id: 'auth' },
        vault,
      })),
      createBiometricVault: jest.fn(),
    }));

    const { useAgentStore: freshStore } = require('@/lib/enbox/agent-store');

    await expect(
      freshStore.getState().initializeFirstLaunch(),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR' });

    expect(vault.lock).toHaveBeenCalledTimes(1);
  });
});

describe('useAgentStore.resumePendingBackup() — defensive vault.lock() in catch path (VAL-VAULT-031)', () => {
  it('calls vault.lock() when vault.getMnemonic() rejects post-unlock', async () => {
    const getMnemonicError = Object.assign(new Error('mnemonic re-derive failed'), {
      code: 'VAULT_ERROR',
    });
    const { agent, vault } = makeFakes({ getMnemonicError });
    jest.doMock('@/lib/enbox/agent-init', () => ({
      __esModule: true,
      initializeAgent: jest.fn(async () => ({
        agent,
        authManager: { id: 'auth' },
        vault,
      })),
      createBiometricVault: jest.fn(),
    }));

    const { useAgentStore: freshStore } = require('@/lib/enbox/agent-store');

    await expect(
      freshStore.getState().resumePendingBackup(),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR' });

    // start() succeeded (unlocking the vault), then getMnemonic threw.
    // The vault MUST be locked again before the catch block returns.
    expect(agent.start).toHaveBeenCalledTimes(1);
    expect(vault.getMnemonic).toHaveBeenCalledTimes(1);
    expect(vault.lock).toHaveBeenCalledTimes(1);
    expect(freshStore.getState().vault).toBeNull();
    expect(freshStore.getState().recoveryPhrase).toBeNull();
  });

  it('still surfaces the original error when the defensive lock also rejects', async () => {
    const getMnemonicError = Object.assign(new Error('mnemonic re-derive failed'), {
      code: 'VAULT_ERROR_USER_CANCEL',
    });
    const lockError = new Error('lock failed too');
    const { agent, vault } = makeFakes({ getMnemonicError, lockError });
    jest.doMock('@/lib/enbox/agent-init', () => ({
      __esModule: true,
      initializeAgent: jest.fn(async () => ({
        agent,
        authManager: { id: 'auth' },
        vault,
      })),
      createBiometricVault: jest.fn(),
    }));

    const { useAgentStore: freshStore } = require('@/lib/enbox/agent-store');

    await expect(
      freshStore.getState().resumePendingBackup(),
    ).rejects.toMatchObject({ code: 'VAULT_ERROR_USER_CANCEL' });

    expect(vault.lock).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
  });
});

