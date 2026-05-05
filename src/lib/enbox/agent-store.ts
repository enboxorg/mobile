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

/**
 * SecureStorage sentinel that records "the last reset() failed to wipe
 * the on-disk LevelDB; the next agent initialization MUST retry the
 * wipe before opening any database handle". Round-9 F4: pre-fix
 * `reset()` silently swallowed `destroyAgentLevelDatabases()`
 * rejections, leaving stale identities / DWN records / sync cursors
 * on disk that a subsequent `initializeFirstLaunch()` would resurrect.
 *
 * The sentinel is written with `'true'` BEFORE `reset()` rethrows so a
 * caller that crashes between the throw and a UI surface still gets
 * the cleanup retried on the next cold launch. It is cleared by
 * `runPendingLevelDbCleanup()` once a retry succeeds — that helper
 * runs at the top of every `initializeFirstLaunch()` /
 * `restoreFromMnemonic()` / `unlockAgent()` flow before the agent is
 * created, so the wipe is guaranteed to land before any LevelDB
 * handle is opened.
 *
 * The key namespace mirrors the other vault sentinels
 * (``enbox.vault.initialized``, ``enbox.vault.biometric-state``) so
 * existing SecureStorage cleanup patterns automatically pick it up.
 */
export const LEVELDB_CLEANUP_PENDING_KEY = 'enbox.agent.leveldb-cleanup-pending';

/**
 * Round-10 F2: SecureStorage sentinel that records "the last
 * `vault.reset()` failed to wipe the OS-gated biometric secret; the
 * next agent initialization MUST retry the native delete BEFORE any
 * unlock / setup flow proceeds". Pre-fix `BiometricVault.reset()` and
 * `useAgentStore.reset()` swallowed every native deleteSecret() /
 * SecureStorage clear failure, leaving the OS-gated entry alive while
 * the app routed through reset / re-onboarding as if the wipe
 * succeeded. The next setup attempt then either:
 *
 *   1. failed loudly because the native non-upsert guard refused to
 *      provision over an existing alias (correct, but user-visible
 *      regression on what the user thinks is a clean wallet), or
 *   2. unlocked the OLD wallet via the surviving secret if a future
 *      caller skipped the non-upsert guard.
 *
 * The sentinel is written with `'true'` BEFORE `reset()` rethrows so a
 * caller that crashes between the throw and a UI surface still gets
 * the cleanup retried on the next cold launch. It is cleared by
 * `runPendingVaultResetCleanup()` once a retry succeeds — that helper
 * runs at the top of every agent-init flow alongside
 * `runPendingLevelDbCleanup()`.
 */
export const VAULT_RESET_PENDING_KEY = 'enbox.vault.reset-pending';

/**
 * Round-12 F3: SecureStorage sentinel that records "the last
 * `useAgentStore.reset()` failed to wipe the persisted AuthManager
 * (Web5 connect) material; the next agent initialization MUST retry
 * the SecureStorage wipe BEFORE provisioning a fresh `AuthManager`".
 *
 * The auth keys (`enbox:auth:*` — see `STORAGE_KEYS` from
 * `@enbox/auth`) carry delegate decryption keys, the active
 * identity DID, registration tokens, and session-revocation
 * grants. A surviving `enbox:auth:delegateDid` +
 * `enbox:auth:delegateDecryptionKeys` pair is privacy-critical: a
 * Web5 dApp that the previous wallet had connected to (with its
 * delegate keys still cached on this device) would be silently
 * re-authorised under the new wallet's identity.
 *
 * Pre-fix `useAgentStore.reset()` cleared vault + LevelDB + session
 * state but NEVER touched these keys, so the leak persisted across
 * any reset → fresh-onboarding cycle. Round-12 F3 added the
 * iterate-and-remove wipe in `reset()` and this sentinel so a
 * SIGKILL / OS suspend / SecureStorage transient error during the
 * iteration doesn't leave half-cleared auth state on disk with no
 * retry marker. Mirrors the round-9 / round-11 patterns for
 * `LEVELDB_CLEANUP_PENDING_KEY` and `VAULT_RESET_PENDING_KEY`.
 */
export const AUTH_RESET_PENDING_KEY = 'enbox.auth.reset-pending';

