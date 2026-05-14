/**
 * Global agent store.
 *
 * Manages the Enbox agent lifecycle:
 * - First launch: creates agent, initializes the biometric vault (prompts
 *   biometrics through the native module) and returns the generated
 *   recovery phrase.
 * - Return visit: creates agent, unlocks the biometric vault (prompts
 *   biometrics through the native module). No password is involved.
 * - Lock: tears down agent + vault (biometrics required on next launch).
 * - Reset: tears down agent + wipes vault storage.
 */

import { create } from 'zustand';
import type { EnboxUserAgent, BearerIdentity } from '@enbox/agent';
import type { AuthManager } from '@enbox/auth';
import { STORAGE_KEYS as AUTH_STORAGE_KEYS } from '@enbox/auth';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

import NativeBiometricVault from '@specs/NativeBiometricVault';

import { useSessionStore } from '@/features/session/session-store';

import { initializeAgent } from './agent-init';
import {
  BiometricVault,
  type BiometricState,
} from './biometric-vault';
import {
  createMobileIdentity,
  deleteMobileIdentity,
  DEFAULT_DWN_ENDPOINTS,
  ensurePostSession,
  importMobileIdentity,
  recoverWalletFromSync,
  stopWalletSync,
  updateMobileIdentityName,
} from './identity-service';
import { destroyAgentLevelDatabases } from './rn-level';
import { SecureStorageAdapter } from './storage-adapter';
import {
  BIOMETRIC_STATE_STORAGE_KEY,
  INITIALIZED_STORAGE_KEY,
  WALLET_ROOT_KEY_ALIAS,
} from './vault-constants';

/**
 * `dataPath` passed to `EnboxUserAgent.create()` in `agent-init.ts`.
 * Duplicated as a module-scoped constant here so `reset()` can wipe
 * the matching LevelDB directories without reaching into the created
 * agent instance (which might already be torn down when reset runs).
 */
const AGENT_DATA_PATH = 'ENBOX_AGENT';

/** Retry marker for a failed ENBOX_AGENT LevelDB wipe. */
export const LEVELDB_CLEANUP_PENDING_KEY = 'enbox.agent.leveldb-cleanup-pending';

/**
 * Retry marker for a failed native vault wipe. Agent initialization
 * must retry this before any unlock, setup, or restore flow proceeds.
 */
export const VAULT_RESET_PENDING_KEY = 'enbox.vault.reset-pending';

/**
 * Retry marker for persisted AuthManager / Web5 connect material.
 * These keys include delegate credentials and active identity metadata,
 * so they must not survive a wallet reset.
 */
export const AUTH_RESET_PENDING_KEY = 'enbox.auth.reset-pending';

/**
 * Retry marker for stale SESSION_KEY cleanup. `session.hydrate()` checks
 * this before trusting persisted session state so a wiped wallet cannot
 * route to BiometricUnlock from an old `hasIdentity=true` snapshot.
 */
export const SESSION_RESET_PENDING_KEY = 'enbox.session.reset-pending';

/** Error code emitted by the biometric vault when the OS cannot satisfy a biometric prompt. */
const BIOMETRICS_UNAVAILABLE_CODE = 'VAULT_ERROR_BIOMETRICS_UNAVAILABLE';
/** Error code emitted by the biometric vault when the key was invalidated by the OS. */
const KEY_INVALIDATED_CODE = 'VAULT_ERROR_KEY_INVALIDATED';
const ENABLE_AGENT_STORE_LOGS = process.env.ENBOX_DEBUG_AGENT === '1';

function debugLog(...args: unknown[]) {
  if (ENABLE_AGENT_STORE_LOGS) {
    console.log(...args);
  }
}

/** Minimal SecureStorage surfaces used by retry-cleanup helpers. */
type CleanupStorageGetRemove = {
  get: (key: string) => Promise<string | null>;
  remove: (key: string) => Promise<void>;
};

type CleanupStorageGetSetRemove = CleanupStorageGetRemove & {
  set: (key: string, value: string) => Promise<void>;
};

/** Retry a pending LevelDB wipe before opening any agent database handle. */
export async function runPendingLevelDbCleanup(
  storage: CleanupStorageGetRemove = new SecureStorageAdapter(),
): Promise<boolean> {
  // Fail closed: if the sentinel cannot be read, we cannot prove the
  // LevelDB files are safe to open.
  const pending = await storage.get(LEVELDB_CLEANUP_PENDING_KEY);
  if (pending !== 'true') return true;
  await destroyAgentLevelDatabases(AGENT_DATA_PATH);
  // Wipe the sentinel ONLY after the retry succeeded. A crash between
  // here and the storage.remove call leaves the sentinel set, which
  // forces the next launch through this code path again — that's
  // safe (`destroyAgentLevelDatabases` is idempotent on already-empty
  // directories) and strictly preferable to clearing the flag before
  // we know the wipe stuck.
  try {
    await storage.remove(LEVELDB_CLEANUP_PENDING_KEY);
  } catch (err) {
    console.warn(
      '[agent-store] runPendingLevelDbCleanup: failed to clear sentinel after successful retry (next launch will re-run the cleanup):',
      err,
    );
  }
  return true;
}

/**
 * Retry a native vault wipe that was marked pending by `reset()`.
 * Missing native aliases are treated as clean; real Keychain/Keystore
 * failures propagate so agent initialization cannot continue over a
 * still-resident OS-gated secret.
 */
export async function runPendingVaultResetCleanup(
  storage: CleanupStorageGetSetRemove = new SecureStorageAdapter(),
  nativeVault: { deleteSecret: (alias: string) => Promise<void> } = NativeBiometricVault,
  vaultStorage: { remove: (key: string) => Promise<void> } = new SecureStorageAdapter(),
): Promise<boolean> {
  // Fail closed on storage.get failures so an
  // unreadable sentinel never lets the caller proceed onto a
  // not-yet-cleaned native secret.
  const pending = await storage.get(VAULT_RESET_PENDING_KEY);
  if (pending !== 'true') return true;
  // Re-run the same delete + clear sequence `BiometricVault.reset()`
  // performs. Native modules are idempotent on missing-alias deletes
  // (`promise.resolve(null)` on Android, `errSecItemNotFound` ->
  // resolve on iOS), so retrying is always safe.
  await nativeVault.deleteSecret(WALLET_ROOT_KEY_ALIAS);
  await vaultStorage.remove(INITIALIZED_STORAGE_KEY);
  await vaultStorage.remove(BIOMETRIC_STATE_STORAGE_KEY);
  // Sentinel cleared ONLY after every step succeeded — partial
  // success keeps the sentinel and forces a retry on the next launch.
  try {
    await storage.remove(VAULT_RESET_PENDING_KEY);
  } catch (err) {
    console.warn(
      '[agent-store] runPendingVaultResetCleanup: failed to clear sentinel after successful retry (next launch will re-run the cleanup):',
      err,
    );
  }
  return true;
}

/**
 * re-iterate `STORAGE_KEYS` and remove each key on the
 * `AUTH_RESET_PENDING_KEY` retry path. Mirrors the
 * `runPendingVaultResetCleanup` / `runPendingLevelDbCleanup`
 * pattern: read the sentinel, run the wipe iff set, clear the
 * sentinel only after success.
 *
 * The remove() loop is idempotent — `SecureStorageAdapter.remove()`
 * is a no-op against an already-absent key, so re-running this on
 * a partially-cleaned-up state finishes the wipe without
 * resurrecting any state.
 *
 * Per-key try/catch parity with `useAgentStore.reset()`: a single
 * key's remove() failure does NOT abort the iteration. We capture
 * the first error and continue removing the rest so the wipe is as
 * complete as possible on this attempt; the captured error is
 * rethrown at the end so the caller knows the retry did not fully
 * succeed AND the sentinel stays SET on disk for the next attempt.
 *
 * parity: fail CLOSED on `storage.get` failures so an
 * unreadable sentinel never lets the caller proceed onto stale
 * delegate keys / active identity / registration tokens.
 */
export async function runPendingAuthResetCleanup(
  storage: CleanupStorageGetSetRemove = new SecureStorageAdapter(),
  authStorage: { remove: (key: string) => Promise<void> } = new SecureStorageAdapter(),
): Promise<boolean> {
  const pending = await storage.get(AUTH_RESET_PENDING_KEY);
  if (pending !== 'true') return true;
  let firstRemoveError: unknown = null;
  for (const key of Object.values(AUTH_STORAGE_KEYS)) {
    try {
      await authStorage.remove(key);
    } catch (err) {
      if (firstRemoveError === null) firstRemoveError = err;
      console.warn(
        `[agent-store] runPendingAuthResetCleanup: failed to remove auth storage key "${key}":`,
        err,
      );
    }
  }
  if (firstRemoveError !== null) {
    // Sentinel STAYS SET — the next agent-init flow will retry.
    throw firstRemoveError;
  }
  try {
    await storage.remove(AUTH_RESET_PENDING_KEY);
  } catch (err) {
    console.warn(
      '[agent-store] runPendingAuthResetCleanup: failed to clear sentinel after successful retry (next launch will re-run the cleanup):',
      err,
    );
  }
  return true;
}

/**
 * Run all pending reset cleanups before any agent is initialized.
 *
 * Order matters and reflects the threat model:
 *   1. Vault wipe: stale OS-gated root material must never survive
 *      into a new onboarding flow.
 *   2. LevelDB wipe: stale identity and DWN records must not reload
 *      under the next agent.
 *   3. Auth wipe: stale delegate keys and dApp session metadata must
 *      not carry across a wallet reset.
 */
/**
 * Detect whether reset sentinels are stale rather than proof that
 * destructive cleanup must run. If the vault is still fully provisioned
 * (`INITIALIZED === 'true'` and the native alias exists), startup must
 * keep the wallet intact and leave Settings reset as the only destructive
 * path. Indeterminate reads return false so cleanup retries later.
 */
async function isVaultStateIntact(): Promise<boolean> {
  let initialized: string | null;
  try {
    const sentinelStorage = new SecureStorageAdapter();
    initialized = await sentinelStorage.get(INITIALIZED_STORAGE_KEY);
  } catch (err) {
    console.warn(
      '[agent-store] isVaultStateIntact: SecureStorage read for INITIALIZED failed; assuming "intact" to avoid destroying a possibly-valid vault on indeterminate state:',
      err,
    );
    return true;
  }
  if (initialized !== 'true') {
    // Vault was wiped or never provisioned. Cleanup helpers may run
    // safely; their destructive ops are idempotent on absent state.
    return false;
  }
  let hasSecret: boolean;
  try {
    hasSecret = await NativeBiometricVault.hasSecret(WALLET_ROOT_KEY_ALIAS);
  } catch (err) {
    console.warn(
      '[agent-store] isVaultStateIntact: NativeBiometricVault.hasSecret failed; assuming "intact" to avoid destroying a possibly-valid vault on indeterminate state:',
      err,
    );
    return true;
  }
  return hasSecret;
}

async function runPendingResetCleanups(): Promise<void> {
  // If the vault is still fully provisioned, retry sentinels are stale
  // and must not trigger destructive cleanup on launch.
  if (await isVaultStateIntact()) {
    const sentinelStorage = new SecureStorageAdapter();
    const FALSE_ALARM_KEYS = [
      VAULT_RESET_PENDING_KEY,
      LEVELDB_CLEANUP_PENDING_KEY,
      AUTH_RESET_PENDING_KEY,
      SESSION_RESET_PENDING_KEY,
    ] as const;
    for (const key of FALSE_ALARM_KEYS) {
      try {
        await sentinelStorage.remove(key);
      } catch (err) {
        console.warn(
          `[agent-store] runPendingResetCleanups: vault is intact but failed to clear stale sentinel "${key}" (next launch will retry the same defensive guard):`,
          err,
        );
      }
    }
    return;
  }
  await runPendingVaultResetCleanup();
  await runPendingLevelDbCleanup();
  await runPendingAuthResetCleanup();
}

export interface AgentStore {
  agent: EnboxUserAgent | null;
  authManager: AuthManager | null;
  vault: BiometricVault | null;
  isInitializing: boolean;
  error: string | null;
  /**
   * Last observed biometric state surfaced by the native vault. Stays
   * `null` until the vault reports a definitive state or a flow observes
   * a key-invalidated error. Consumers gate onboarding/restore UI on
   * `'invalidated'` / `'not-enrolled'` / `'unavailable'`.
   */
  biometricState: BiometricState | null;
  recoveryPhrase: string | null;
  identities: BearerIdentity[];

  /**
   * First launch: initialize the biometric vault + create agent DID.
   * Takes NO password — the vault prompts biometrics through the native
   * module. Returns the non-empty recovery phrase produced by the vault.
   */
  initializeFirstLaunch: () => Promise<string>;

  /**
   * Return visit: unlock the biometric vault. Takes NO password — the
   * vault prompts biometrics through the native module.
   */
  unlockAgent: () => Promise<void>;

  /**
   * Rebuild the one-shot recovery phrase for a first-launch wallet whose
   * native secret was provisioned before the user confirmed backup.
   */
  resumePendingBackup: () => Promise<void>;

  /**
   * Recovery path — invoked by `RecoveryRestoreScreen` when the user
   * pastes an existing 12- or 24-word BIP-39 mnemonic after the native
   * secret was invalidated (or after a fresh install on a known
   * wallet).
   *
   * Steps (matches the mission-spec `restoreFromMnemonic` contract):
   *   1. Delete any existing biometric-gated native secret so the vault
   *      can re-initialize from the restored entropy.
   *   2. Create a fresh agent + vault via `initializeAgent()`.
   *   3. Call `agent.initialize({ recoveryPhrase })` which forwards the
   *      phrase to `BiometricVault.initialize()`, re-sealing a new
   *      biometric secret derived from the caller-provided mnemonic.
   *   4. On success flip the store's `biometricState` to `'ready'` and
   *      refresh the identities list. The one-shot `recoveryPhrase`
   *      field is cleared — the user already owns the words that were
   *      just entered; the store must NOT hold them in JS memory.
   *
   * The caller is expected to have already normalized the phrase
   * (trim / lower-case / single-space) and validated it against BIP-39.
   */
  restoreFromMnemonic: (mnemonic: string) => Promise<void>;