/**
 * Round-14 F3: SecureStorage sentinel that records "the last
 * `useAgentStore.reset()` succeeded at the vault / LevelDB / auth
 * wipes but failed (or was never reached) at `useSessionStore.reset()`,
 * leaving the persisted SESSION_KEY on disk with stale
 * `hasIdentity=true` while every other piece of wallet state was
 * already wiped".
 *
 * Without this sentinel the next cold launch's `session.hydrate()`
 * reads the stale `hasIdentity=true` snapshot, the navigator routes
 * to BiometricUnlock, the user taps Unlock, and `vault.unlock()`
 * surfaces `VAULT_ERROR_NOT_INITIALIZED` — a hard trap with no
 * automatic recovery because the other three sentinels were already
 * cleared on the successful wipe steps. The user has no usable path
 * forward: onboarding is gated by `hasIdentity=false`, but the
 * persisted session insists they already have one.
 *
 * Mechanism:
 *   - Persisted alongside the other three sentinels at the very top
 *     of `reset()` (round-12 F1 pattern, fail-CLOSED on write
 *     failure).
 *   - Cleared at the END of `reset()` only when `session.reset()`
 *     resolves successfully.
 *   - `session.hydrate()` checks for it BEFORE reading SESSION_KEY.
 *     When set, hydrate ignores the persisted SESSION_KEY (treats
 *     it as if absent), then attempts the SESSION_KEY +
 *     SESSION_RESET_PENDING_KEY deletes inline. The user lands on
 *     the fresh-install Welcome flow regardless of whether the
 *     inline retry succeeds — the sentinel itself prevents the
 *     ghost-state misroute from ever firing.
 *
 * Round-14 self-review: previously the per-step sentinel clears
 * (vault → LevelDB → auth) ran sequentially BEFORE session.reset(),
 * so a session-reset failure left zero retry markers on disk.
 * Adding a fourth sentinel keeps the per-step clearing pattern
 * (faster recovery on partial failures) while closing the
 * ghost-state hole.
 */
export const SESSION_RESET_PENDING_KEY = 'enbox.session.reset-pending';

/** Error code emitted by the biometric vault when the OS cannot satisfy a biometric prompt. */
const BIOMETRICS_UNAVAILABLE_CODE = 'VAULT_ERROR_BIOMETRICS_UNAVAILABLE';
/** Error code emitted by the biometric vault when the key was invalidated by the OS. */
const KEY_INVALIDATED_CODE = 'VAULT_ERROR_KEY_INVALIDATED';

/**
 * Round-10 F3: type the SecureStorage surface used by the cleanup
 * helpers. Both helpers accept ONLY the get / set / remove operations
 * they need so tests can substitute a focused stub instead of a full
 * `SecureStorageAdapter`. The shape mirrors `SecureStorageAdapter`
 * exactly — `set` is included on the `runPendingVaultResetCleanup`
 * surface even though only the local helper writes the sentinel,
 * because `runPendingVaultResetCleanup` writes the key when a retry
 * fails (see implementation below).
 */
type CleanupStorageGetRemove = {
  get: (key: string) => Promise<string | null>;
  remove: (key: string) => Promise<void>;
};

type CleanupStorageGetSetRemove = CleanupStorageGetRemove & {
  set: (key: string, value: string) => Promise<void>;
};

/**
 * Run a verified retry of `destroyAgentLevelDatabases()` if a previous
 * `reset()` left the cleanup-pending sentinel on disk. Resolves with
 * `true` on a successful (or vacuous) cleanup, throws with the
 * underlying LevelDB error if the retry STILL fails — callers should
 * treat that as a fatal "refuse to open agent over stale data"
 * condition.
 *
 * Round-9 F4: the helper is exported so that `__tests__` can pin the
 * retry contract directly without going through a full reset cycle.
 *
 * Round-10 F3: `storage.get` failures now propagate (fail-CLOSED).
 * Pre-fix the helper logged a warning and returned `true` ("no
 * pending cleanup"), which lets a transient SecureStorage failure
 * route the next agent init past a still-unreaped LevelDB. With the
 * sentinel set on disk but unreadable, we cannot prove the database
 * is safe to open — the only correct behaviour is to refuse to
 * proceed and surface the storage error to the operator. Callers
 * (`initializeFirstLaunch`, `unlockAgent`, `resumePendingBackup`,
 * `restoreFromMnemonic`) already let the underlying error bubble up
 * and tear down to a recoverable error state, so failing here is
 * strictly safer than the pre-fix swallow.
 */