  /** Refresh identities list from the agent. */
  refreshIdentities: () => Promise<void>;

  /** Clear the last agent error. */
  clearError: () => void;

  /**
   * Clear the one-shot recovery phrase from the store. Must be called by
   * the UI after the user confirms they have backed up the phrase so the
   * 24 words are no longer resident in JS memory.
   */
  clearRecoveryPhrase: () => void;

  /** Create a new identity. */
  createIdentity: (name: string) => Promise<BearerIdentity>;

  /** Export all identities as portable JSON. */
  exportIdentities: () => Promise<string>;

  /** Import one or more portable identities from JSON. */
  importIdentities: (json: string) => Promise<number>;

  /** Update an identity's local/profile display name. */
  updateIdentityName: (did: string, name: string) => Promise<void>;

  /** Delete an identity from local wallet storage. */
  deleteIdentity: (did: string) => Promise<void>;

  /** Tear down agent (on lock or reset). */
  teardown: () => void;

  /**
   * Full wallet reset. Deletes the biometric-gated native secret, clears
   * the in-memory agent store (`teardown`), and clears persisted session
   * state (`useSessionStore.reset`). Idempotent — safe to call multiple
   * times even if no vault is initialized.
   *
   * After reset, a subsequent `initializeFirstLaunch()` starts onboarding
   * from scratch and will yield a new (different) mnemonic and DID.
   */
  reset: () => Promise<void>;
}

/**
 * Safely determine whether the agent's `agentDid` property has been
 * assigned. Upstream `EnboxUserAgent` exposes `agentDid` as a getter
 * that THROWS when the underlying `_agentDid` private field is still
 * `undefined` (the default between `new EnboxUserAgent({ ... })` and
 * the first `start()` call). Calling code — in particular
 * `AgentIdentityApi.list()` via the `tenant` getter — dereferences
 * `agent.agentDid.uri` unconditionally, so invoking it during the
 * short window after `agent.initialize({})` returns but before
 * `agent.start({})` has assigned the DID from `vault.getDid()` produces
 * a benign but noisy W-level log line:
 *
 *     [agent] identity list failed: ... The "agentDid" property is not set.
 *
 * `refreshIdentities()` below gates on this helper so callers that
 * fire optimistically (navigation-change effects, manual refresh) can
 * skip the call silently instead of warning. The helper treats any
 * throw from the getter, or a missing `.uri`, as "not yet assigned".
 */
function hasAgentDid(agent: EnboxUserAgent | null): boolean {
  if (!agent) return false;
  try {
    // Access the getter inside try/catch so upstream's
    // `_agentDid === undefined` throw is turned into a boolean.
    const did = (agent as unknown as { agentDid?: { uri?: string } }).agentDid;
    return Boolean(did && typeof did.uri === 'string' && did.uri.length > 0);
  } catch {
    return false;
  }
}

/**
 * Polling-retry configuration for the `refreshIdentities()` race gate.
 *
 * When `refreshIdentities()` is called in the short window between
 * `agent.initialize({})` returning and `agent.start({})` assigning
 * `agentDid` via `vault.getDid()`, the race gate (see `hasAgentDid`)
 * causes a silent early-return. Without a retry, the store's
 * `identities` list could remain stale if no later path happens to
 * retrigger a refresh.
 *
 * The poller closes that correctness gap: on every early-skip we (at
 * most once per agent) start a `setInterval` that polls `hasAgentDid`
 * every `AGENT_DID_POLL_INTERVAL_MS` for up to `AGENT_DID_POLL_MAX_MS`.
 * As soon as the DID is observed, the poller stops and
 * `refreshIdentities()` is retriggered. If the cap is reached without
 * the DID becoming available, the poller gives up cleanly — no
 * `identity.list()` call was ever made so no warning is emitted.
 *
 * The state is module-scoped (not stored in zustand) because it is
 * purely an ephemeral coordination primitive between polling ticks and
 * the teardown path; leaking it into persisted state would serve no
 * purpose and could introduce a re-hydration edge case.
 */
const AGENT_DID_POLL_INTERVAL_MS = 50;
const AGENT_DID_POLL_MAX_ITERATIONS = 40; // 40 * 50ms = 2000ms cap

interface PendingIdentityPoller {
  intervalId: ReturnType<typeof setInterval>;
  agent: EnboxUserAgent;
}

let pendingIdentityPoller: PendingIdentityPoller | null = null;

/**
 * Cancel any in-flight `refreshIdentities()` retry poller. Called from
 * `teardown()` so `useAutoLock` (or an explicit lock / reset) never
 * leaves a timer leaking.
 *
 * Idempotent — safe to call when no poller is running.
 */
function stopPendingIdentityPoller(): void {
  if (pendingIdentityPoller !== null) {
    clearInterval(pendingIdentityPoller.intervalId);
    pendingIdentityPoller = null;
  }
}

/**
 * Start polling for `agent.agentDid` assignment. The first call for a
 * given `agent` wins; subsequent calls are no-ops (idempotent). When
 * `agentDid` is observed, `retrigger` is invoked so the caller can
 * resubmit `refreshIdentities()`. When the `AGENT_DID_POLL_MAX_MS`
 * cap is reached, the poller gives up silently (no warning, no
 * retrigger).
 *
 * The poller also exits early if the store's `agent` field no longer
 * matches the agent we were tracking (teardown, lock, or a store-level
 * replacement by a subsequent unlock).
 */
function startPendingIdentityPoller(
  agent: EnboxUserAgent,
  getStoreAgent: () => EnboxUserAgent | null,
  retrigger: () => void,
): void {
  // Idempotency: if a poller is already active for ANY agent, don't
  // start another one. The existing poller will either observe the DID
  // or cap out on its own.
  if (pendingIdentityPoller !== null) return;

  let iterations = 0;
  const intervalId = setInterval(() => {
    iterations += 1;

    // Store agent was replaced or torn down — stop without retrigger.
    if (getStoreAgent() !== agent) {
      stopPendingIdentityPoller();
      return;
    }

    if (hasAgentDid(agent)) {
      stopPendingIdentityPoller();
      retrigger();
      return;
    }

    if (iterations >= AGENT_DID_POLL_MAX_ITERATIONS) {
      stopPendingIdentityPoller();
    }
  }, AGENT_DID_POLL_INTERVAL_MS);

  pendingIdentityPoller = { intervalId, agent };
}

/**
 * Test-only accessor for the poller state. Exported so unit tests can
 * assert idempotency without reaching into private module state.
 * Returns `null` when no poller is active.
 */