export async function runPendingLevelDbCleanup(
  storage: CleanupStorageGetRemove = new SecureStorageAdapter(),
): Promise<boolean> {
  // Round-10 F3: any failure here propagates to the caller.
  // The `await` surfaces the rejection naturally; we do NOT wrap it
  // in a try/catch that swallows or rebrands the error, because the
  // operator needs to see the underlying SecureStorage failure code
  // (e.g. KEYCHAIN_LOCKED, IO_ERROR) to diagnose.
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
 * Round-10 F2: run a verified retry of the native vault wipe if a
 * previous `reset()` failed to delete the biometric-gated secret OR
 * failed to clear the SecureStorage flags. Resolves `true` on a
 * successful (or vacuous) cleanup; throws with the underlying error
 * if the retry STILL fails — same fail-CLOSED semantics as
 * `runPendingLevelDbCleanup`.
 *
 * Pre-fix the failure paths were:
 *   1. `BiometricVault.reset()` swallowed `deleteSecret()` failures
 *      via `try { ... } catch {}`. Native modules treat
 *      missing-alias as success, so a non-idempotent rejection
 *      indicates an actual Keystore / Keychain failure (e.g.
 *      `KeyStoreException`, `errSecAuthFailed`). The pre-fix flow
 *      proceeded to clear the SecureStorage flags and report success
 *      while the OS-gated entry remained alive on disk.
 *   2. `useAgentStore.reset()` independently caught both
 *      `vault.reset()` and the fallback-path `deleteSecret()` /
 *      `SecureStorage.remove` rejections via `console.warn` only,
 *      then proceeded to wipe LevelDB and the session store as if
 *      the native delete had succeeded.
 *
 * Combined effect: a successful-looking "Reset wallet" tap could
 * leave the prior wallet's biometric secret intact, and the next
 * `initializeFirstLaunch()` would either fail on the non-upsert
 * guard (visible regression) or — if a future caller skipped the
 * guard — silently unlock the OLD wallet under fresh onboarding
 * routing.
 *
 * The sentinel + retry pattern matches `runPendingLevelDbCleanup`:
 *   - `useAgentStore.reset()` writes the sentinel BEFORE the
 *     wipe attempt and clears it AFTER success.
 *   - This helper retries the native delete + SecureStorage clear
 *     when the sentinel is set, propagating any failure so the
 *     calling agent-init flow refuses to provision a fresh wallet
 *     over a still-resident OS-gated secret.
 *
 * `nativeVault` and `vaultStorage` are dependency-injected to keep
 * the helper unit-testable without booting a `BiometricVault`
 * instance.
 */
export async function runPendingVaultResetCleanup(
  storage: CleanupStorageGetSetRemove = new SecureStorageAdapter(),
  nativeVault: { deleteSecret: (alias: string) => Promise<void> } = NativeBiometricVault,
  vaultStorage: { remove: (key: string) => Promise<void> } = new SecureStorageAdapter(),
): Promise<boolean> {
  // Round-10 F3 parity: fail CLOSED on storage.get failures so an
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
 * Round-12 F3: re-iterate `STORAGE_KEYS` and remove each key on the
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
 * Round-10 F3 parity: fail CLOSED on `storage.get` failures so an
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
 * Round-10 F4 + Round-12 F3: convenience wrapper that runs ALL
 * pending-cleanup helpers in sequence. Every agent-init entry point
 * (`initializeFirstLaunch`, `unlockAgent`, `resumePendingBackup`,
 * `restoreFromMnemonic`) calls this BEFORE `initializeAgent()` so
 * a failed prior reset can never let a stale LevelDB, a
 * still-resident native vault secret, OR persisted Web5 connect
 * material leak into the new agent.
 *
 * Order matters and reflects the threat model:
 *   1. Vault wipe FIRST — stale OS-gated secret is the most
 *      privacy-critical leak (a fresh "first launch" provisioning
 *      would otherwise overwrite the alias and the user thinks
 *      they have a new wallet, but the prior wallet's bytes still
 *      exist in the Keychain / Keystore).
 *   2. LevelDB wipe — stale identity / DWN records on disk would
 *      be re-loaded by the next `EnboxUserAgent.create()` against
 *      the same `dataPath`. Encrypted by the same biometric-gated
 *      key the next vault would derive, so this ranks below vault
 *      reset.
 *   3. Auth wipe — stale delegate keys / active identity DID /
 *      registration tokens would be inherited by the next
 *      `AuthManager.create()` call. Less privacy-critical than the
 *      root vault material (the keys are scoped to specific
 *      dApps), but still must not leak across a wallet reset.
 */
async function runPendingResetCleanups(): Promise<void> {
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
   * Resume a `pending-first-backup` flow after a cold relaunch / auto-
   * lock drop.
   *
   * Context (VAL-VAULT-028): on a fresh-install setup, the vault
   * provisions a native secret and the generated mnemonic lives ONLY
   * in JS memory (`recoveryPhrase`). If the app backgrounds / is
   * killed before the user confirms the backup, `teardown()` (or the
   * OS process kill) drops `recoveryPhrase` and the user is routed
   * back to RecoveryPhrase with nothing to show. The navigator
   * invokes this action to re-seat the agent + vault under the
   * already-provisioned secret and re-derive the SAME mnemonic from
   * the stored entropy, so the backup screen can surface the phrase
   * the user still needs to write down. Internally:
   *
   *   1. `initializeAgent()` — creates a fresh agent / authManager /
   *      vault triple. We do NOT reuse a prior instance: the prior
   *      vault was torn down and its in-memory derived material zeroed.
   *   2. `agent.start({})` — prompts biometrics exactly once through
   *      the native module and unlocks the vault, populating its
   *      internal `_secretBytes` buffer.
   *   3. `vault.getMnemonic()` — re-derives the 24-word BIP-39 phrase
   *      from the in-memory entropy. No second biometric prompt and
   *      no network call.
   *   4. Commit the phrase to `recoveryPhrase` so the navigator routes
   *      back to RecoveryPhrase with the mnemonic visible. The store's
   *      `recoveryPhrase` field is treated exactly like it is after a
   *      first-launch `initializeFirstLaunch()`: a one-shot JS-only
   *      string that MUST be cleared via `clearRecoveryPhrase()` once
   *      the user confirms the backup.
   *
   * All error codes surface via the same `biometricState` /
   * `VAULT_ERROR_*` machinery as `unlockAgent()` so the screen can
   * route invalidated / unavailable states to the right recovery path.
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
    // unlocked the vault before a later step threw. See VAL-VAULT-031
    // / Round-2 review Finding 5 — the same residency-window argument
    // applies to first-launch as to unlock.
    let vaultRef: { lock: () => Promise<void> } | null = null;
    try {
      // Round-9 F4 + Round-10 F2/F4: retry both pending cleanups
      // (native vault secret + on-disk LevelDB) from a previous
      // failed `reset()` BEFORE creating the agent. Both helpers are
      // fail-CLOSED — if the retry rejects we throw before opening
      // the LevelDB handle OR provisioning a new vault, so a stale
      // identity / DWN record / OS-gated secret can never resurrect
      // into a fresh wallet.
      await runPendingResetCleanups();
      console.log('[agent-store] initializeFirstLaunch: creating agent...');
      const { agent, authManager, vault } = await initializeAgent();
      vaultRef = vault;

      console.log('[agent-store] checking firstLaunch...');
      const isFirst = await agent.firstLaunch();
      console.log('[agent-store] firstLaunch:', isFirst);

      let recoveryPhrase: string;
      if (isFirst) {
        console.log('[agent-store] initializing vault (biometric prompt)...');
        // BiometricVault has no password. `AgentInitializeParams.password`
        // is widened to optional by `scripts/apply-patches.mjs`'s
        // `patchEnboxAgentPasswordOptional()` so the call site does NOT
        // need to carry a `password` property.
        recoveryPhrase = await agent.initialize({});
        console.log('[agent-store] vault initialized.');
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
        console.log('[agent-store] starting existing vault (biometric prompt)...');
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
      if (vaultRef !== null) {
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
    // populated before the later step threw. (VAL-VAULT-031 / Round-2
    // review Finding 5.)
    let vaultRef: { lock: () => Promise<void> } | null = null;
    try {
      // Round-9 F4 + Round-10 F2/F4: see `initializeFirstLaunch()`
      // for the rationale.
      await runPendingResetCleanups();
      console.log('[agent-store] unlockAgent: creating agent...');
      const { agent, authManager, vault } = await initializeAgent();
      vaultRef = vault;
      console.log('[agent-store] starting vault (biometric prompt)...');
      // BiometricVault has no password. `AgentStartParams.password` is
      // widened to optional by `scripts/apply-patches.mjs`'s
      // `patchEnboxAgentPasswordOptional()` so the call site does NOT
      // need to carry a `password` property.
      await agent.start({});
      console.log('[agent-store] vault started.');
      set({
        agent,
        authManager,
        vault,
        isInitializing: false,
        biometricState: 'ready',
      });

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
    // Local vault reference for the catch path's defensive lock
    // (VAL-VAULT-031 / Round-2 review Finding 5). resumePendingBackup
    // unlocks the vault to re-derive the mnemonic; if any step AFTER
    // `agent.start({})` (e.g. `vault.getMnemonic()` or the mid-flight
    // `set(...)`) throws, the unlocked entropy stays resident in
    // memory until GC unless we explicitly call `lock()`.
    let vaultRef: { lock: () => Promise<void> } | null = null;
    try {
      // Round-10 F4: pre-fix `resumePendingBackup` jumped straight to
      // `initializeAgent()` without retrying any pending reset
      // cleanups. The other three init flows
      // (`initializeFirstLaunch`, `unlockAgent`,
      // `restoreFromMnemonic`) all gate on
      // `runPendingResetCleanups()` — only this path skipped it.
      // If a user hit "Reset wallet" mid-backup-pending session and
      // the wipe failed, the next backup-pending resume opened the
      // stale ENBOX_AGENT LevelDB / unlocked the stale OS-gated
      // secret here. The fix mirrors the other flows: cleanup
      // first (fail-CLOSED), then create the agent.
      await runPendingResetCleanups();
      console.log('[agent-store] resumePendingBackup: creating agent...');
      const { agent, authManager, vault } = await initializeAgent();
      vaultRef = vault;
      console.log(
        '[agent-store] resumePendingBackup: starting vault (biometric prompt)...',
      );
      // `agent.start({})` forwards to `BiometricVault.unlock()` which
      // prompts biometrics once and populates the vault's in-memory
      // `_secretBytes` buffer. The subsequent `getMnemonic()` call
      // does NOT re-prompt — it reads the already-in-memory entropy.
      await agent.start({});
      const recoveryPhrase = await vault.getMnemonic();
      console.log('[agent-store] resumePendingBackup: mnemonic re-derived.');

      set({
        agent,
        authManager,
        vault,
        isInitializing: false,
        biometricState: 'ready',
        recoveryPhrase,
      });

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
      if (vaultRef !== null) {
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
    // ---- Phase 1: pure validation (no store mutation, no native I/O) ----
    //
    // VAL-VAULT-029. `RecoveryRestoreScreen` already validates the
    // phrase before invoking this action, but the public store action
    // is also reachable from future call sites (deep links, dev tools,
    // automated tests) that may not front-load that check. If we
    // delete the prior biometric-gated secret before validating, a
    // bogus mnemonic wipes the user's one working wallet and then
    // fails in `BiometricVault.initialize()` — leaving the device
    // with NO secret and no way back short of re-running first-launch
    // setup with a brand-new mnemonic.
    //
    // Running BIP-39 validation here first, BEFORE flipping
    // `isInitializing` or clearing any store references, means an
    // invalid mnemonic is a pure no-op from the store's perspective:
    // the pre-existing `agent` / `vault` / `identities` remain
    // usable. A valid mnemonic falls through to the destructive
    // phase with high confidence that `BiometricVault.initialize()`
    // will succeed on it too (the vault re-validates internally as
    // belt-and-suspenders, not a substitute).
    const trimmed = mnemonic.trim();
    if (!trimmed || !validateMnemonic(trimmed, wordlist)) {
      const err = Object.assign(
        new Error('Provided recovery phrase is not a valid BIP-39 mnemonic'),
        { code: 'VAULT_ERROR_INVALID_MNEMONIC' as const },
      );
      throw err;
    }

    // ---- Phase 2: destructive restore ----
    set({ isInitializing: true, error: null });
    // Local vault reference for the catch path's defensive lock — same
    // pattern unlockAgent() / resumePendingBackup() use (VAL-VAULT-031
    // / Round-2 Finding 5). Inside the destructive phase
    // `agent.initialize({recoveryPhrase})` calls
    // `BiometricVault.initialize({recoveryPhrase})` which lands the
    // 32-byte root entropy + derived HD seed + CEK into the vault's
    // private fields BEFORE returning. If a LATER step throws (e.g.
    // `vault.getDid()` or the success-path `set(...)`), nulling the
    // store reference alone leaves the unlocked vault in heap memory
    // until GC. An explicit `lock()` zeroes those buffers
    // synchronously so a heap snapshot taken between the throw and
    // the next `restoreFromMnemonic()` retry cannot leak the
    // restored entropy.
    let vaultRef: { lock: () => Promise<void> } | null = null;
    try {
      // Round-9 F4 + Round-10 F2/F4: retry any pending cleanup
      // (native vault secret + on-disk LevelDB) from a previous
      // failed `reset()` BEFORE creating the agent. Restore is the
      // most important place to enforce both: a user typing a
      // recovery phrase MUST land on a clean DWN/identity store AND
      // must not have a stale prior-wallet OS-gated secret blocking
      // the new vault's `initialize({ recoveryPhrase })` (the
      // `deleteSecret()` block below is best-effort and would fail
      // open if the prior wallet's secret survived a failed reset).
      await runPendingResetCleanups();
      // Wipe any prior biometric-gated secret so the vault's
      // `initialize({ recoveryPhrase })` path won't fast-fail with
      // `VAULT_ERROR_ALREADY_INITIALIZED`. Best-effort — a missing
      // alias resolves as success on both iOS and Android. Only
      // reached after Phase 1 has validated the mnemonic.
      try {
        await NativeBiometricVault.deleteSecret(WALLET_ROOT_KEY_ALIAS);
      } catch (err) {
        console.warn(
          '[agent-store] restoreFromMnemonic: deleteSecret failed (ignored):',
          err,
        );
      }

      // Create a fresh agent + vault. We do NOT reuse any existing
      // instance — the old state is tied to the now-invalid secret
      // and the agent's internal DWN layer must be wired against a
      // vault whose BearerDid matches the restored entropy.
      console.log('[agent-store] restoreFromMnemonic: creating agent...');
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
      await agent.initialize({ recoveryPhrase: trimmed });

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
      if (vaultRef !== null) {
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

    const identity = await agent.identity.create({
      metadata: { name },
      didMethod: 'dht',
    });

    // Refresh the list
    await get().refreshIdentities();
    return identity;
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
    const { vault } = get();
    if (vault) {
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
    const { vault } = get();

    // 0. Round-10 F2 + Round-11 F3 + Round-12 F1/F3: persist all
    //    three retry sentinels (vault, LevelDB, auth) BEFORE we
    //    touch any wipe operation. Pessimistic by construction:
    //    even if we crash mid-wipe (SIGKILL, OS suspend that never
    //    resumes, JS engine death) the next cold launch sees the
    //    sentinels and re-runs the corresponding cleanups before
    //    any unlock / setup / restore / agent-init flow proceeds.
    //    Each sentinel is cleared at the end of its own wipe step
    //    ONLY if every sub-step succeeded — partial failures keep
    //    the sentinel set so the next agent-init flow retries.
    //
    //    Fail-CLOSED on ANY sentinel write failure: throw before
    //    touching the native vault / LevelDB / session store, AND
    //    best-effort roll back any sentinels we already wrote. A
    //    persistent SecureStorage failure is a system-level problem
    //    the user must resolve before any reset can land — failing
    //    closed keeps the wallet intact for a manual retry once
    //    SecureStorage recovers.
    //
    //    Round-12 F1: the LevelDB sentinel pre-fix was written ONLY
    //    inside the destroy-failed catch — a crash during the
    //    multi-subpath wipe left the LevelDB partially deleted
    //    with NO sentinel on disk, so the next cold launch's
    //    `runPendingLevelDbCleanup()` would skip the retry and
    //    `EnboxUserAgent.create()` would open a corrupt /
    //    half-deleted database.
    //
    //    Round-12 self-review: the writes MUST be sequential, NOT
    //    Promise.allSettled. `SecureStorageAdapter.set()` reads +
    //    writes the on-disk `KEY_INDEX` tracker on every call (see
    //    `trackKey` in `storage-adapter.ts`); concurrent writes
    //    against the same adapter race on that index because each
    //    `trackKey` does a read-modify-write of the JSON-encoded
    //    key list. With three parallel writes the LAST write wins
    //    and the other two sentinels disappear from `KEY_INDEX` —
    //    a downstream `SecureStorageAdapter.clear()` would then
    //    miss them. Sequential writes are still fast (three
    //    SecureStorage round-trips) and trivially correct.
    //
    //    Round-14 F3: session reset is the FOURTH sentinel. See
    //    `SESSION_RESET_PENDING_KEY` for the full ghost-state
    //    rationale — pre-fix, a successful vault/LevelDB/auth
    //    wipe followed by a failing `useSessionStore.reset()`
    //    cleared every other sentinel while leaving SESSION_KEY
    //    on disk with `hasIdentity=true`, routing the next launch
    //    to BiometricUnlock against a wiped vault.
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
      // Round-14 F2: roll back EVERY sentinel in `SENTINEL_KEYS`,
      // NOT just the ones whose `set()` resolved successfully.
      // Pre-fix the rollback iterated `writtenKeys` (sentinels
      // pushed only when `set()` resolved) — which missed the
      // partial-success case where `SecureStorageAdapter.set()`
      // landed the value via `NativeSecureStorage.setItem()` but
      // then threw inside the follow-up `trackKey()` call (see
      // `storage-adapter.ts:set`). The value was on disk, the
      // promise was rejected, and the caller never recorded it
      // in `writtenKeys` — so the rollback loop skipped it.
      //
      // The on-disk consequence was severe: a stale
      // VAULT_RESET_PENDING_KEY=`true` survives the failed-
      // sentinel-write throw, and the next cold launch's
      // `runPendingVaultResetCleanup()` calls
      // `NativeBiometricVault.deleteSecret(WALLET_ROOT_KEY_ALIAS)`
      // on a STILL-VALID biometric vault that was never wiped.
      // The user loses access to their wallet on a transient
      // SecureStorage tracking failure, with no way to
      // distinguish from a genuine reset.
      //
      // `SecureStorageAdapter.remove()` is idempotent on
      // already-absent keys, so iterating every sentinel
      // unconditionally is safe — it covers the partial-success
      // case AND short-circuits cleanly when `set()` never wrote
      // the value in the first place.
      for (const key of SENTINEL_KEYS) {
        try {
          await sentinelStorage.remove(key);
        } catch (rollbackErr) {
          console.warn(
            `[agent-store] reset: failed to roll back retry sentinel "${key}" after a sentinel write failure (next cold launch may run a no-op cleanup retry):`,
            rollbackErr,
          );
        }
      }
      console.warn(
        '[agent-store] reset: refusing to start wipe — retry-sentinel persistence failed (failing closed so a partial reset cannot leak past a non-existent retry path):',
        firstSentinelWriteError,
      );
      throw firstSentinelWriteError;
    }

    // 1. Wipe the biometric-gated native secret + the persisted vault
    //    SecureStorage flags. When a vault instance exists we delegate
    //    to `vault.reset()` which clears both
    //    `enbox.vault.initialized` and `enbox.vault.biometric-state`
    //    via its own SecureStorageLike dependency. The fallback path
    //    (vault was never constructed — e.g. corrupt-start / invalidated
    //    recovery) has no such dependency, so it must ALSO clear those
    //    keys directly via the SecureStorageAdapter so the next cold
    //    launch does not misroute away from onboarding because a stale
    //    `enbox.vault.initialized = 'true'` flag survived.
    //
    //    Round-10 F2: native deleteSecret + SecureStorage clear
    //    failures used to be swallowed via `console.warn` only. Both
    //    paths now SURFACE the error: we capture it into
    //    `vaultResetError` and re-throw at the end (alongside any
    //    LevelDB / auth error) so the caller knows the wipe is
    //    incomplete AND the sentinel persisted in step 0a keeps the
    //    retry path armed for the next launch. Native modules treat
    //    missing-alias as success on both Android
    //    (`promise.resolve(null)`) and iOS (`errSecItemNotFound` ->
    //    resolve), so any rejection here is a real failure that we
    //    must not mask.
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
    if (vaultResetError === null) {
      // Clear the sentinel persisted in step 0a since every step
      // succeeded. A failure here is logged but does NOT promote to
      // `vaultResetError` — the worst case is one extra no-op
      // `runPendingVaultResetCleanup()` on the next launch.
      try {
        await sentinelStorage.remove(VAULT_RESET_PENDING_KEY);
      } catch (err) {
        console.warn(
          '[agent-store] reset: failed to clear vault-reset sentinel after successful wipe (next launch will run a no-op cleanup retry):',
          err,
        );
      }
    }

    // 2. Wipe the on-disk ENBOX_AGENT LevelDB data so a post-reset
    //    relaunch starts from a genuinely clean state rather than
    //    resurrecting identities / DWN records / sync cursors from
    //    the previous wallet. The helper closes any open handle
    //    first and resolves idempotently when nothing is on disk.
    //
    //    The cleanup-pending sentinel was already written in step 0b
    //    BEFORE this call — see the round-12 F1 rationale there. So
    //    a crash mid-wipe still gets retried on the next cold
    //    launch. Here we only need to CLEAR the sentinel after a
    //    successful wipe.
    let levelDbError: unknown = null;
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
        '[agent-store] reset: LevelDB wipe failed; sentinel from step 0b stays set for next-launch retry:',
        err,
      );
    }

    // 3. Round-12 F3: wipe persisted AuthManager / Web5 connect
    //    material from SecureStorage. Pre-fix `agent-store.reset()`
    //    cleared vault + LevelDB + session state but NEVER touched
    //    the `enbox:auth:*` keys that `AuthManager` (created by
    //    `agent-init.ts`) writes through its `SecureStorageAdapter`
    //    — so the new wallet inherited the previous wallet's
    //    `activeIdentity` DID, `delegateDid` + `delegateDecryptionKeys`
    //    (cryptographic material), `connectedDid`, `registrationTokens`,
    //    `sessionRevocations`, etc. That is a privacy-critical leak:
    //    a Web5 dApp that the previous wallet had connected to (with
    //    its delegate keys still cached on this device) could be
    //    silently re-authorised under the new wallet's identity.
    //
    //    Fix: iterate `STORAGE_KEYS` from `@enbox/auth` and remove
    //    each key. We use the canonical export instead of
    //    `SecureStorageAdapter.clear()` because clear() would also
    //    nuke the in-flight sentinels (which still drive the
    //    failure-path retry semantics) and the session-store keys
    //    (which step 5 owns). Iterating STORAGE_KEYS gives us a
    //    precise, future-proof wipe — any new key added to
    //    `@enbox/auth/types.ts` automatically flows through here on
    //    the next mobile build via the `Object.values(STORAGE_KEYS)`
    //    loop.
    //
    //    Failures are CAPTURED (not swallowed) so a transient
    //    SecureStorage error surfaces to the caller alongside
    //    vault / LevelDB errors. The auth-reset sentinel from step
    //    0 stays SET so the next cold launch's
    //    `runPendingAuthResetCleanup()` retries the iteration. The
    //    user can also manually retry via Settings; remove() is
    //    idempotent on already-absent keys.
    let authResetError: unknown = null;
    const authStorage = new SecureStorageAdapter();
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
      // Clear the sentinel persisted in step 0 since every key was
      // successfully removed. A failure here is logged but does
      // NOT promote to `authResetError` — the worst case is one
      // extra no-op `runPendingAuthResetCleanup()` on the next
      // launch.
      try {
        await sentinelStorage.remove(AUTH_RESET_PENDING_KEY);
      } catch (err) {
        console.warn(
          '[agent-store] reset: failed to clear auth-reset sentinel after successful wipe (next launch will run a no-op cleanup retry):',
          err,
        );
      }
    }

    // 4. Tear down the in-memory agent / authManager / vault state
    //    and null out the one-shot recovery phrase if it was still
    //    held. Always runs — teardown is a synchronous in-memory
    //    operation with no persistence side-effects, so even on
    //    failure paths we want the in-process refs cleared.
    get().teardown();

    // 5. Round-12 F2: defer session-store reset until ALL critical
    //    wipes (vault + LevelDB + auth) succeeded. Pre-fix this
    //    ALWAYS ran before rethrowing — but `session-store.reset()`
    //    sets `biometricStatus: 'unknown'` which the navigator
    //    routes to `Loading` (see `getInitialRoute` rule 3). The
    //    Settings UI shows the reset-failure Alert ON TOP of the
    //    transition, so even though the alert remained
    //    interactable, dismissing it left the user stranded on a
    //    permanent Loading screen until they backgrounded the app.
    //
    //    Fix: skip session reset on failure. The session-store keeps
    //    its prior `hasIdentity=true` / `biometricStatus='ready'`
    //    flags so the Settings screen stays mounted and the
    //    follow-up Alert renders against a stable navigator. The
    //    retry sentinels persisted in step 0 still drive automatic
    //    recovery on the next cold launch — at which point the
    //    cleanup helpers re-run before any agent-init proceeds.
    //
    //    Round-14 F3: the prior round-12 design left a hole on the
    //    failure-then-relaunch path. SESSION_KEY remained on disk
    //    with `hasIdentity=true` while every other piece of wallet
    //    state was wiped, and the per-step sentinel clears (vault →
    //    LevelDB → auth) had already cleared every retry marker on
    //    a successful-wipe / failed-session-reset combination.
    //    `session.hydrate()` then read the stale snapshot and the
    //    navigator routed to BiometricUnlock against a wiped vault,
    //    surfacing `VAULT_ERROR_NOT_INITIALIZED` with no automatic
    //    recovery.
    //
    //    Fix: a fourth sentinel — `SESSION_RESET_PENDING_KEY` — is
    //    persisted alongside the other three at the very top of
    //    reset() and cleared ONLY when `session.reset()` resolves
    //    successfully. On the next launch `session.hydrate()`
    //    checks the sentinel BEFORE reading SESSION_KEY: when set,
    //    SESSION_KEY is treated as if absent (fresh-install
    //    defaults) and the user routes to Welcome. Inline retry of
    //    the SESSION_KEY delete is best-effort with strict
    //    "clear-sentinel-only-after-key-is-gone" ordering so an
    //    arbitrary chain of partial-cleanup failures still
    //    preserves the ghost-state guard.
    //
    //    Round-10 self-review: when session reset DOES run (success
    //    path) we still capture-then-rethrow on rejection. A
    //    `SecureStorage.set` failure to clear `SESSION_KEY` would
    //    otherwise leave the next cold launch routing against a
    //    stale session that says `hasIdentity=true` — agent-init
    //    would attempt unlock against a wiped vault and trap the
    //    user in an error loop.
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
      // Round-14 F3: clear SESSION_RESET_PENDING_KEY ONLY when
      // session.reset() resolves successfully. A failure here keeps
      // the sentinel set so `session.hydrate()` on the next cold
      // launch refuses to read the stale SESSION_KEY and routes the
      // user to the fresh-install Welcome flow instead of trapping
      // them on BiometricUnlock against a wiped vault.
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
      // Round-14 F3: SESSION_RESET_PENDING_KEY stays SET on the
      // skip path too. Even though we never touched the persisted
      // session, the OTHER sentinels (vault / LevelDB / auth) might
      // have CLEARED individually if their wipe steps succeeded —
      // leaving a partial-wipe state where SESSION_KEY says
      // `hasIdentity=true` but vault/LevelDB are mid-cleanup. The
      // session sentinel ensures next-launch hydrate ignores the
      // stale SESSION_KEY and routes to Welcome regardless.
    }

    // 6. Round-9 F4 + Round-10 F2 + Round-12 F1/F2/F3 + self-review:
    //    rethrow any captured failure now that the in-memory state
    //    has been torn down. The sentinels persisted in steps 0a/0b
    //    guarantee the next agent-init flow retries the
    //    privacy-critical wipes (vault secret + LevelDB) before
    //    opening any handle / provisioning a new vault, so even a
    //    caller that swallows the throw cannot resurrect stale
    //    identities OR leak the prior wallet's OS-gated secret into
    //    a new onboarding flow.
    //
    //    Order of precedence reflects the threat model:
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