export function __getPendingIdentityPollerForTests(): PendingIdentityPoller | null {
  return pendingIdentityPoller;
}

/**
 * Preserve the native error's `.code` while wrapping it into a short
 * store-facing error string. We intentionally re-throw the original
 * error so the caller still receives `.code === 'VAULT_ERROR_*'`.
 */
function messageFromError(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return err.message ? `${code}: ${err.message}` : code;
    }
    if (err.message) {
      return err.message;
    }
  }
  return fallback;
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  agent: null,
  authManager: null,
  vault: null,
  isInitializing: false,
  error: null,
  biometricState: null,
  recoveryPhrase: null,
  identities: [],

  initializeFirstLaunch: async () => {
    set({ isInitializing: true, error: null });
    // Hold a local reference to the vault so the catch path can
    // defensively `lock()` it if `initialize({})` / `start({})`
    // unlocked the vault before a later step threw. The same
    // residency-window argument applies to first-launch as to unlock.
    let vaultRef: { lock?: () => Promise<void>; unlock?: (params?: any) => Promise<void> } | null = null;
    try {
      // Retry pending reset cleanups before creating the agent. Both
      // helpers are fail-CLOSED — if the retry rejects we throw before opening
      // the LevelDB handle OR provisioning a new vault, so a stale
      // identity / DWN record / OS-gated secret can never resurrect
      // into a fresh wallet.
      await runPendingResetCleanups();
      debugLog('[agent-store] initializeFirstLaunch: creating agent...');
      const { agent, authManager, vault } = await initializeAgent();
      vaultRef = vault;

      debugLog('[agent-store] checking firstLaunch...');
      const isFirst = await agent.firstLaunch();
      debugLog('[agent-store] firstLaunch:', isFirst);

      let recoveryPhrase: string;
      if (isFirst) {
        debugLog('[agent-store] initializing vault (biometric prompt)...');
        // BiometricVault has no password. `AgentInitializeParams.password`
        // is widened to optional by `scripts/apply-patches.mjs`'s
        // `patchEnboxAgentPasswordOptional()` so the call site does NOT
        // need to carry a `password` property.
        recoveryPhrase = await agent.initialize({
          dwnEndpoints: DEFAULT_DWN_ENDPOINTS,
        });
        debugLog('[agent-store] vault initialized.');
        // Upstream `EnboxUserAgent.initialize()` does NOT assign
        // `agentDid` (only `start()` does). Without this assignment the
        // `refreshIdentities()` race gate would early-return and the
        // 2s retry poller would time out, leaving the store's
        // identities list empty after a genuine first-launch flow. The
        // vault is already unlocked in memory from the preceding
        // biometric prompt inside `initialize()`, so `vault.getDid()`
        // resolves synchronously from the in-memory BearerDid — no
        // second biometric prompt is triggered here.
        try {
          const bearerDid = await vault.getDid();
          (agent as unknown as { agentDid?: { uri: string } }).agentDid =
            bearerDid as unknown as { uri: string };
        } catch (err) {
          console.warn(
            '[agent-store] initializeFirstLaunch: could not assign agentDid',
            err,
          );
        }
      } else {
        debugLog('[agent-store] starting existing vault (biometric prompt)...');
        await agent.start({});
        recoveryPhrase = '';
      }

      set({
        agent,
        authManager,
        vault,
        isInitializing: false,
        recoveryPhrase,
        biometricState: 'ready',
      });
      // Keep sync startup off the critical onboarding path; recovery phrase
      // display must not wait on remote DWN availability.
      // eslint-disable-next-line no-void
      void ensurePostSession(agent).catch(() => {});
      get().refreshIdentities().catch(() => {});
      return recoveryPhrase;
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      const message = messageFromError(err, 'Agent initialization failed');
      if (code === BIOMETRICS_UNAVAILABLE_CODE) {
        console.warn('[agent-store] first launch blocked: biometrics unavailable');
      } else {
        console.error('[agent-store] first launch failed:', message);
      }
      // Defensive zeroization of unlocked vault material — see the
      // analogous block in `unlockAgent()` for the rationale. If
      // `agent.initialize({})` / `agent.start({})` populated the
      // vault's in-memory `_secretBytes` / `_rootSeed` / CEK and a
      // LATER step threw (e.g. the `getDid()` assignment fails for
      // an unforeseen reason, or the success-path `set(...)` is
      // pre-empted), the unlocked buffers remain on the vault until
      // GC. Calling `lock()` here scrubs them immediately. Best-
      // effort: a `lock()` rejection is logged but never re-thrown so
      // the caller still sees the original failure.
      if (typeof vaultRef?.lock === 'function') {
        // eslint-disable-next-line no-void
        void vaultRef.lock().catch((lockErr) => {
          console.warn(
            '[agent-store] initializeFirstLaunch: defensive vault.lock() failed (ignored):',
            lockErr,
          );
        });
      }
      let nextBiometricState = get().biometricState;
      if (code === BIOMETRICS_UNAVAILABLE_CODE) {
        nextBiometricState = 'unavailable';
      } else if (code === KEY_INVALIDATED_CODE) {
        nextBiometricState = 'invalidated';
      }
      set({
        error: message,
        isInitializing: false,
        agent: null,
        authManager: null,
        vault: null,
        biometricState: nextBiometricState,
      });
      throw err;
    }
  },

  unlockAgent: async () => {
    set({ isInitializing: true, error: null });
    // Hold a local reference to the vault so the catch path can lock
    // it even when the throw happens AFTER `initializeAgent()` has
    // returned. Without this we'd only have the store reference,
    // which the failure cleanup overwrites to `null` — leaking any
    // unlocked secret bytes/root seed/CEK that `agent.start({})`
    // populated before the later step threw.
    let vaultRef: { lock: () => Promise<void> } | null = null;
    try {
      // Retry pending reset cleanups before creating the agent.
      await runPendingResetCleanups();
      debugLog('[agent-store] unlockAgent: creating agent...');
      const { agent, authManager, vault } = await initializeAgent();
      vaultRef = vault;
      debugLog('[agent-store] starting vault (biometric prompt)...');
      // BiometricVault has no password. `AgentStartParams.password` is
      // widened to optional by `scripts/apply-patches.mjs`'s
      // `patchEnboxAgentPasswordOptional()` so the call site does NOT
      // need to carry a `password` property.
      await agent.start({});
      debugLog('[agent-store] vault started.');
      set({
        agent,
        authManager,
        vault,
        isInitializing: false,
        biometricState: 'ready',
      });

      // eslint-disable-next-line no-void
      void ensurePostSession(agent).catch(() => {});
      get().refreshIdentities().catch(() => {});
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      const message = messageFromError(err, 'Agent unlock failed');
      if (code === BIOMETRICS_UNAVAILABLE_CODE) {
        console.warn('[agent-store] unlock blocked: biometrics unavailable');
      } else if (code === KEY_INVALIDATED_CODE) {
        console.warn('[agent-store] unlock blocked: biometric key invalidated');
      } else {
        console.error('[agent-store] unlock failed:', message);
      }
      // Defensive zeroization: if `agent.start({})` already unlocked
      // the vault and a LATER step inside the try block threw (or
      // even the success-path `set(...)` somehow did), the unlocked
      // `_secretBytes`, `_rootSeed`, and CEK still live in the
      // BiometricVault instance. Without this lock() the store-
      // reference-drop below is the only cleanup, and the GC has no
      // way to scrub the buffers — they sit in heap memory until the
      // Hermes GC reclaims them, which can be many seconds and is a
      // documented residency window the spec wants closed.
      // Best-effort: a `lock()` rejection is logged but never
      // re-throws so the original error is the one the caller sees.
      if (vaultRef !== null) {
        // eslint-disable-next-line no-void
        void vaultRef.lock().catch((lockErr) => {
          console.warn(
            '[agent-store] unlockAgent: defensive vault.lock() failed (ignored):',
            lockErr,
          );
        });
      }
      let nextBiometricState = get().biometricState;
      if (code === BIOMETRICS_UNAVAILABLE_CODE) {
        nextBiometricState = 'unavailable';
      } else if (code === KEY_INVALIDATED_CODE) {
        nextBiometricState = 'invalidated';
      }
      set({
        error: message,
        isInitializing: false,
        agent: null,
        authManager: null,
        vault: null,
        biometricState: nextBiometricState,
      });
      throw err;
    }
  },

  resumePendingBackup: async () => {
    set({ isInitializing: true, error: null });
    // Local vault reference for the catch path's defensive lock.
    // `resumePendingBackup()` unlocks the vault to re-derive the
    // mnemonic. If any step AFTER `agent.start({})` (e.g.
    // `vault.getMnemonic()` or the mid-flight
    // `set(...)`) throws, the unlocked entropy stays resident in
    // memory until GC unless we explicitly call `lock()`.
    let vaultRef: { lock: () => Promise<void> } | null = null;
    try {
      // Retry reset cleanups before creating the agent. If a user hit
      // "Reset wallet" mid-backup-pending session and the wipe failed,
      // the next backup resume must not open stale ENBOX_AGENT LevelDB
      // data or unlock the stale OS-gated secret.
      await runPendingResetCleanups();
      debugLog('[agent-store] resumePendingBackup: creating agent...');
      const { agent, authManager, vault } = await initializeAgent();
      vaultRef = vault;
      debugLog(
        '[agent-store] resumePendingBackup: starting vault (biometric prompt)...',
      );
      // `agent.start({})` forwards to `BiometricVault.unlock()` which
      // prompts biometrics once and populates the vault's in-memory
      // `_secretBytes` buffer. The subsequent `getMnemonic()` call
      // does NOT re-prompt — it reads the already-in-memory entropy.
      if (typeof vault.unlock === 'function') {
        await vault.unlock({ retainSecretForBackup: true } as any);
      } else {
        await agent.start({});
      }
      try {
        const bearerDid = await vault.getDid();
        (agent as unknown as { agentDid?: { uri: string } }).agentDid =
          bearerDid as unknown as { uri: string };
      } catch (err) {
        console.warn(
          '[agent-store] resumePendingBackup: could not assign agentDid',
          err,
        );
      }
      const recoveryPhrase = await vault.getMnemonic();
      debugLog('[agent-store] resumePendingBackup: mnemonic re-derived.');

      set({
        agent,
        authManager,
        vault,
        isInitializing: false,
        biometricState: 'ready',
        recoveryPhrase,
      });

      // eslint-disable-next-line no-void
      void ensurePostSession(agent).catch(() => {});

      get()
        .refreshIdentities()
        .catch(() => {});
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      const message = messageFromError(err, 'Backup resume failed');
      if (code === BIOMETRICS_UNAVAILABLE_CODE) {
        console.warn(
          '[agent-store] resumePendingBackup blocked: biometrics unavailable',
        );
      } else if (code === KEY_INVALIDATED_CODE) {
        console.warn(
          '[agent-store] resumePendingBackup blocked: biometric key invalidated',
        );
      } else {
        console.error('[agent-store] resumePendingBackup failed:', message);
      }
      // See unlockAgent / initializeFirstLaunch catch blocks for the
      // residency-window argument. If `agent.start({})` already
      // unlocked the vault and `vault.getMnemonic()` then threw (or
      // the success-path `set(...)` was pre-empted), the unlocked
      // buffers (and the freshly re-derived mnemonic) live on the
      // vault instance until GC. Best-effort lock() scrubs them.
      if (typeof vaultRef?.lock === 'function') {
        // eslint-disable-next-line no-void
        void vaultRef.lock().catch((lockErr) => {
          console.warn(
            '[agent-store] resumePendingBackup: defensive vault.lock() failed (ignored):',
            lockErr,
          );
        });
      }
      let nextBiometricState = get().biometricState;
      if (code === BIOMETRICS_UNAVAILABLE_CODE) {
        nextBiometricState = 'unavailable';
      } else if (code === KEY_INVALIDATED_CODE) {
        nextBiometricState = 'invalidated';
      }
      set({
        error: message,
        isInitializing: false,
        agent: null,
        authManager: null,
        vault: null,
        biometricState: nextBiometricState,
      });
      throw err;
    }
  },

  restoreFromMnemonic: async (mnemonic: string) => {
    // Validate before any store mutation or native wipe so an invalid
    // mnemonic cannot destroy the user's current working wallet.
    const trimmed = mnemonic.trim();
    if (!trimmed || !validateMnemonic(trimmed, wordlist)) {
      const err = Object.assign(
        new Error('Provided recovery phrase is not a valid BIP-39 mnemonic'),
        { code: 'VAULT_ERROR_INVALID_MNEMONIC' as const },
      );
      throw err;
    }

    // Destructive restore starts only after the mnemonic is valid.
    set({ isInitializing: true, error: null });
    // Local vault reference for the catch path's defensive lock. Inside
    // the destructive phase, `agent.initialize({recoveryPhrase})` calls
    // `BiometricVault.initialize({recoveryPhrase})` which lands the
    // 32-byte root entropy + derived HD seed + CEK into the vault's
    // private fields BEFORE returning. If a LATER step throws (e.g.
    // `vault.getDid()` or the success-path `set(...)`), nulling the
    // store reference alone leaves the unlocked vault in heap memory
    // until GC. An explicit `lock()` zeroes those buffers
    // synchronously so a heap snapshot taken between the throw and
    // the next `restoreFromMnemonic()` retry cannot leak the
    // restored entropy.
    let vaultRef: { lock?: () => Promise<void> } | null = null;
    try {
      // Retry any pending cleanup before creating the agent. Restore is
      // the most important place to enforce both: a user typing a
      // recovery phrase MUST land on a clean DWN/identity store AND
      // must not have a stale prior-wallet OS-gated secret blocking
      // the new vault's `initialize({ recoveryPhrase })` (the
      // `deleteSecret()` block below is best-effort and would fail
      // open if the prior wallet's secret survived a failed reset).
      await runPendingResetCleanups();
      // Wipe any prior biometric-gated secret so the vault's
      // `initialize({ recoveryPhrase })` path won't fast-fail with
      // `VAULT_ERROR_ALREADY_INITIALIZED`. Best-effort — a missing
      // alias resolves as success on both iOS and Android.
      await NativeBiometricVault.deleteSecret(WALLET_ROOT_KEY_ALIAS);

      // Create a fresh agent + vault. We do NOT reuse any existing
      // instance — the old state is tied to the now-invalid secret
      // and the agent's internal DWN layer must be wired against a
      // vault whose BearerDid matches the restored entropy.
      debugLog('[agent-store] restoreFromMnemonic: creating agent...');
      const { agent, authManager, vault } = await initializeAgent();
      vaultRef = vault;

      // Re-seal the biometric vault with the caller-provided
      //    mnemonic. `agent.initialize` forwards `recoveryPhrase`
      //    straight into `BiometricVault.initialize` which derives the
      //    entropy, calls `NativeBiometricVault.generateAndStoreSecret`,
      //    and rebuilds the HD seed / BearerDid in memory. Any native
      //    rejection is mapped to a canonical VAULT_ERROR_* and
      //    surfaced via the screen. `AgentInitializeParams.password` is
      //    widened to optional by the postinstall patch, so we omit it.
      await agent.initialize({
        recoveryPhrase: trimmed,
        dwnEndpoints: DEFAULT_DWN_ENDPOINTS,
      });

      // Upstream `EnboxUserAgent.initialize()` does NOT assign
      // `agentDid` — only `start()` does (`this.agentDid = await
      // this.vault.getDid()`). Because the restore flow never calls
      // `agent.start()`, the subsequent `refreshIdentities()` race
      // gate would early-return and the 2s retry poller would time
      // out, leaving restored wallets with a stale / empty identity
      // list even though the vault is fully provisioned. Assign
      // `agentDid` directly from `vault.getDid()` here — the vault is
      // already unlocked in memory from the preceding biometric prompt
      // inside `initialize({ recoveryPhrase })`, so this does NOT
      // trigger a second biometric prompt. The try/catch keeps the
      // restore flow resilient against an unexpected `getDid()` throw.
      try {
        const bearerDid = await vault.getDid();
        (agent as unknown as { agentDid?: { uri: string } }).agentDid =
          bearerDid as unknown as { uri: string };
      } catch (err) {
        console.warn(
          '[agent-store] restoreFromMnemonic: could not assign agentDid',
          err,
        );
      }

      await recoverWalletFromSync(agent, DEFAULT_DWN_ENDPOINTS);

      set({
        agent,
        authManager,
        vault,
        isInitializing: false,
        biometricState: 'ready',
        // Do NOT mirror the restored mnemonic into the store — the
        // user already knows it (they just typed it) and persisting it
        // in JS memory would violate the one-shot recovery-phrase
        // contract (VAL-VAULT-018). `recoveryPhrase` stays `null`.
        recoveryPhrase: null,
      });

      get()
        .refreshIdentities()
        .catch(() => {});
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      const message = messageFromError(err, 'Wallet restore failed');
      if (code === BIOMETRICS_UNAVAILABLE_CODE) {
        console.warn('[agent-store] restore blocked: biometrics unavailable');
      } else if (code === KEY_INVALIDATED_CODE) {
        console.warn('[agent-store] restore blocked: biometric key invalidated');
      } else {
        console.error('[agent-store] restoreFromMnemonic failed:', message);
      }
      // Defensive zeroization parallels `unlockAgent()` /
      // `resumePendingBackup()`. If `agent.initialize({recoveryPhrase})`
      // already ran (so the vault holds restored 32-byte entropy / HD
      // seed / CEK in private fields) and a later step inside the
      // try block threw, the store-reference null below is the only
      // cleanup, and Hermes GC can take many seconds before the
      // buffers are reclaimed. Calling `lock()` zeroes those buffers
      // synchronously so the residency window between rejection and
      // the next retry / app close is closed. A `lock()` rejection
      // is logged but never re-throws so the original restore error
      // remains the one the caller observes.
      if (typeof vaultRef?.lock === 'function') {
        // eslint-disable-next-line no-void
        void vaultRef.lock().catch((lockErr) => {
          console.warn(
            '[agent-store] restoreFromMnemonic: defensive vault.lock() failed (ignored):',
            lockErr,
          );
        });
      }
      let nextBiometricState = get().biometricState;
      if (code === BIOMETRICS_UNAVAILABLE_CODE) {
        nextBiometricState = 'unavailable';
      } else if (code === KEY_INVALIDATED_CODE) {
        nextBiometricState = 'invalidated';
      }
      set({
        error: message,
        isInitializing: false,
        agent: null,
        authManager: null,
        vault: null,
        biometricState: nextBiometricState,
      });
      throw err;
    }
  },

  refreshIdentities: async () => {
    const { agent } = get();
    if (!agent) return;

    // Race gate: `agent.identity.list()` dereferences `agent.agentDid.uri`
    // (via `AgentIdentityApi`'s `tenant` getter). Upstream leaves
    // `_agentDid` unset until the first `start()` call assigns it from
    // `vault.getDid()`; calls that land in the short window between
    // `agent.initialize({})` returning and that assignment happening
    // would otherwise log a benign W-level warning. Skip silently
    // until the DID is observed, and kick off a short-lived poller so
    // the refresh retrigger happens automatically when `agentDid`
    // becomes available — even if no other caller happens to fire a
    // follow-up `refreshIdentities()`.
    if (!hasAgentDid(agent)) {
      startPendingIdentityPoller(
        agent,
        () => get().agent,
        () => {
          get().refreshIdentities().catch(() => {});
        },
      );
      return;
    }

    // DID is now observable — any lingering poller is redundant.
    stopPendingIdentityPoller();

    try {
      const identities = await agent.identity.list();
      set({ identities });
    } catch (err) {
      console.warn('[agent] identity list failed:', err);
    }
  },

  clearError: () => {
    set({ error: null });
  },

  clearRecoveryPhrase: () => {
    set({ recoveryPhrase: null });
  },

  createIdentity: async (name) => {
    const { agent } = get();
    if (!agent) throw new Error('Agent not initialized');

    const identity = await createMobileIdentity(agent, { persona: name });

    // Refresh the list
    await get().refreshIdentities();
    return identity;
  },

  exportIdentities: async () => {
    const { agent } = get();
    if (!agent) throw new Error('Agent not initialized');
    const identities = await agent.identity.list();
    const exported = [];
    for (const identity of identities) {
      exported.push(await agent.identity.export({ didUri: identity.did.uri }));
    }
    return JSON.stringify(exported, null, 2);
  },

  importIdentities: async (json) => {
    const { agent } = get();
    if (!agent) throw new Error('Agent not initialized');
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('Backup JSON is not valid');
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (items.length === 0) throw new Error('Backup JSON contains no identities');

    let imported = 0;
    for (const item of items) {
      await importMobileIdentity(agent, item);
      imported += 1;
    }
    await get().refreshIdentities();
    return imported;
  },

  updateIdentityName: async (did, name) => {
    const { agent } = get();
    if (!agent) throw new Error('Agent not initialized');
    await updateMobileIdentityName(agent, did, name);
    await get().refreshIdentities();
  },

  deleteIdentity: async (did) => {
    const { agent } = get();
    if (!agent) throw new Error('Agent not initialized');
    await deleteMobileIdentity(agent, did);
    await get().refreshIdentities();
  },

  teardown: () => {
    // Cancel the refreshIdentities() agentDid-race poller (if any) so
    // background / lock / reset paths never leak an interval. The stop
    // helper is idempotent so calling it when no poller is active is
    // a cheap no-op.
    stopPendingIdentityPoller();

    // Actively zero the vault's in-memory sensitive buffers
    // (`_secretBytes`, `_rootSeed`, `_contentEncryptionKey`) BEFORE we
    // drop the store reference. Without this step (VAL-VAULT-022),
    // releasing the `vault` reference only makes the material GC-eligible
    // — the underlying `Uint8Array`s can linger in the JS heap until a
    // collection cycle, and heap snapshots taken while the app is backgrounded
    // can still expose the root entropy. `vault.lock()` synchronously calls
    // the vault's internal `_clearInMemoryState()` helper which fills the
    // buffers with zeroes before nulling the typed-array handles. The call
    // is best-effort — if the vault object has already been locked the method
    // is a no-op, and any unexpected throw is logged and swallowed so
    // teardown still completes (auto-lock on background MUST NOT partially
    // fail and strand the store in a half-torn-down state).
    const { agent, vault } = get();
    if (agent) {
      // eslint-disable-next-line no-void
      void stopWalletSync(agent as any).catch(() => {});
    }
    if (vault && typeof vault.lock === 'function') {
      try {
        // `BiometricVault.lock()` returns a Promise but only because the
        // `IdentityVault` interface requires it — the implementation itself
        // is synchronous. We deliberately do NOT `await` here to preserve
        // the synchronous contract of `teardown()` that the auto-lock hook
        // test relies on; the buffer zeroing has already happened before the
        // Promise resolves.
        // `void` marks a deliberately-unawaited fire-and-forget promise.
        // eslint-disable-next-line no-void
        void vault.lock().catch((err) => {
          console.warn(
            '[agent-store] teardown: vault.lock() rejected (ignored):',
            err,
          );
        });
      } catch (err) {
        console.warn(
          '[agent-store] teardown: vault.lock() threw synchronously (ignored):',
          err,
        );
      }
    }

    set({
      agent: null,
      authManager: null,
      vault: null,
      isInitializing: false,
      error: null,
      recoveryPhrase: null,
      identities: [],
    });
  },

  reset: async () => {
    const { agent, vault } = get();

    // Persist retry sentinels before destructive work begins. The writes
    // stay sequential because SecureStorageAdapter tracks keys with a
    // read-modify-write index.
    const sentinelStorage = new SecureStorageAdapter();
    const SENTINEL_KEYS = [
      VAULT_RESET_PENDING_KEY,
      LEVELDB_CLEANUP_PENDING_KEY,
      AUTH_RESET_PENDING_KEY,
      SESSION_RESET_PENDING_KEY,
    ] as const;
    let firstSentinelWriteError: unknown = null;
    for (const key of SENTINEL_KEYS) {
      try {
        await sentinelStorage.set(key, 'true');
      } catch (err) {
        firstSentinelWriteError = err;
        break; // fail-fast: stop attempting further sentinels
      }
    }
    if (firstSentinelWriteError !== null) {
      // Roll back all sentinels, including partial-success writes where
      // NativeSecureStorage.setItem landed but key-index tracking threw.
      const rollbackFailures: Array<{ key: string; error: unknown }> = [];
      for (const key of SENTINEL_KEYS) {
        try {
          await sentinelStorage.remove(key);
        } catch (rollbackErr) {
          rollbackFailures.push({ key, error: rollbackErr });
          console.warn(
            `[agent-store] reset: failed to roll back retry sentinel "${key}" after a sentinel write failure:`,
            rollbackErr,
          );
        }
      }
      console.warn(
        '[agent-store] reset: refusing to start wipe — retry-sentinel persistence failed (failing closed so a partial reset cannot leak past a non-existent retry path):',
        firstSentinelWriteError,
      );
      if (rollbackFailures.length > 0) {
        const failedKeys = rollbackFailures.map((f) => f.key).join(', ');
        const primaryMsg =
          firstSentinelWriteError instanceof Error
            ? firstSentinelWriteError.message
            : String(firstSentinelWriteError);
        const aggregate = new Error(
          `useAgentStore.reset(): retry-sentinel write failed AND rollback could ` +
            `not remove ${rollbackFailures.length} stale sentinel value(s) ` +
            `(${failedKeys}). The next cold launch's runPendingResetCleanups() ` +
            `vault-intact defensive guard will detect the stale ` +
            `sentinels and clear them WITHOUT destroying wallet data so long as ` +
            `INITIALIZED + hasSecret remain consistent on disk. Underlying ` +
            `sentinel-write failure: ${primaryMsg}`,
        );
        (aggregate as unknown as { cause?: unknown }).cause =
          firstSentinelWriteError;
        (
          aggregate as unknown as { rollbackFailures?: typeof rollbackFailures }
        ).rollbackFailures = rollbackFailures;
        throw aggregate;
      }
      throw firstSentinelWriteError;
    }

    // Wipe the biometric secret and vault-visible SecureStorage flags.
    // If this fails, leave LevelDB/auth intact to avoid a mixed
    // partial-reset state with an intact vault and erased app data.
    let vaultResetError: unknown = null;
    if (vault) {
      try {
        await vault.reset();
      } catch (err) {
        vaultResetError = err;
        console.warn('[agent-store] reset: vault.reset failed:', err);
      }
    } else {
      try {
        await NativeBiometricVault.deleteSecret(WALLET_ROOT_KEY_ALIAS);
      } catch (err) {
        vaultResetError = err;
        console.warn(
          '[agent-store] reset: native deleteSecret failed:',
          err,
        );
      }
      if (vaultResetError === null) {
        const fallbackStorage = new SecureStorageAdapter();
        try {
          await fallbackStorage.remove(INITIALIZED_STORAGE_KEY);
        } catch (err) {
          if (vaultResetError === null) vaultResetError = err;
          console.warn(
            '[agent-store] reset: no-vault fallback clear initialized failed:',
            err,
          );
        }
        try {
          await fallbackStorage.remove(BIOMETRIC_STATE_STORAGE_KEY);
        } catch (err) {
          if (vaultResetError === null) vaultResetError = err;
          console.warn(
            '[agent-store] reset: no-vault fallback clear biometric-state failed:',
            err,
          );
        }
      }
    }
    if (vaultResetError === null) {
      // A sentinel-clear failure only causes a no-op retry next launch.
      try {
        await sentinelStorage.remove(VAULT_RESET_PENDING_KEY);
      } catch (err) {
        console.warn(
          '[agent-store] reset: failed to clear vault-reset sentinel after successful wipe (next launch will run a no-op cleanup retry):',
          err,
        );
      }
    }

    if (vaultResetError === null && agent) {
      await stopWalletSync(agent as any);
    }

    // Wipe ENBOX_AGENT LevelDB only after the vault wipe succeeds.
    let levelDbError: unknown = null;
    if (vaultResetError === null) {
      try {
        await destroyAgentLevelDatabases(AGENT_DATA_PATH);
        try {
          await sentinelStorage.remove(LEVELDB_CLEANUP_PENDING_KEY);
        } catch (err) {
          console.warn(
            '[agent-store] reset: failed to clear LevelDB sentinel after successful wipe (next launch will run a no-op cleanup retry):',
            err,
          );
        }
      } catch (err) {
        levelDbError = err;
        console.warn(
          '[agent-store] reset: LevelDB wipe failed; cleanup sentinel stays set for next-launch retry:',
          err,
        );
      }
    } else {
      console.warn(
        '[agent-store] reset: skipping LevelDB wipe because the biometric vault wipe failed; preserving the rest of the wallet avoids a mixed partial-reset state.',
      );
    }

    // Wipe AuthManager / Web5 connect material without calling clear(),
    // which would also remove retry sentinels and session-store keys.
    let authResetError: unknown = null;
    const authStorage = new SecureStorageAdapter();
    if (vaultResetError === null) {
      for (const key of Object.values(AUTH_STORAGE_KEYS)) {
        try {
          await authStorage.remove(key);
        } catch (err) {
          if (authResetError === null) authResetError = err;
          console.warn(
            `[agent-store] reset: failed to remove auth storage key "${key}":`,
            err,
          );
        }
      }
      if (authResetError === null) {
        // A sentinel-clear failure only causes a no-op retry next launch.
        try {
          await sentinelStorage.remove(AUTH_RESET_PENDING_KEY);
        } catch (err) {
          console.warn(
            '[agent-store] reset: failed to clear auth-reset sentinel after successful wipe (next launch will run a no-op cleanup retry):',
            err,
          );
        }
      }
    } else {
      console.warn(
        '[agent-store] reset: skipping auth wipe because the biometric vault wipe failed; preserving auth state with the intact vault avoids a mixed partial-reset state.',
      );
    }

    // Always clear in-memory refs, even when durable cleanup failed.
    get().teardown();

    // Reset session state only after all durable wallet wipes succeed.
    // SESSION_RESET_PENDING_KEY guards the next launch if SESSION_KEY
    // could still contain a stale `hasIdentity=true` snapshot.
    let sessionResetError: unknown = null;
    if (
      vaultResetError === null &&
      levelDbError === null &&
      authResetError === null
    ) {
      try {
        await useSessionStore.getState().reset();
      } catch (err) {
        sessionResetError = err;
        console.warn('[agent-store] reset: session-store reset failed:', err);
      }
      // Clear only after session.reset() proves SESSION_KEY is gone.
      if (sessionResetError === null) {
        try {
          await sentinelStorage.remove(SESSION_RESET_PENDING_KEY);
        } catch (err) {
          console.warn(
            '[agent-store] reset: failed to clear session-reset sentinel after successful wipe (next launch will run a no-op cleanup retry):',
            err,
          );
        }
      }
    } else {
      console.warn(
        '[agent-store] reset: skipping session-store reset because a critical wipe failed; the user stays on the current route so the failure alert can render against a stable navigator. Retry sentinels handle next-launch recovery.',
      );
      // Keep the session sentinel set on any critical wipe failure.
    }

    // Rethrow the most important cleanup failure after in-memory teardown.
    // Precedence follows the impact of surviving data:
    //      1. `vaultResetError` — privacy-critical surviving secret.
    //      2. `levelDbError`    — correctness-critical surviving
    //                              identities / DWN records.
    //      3. `authResetError`  — privacy-critical surviving auth
    //                              material (delegate keys, active
    //                              identity DID, registration tokens).
    //                              Ranks above session because
    //                              delegate keys can re-authorise the
    //                              new wallet under the old wallet's
    //                              connected dApps.
    //      4. `sessionResetError` — last-priority misroute risk.
    if (vaultResetError !== null) {
      throw vaultResetError;
    }
    if (levelDbError !== null) {
      throw levelDbError;
    }
    if (authResetError !== null) {
      throw authResetError;
    }
    if (sessionResetError !== null) {
      throw sessionResetError;
    }
  },
}));

/**
 * Dev-only helper that produces a JSON-serialized snapshot of the agent
 * store's state suitable for sending to a devtools inspector (Flipper,
 * redux-devtools, …) or an ad-hoc debug log line. The helper MUST be
 * used by every dev-time logger that wants to inspect agent-store state
 * — inlining `JSON.stringify(useAgentStore.getState())` bypasses this
 * sanitizer and would leak the memory-only `recoveryPhrase` field.
 *
 * Sanitization rules (VAL-CROSS-013):
 *   - `recoveryPhrase` is replaced with `'<redacted>'` when non-null
 *     (kept as `null` when already cleared).
 *   - `agent` / `authManager` / `vault` instances are reduced to
 *     opaque `'<agent>' | '<authManager>' | '<vault>'` placeholders so
 *     arbitrary internal fields on those objects (e.g. cached
 *     BearerDid key material on the vault) cannot leak via
 *     serialization.
 *   - Scalar / plain-object fields (`error`, `identities`,
 *     `biometricState`, `isInitializing`) are kept verbatim.
 *   - Any string field whose value matches a ≥32-char hex blob is
 *     defensively redacted so a future addition (e.g. a raw seed hex)
 *     cannot silently leak either.
 *
 * The callable surface is intentionally zero-arg (reads
 * `useAgentStore.getState()` directly) so it can be wired into a
 * zustand `devtools` middleware `serialize` option or invoked ad-hoc
 * from a debug screen without plumbing state through a parameter.
 */
export function serializeAgentStoreForDevtools(): string {
  const state = useAgentStore.getState();
  const redactLikelySecret = (value: unknown): unknown => {
    if (typeof value === 'string' && /^[0-9a-f]{32,}$/i.test(value)) {
      return '<redacted>';
    }
    return value;
  };
  const snapshot = {
    agent: state.agent ? '<agent>' : null,
    authManager: state.authManager ? '<authManager>' : null,
    vault: state.vault ? '<vault>' : null,
    isInitializing: state.isInitializing,
    error: redactLikelySecret(state.error),
    biometricState: state.biometricState,
    recoveryPhrase: state.recoveryPhrase === null ? null : '<redacted>',
    identities: state.identities,
  };
  return JSON.stringify(snapshot);
}
