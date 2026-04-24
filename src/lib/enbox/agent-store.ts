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

/** Error code emitted by the biometric vault when the OS cannot satisfy a biometric prompt. */
const BIOMETRICS_UNAVAILABLE_CODE = 'VAULT_ERROR_BIOMETRICS_UNAVAILABLE';
/** Error code emitted by the biometric vault when the key was invalidated by the OS. */
const KEY_INVALIDATED_CODE = 'VAULT_ERROR_KEY_INVALIDATED';

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
    try {
      console.log('[agent-store] initializeFirstLaunch: creating agent...');
      const { agent, authManager, vault } = await initializeAgent();

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
    try {
      console.log('[agent-store] unlockAgent: creating agent...');
      const { agent, authManager, vault } = await initializeAgent();
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
    set({ isInitializing: true, error: null });
    try {
      // 1. Wipe any prior biometric-gated secret so the vault's
      //    `initialize({ recoveryPhrase })` path won't fast-fail with
      //    `VAULT_ERROR_ALREADY_INITIALIZED`. Best-effort — a missing
      //    alias resolves as success on both iOS and Android.
      try {
        await NativeBiometricVault.deleteSecret(WALLET_ROOT_KEY_ALIAS);
      } catch (err) {
        console.warn(
          '[agent-store] restoreFromMnemonic: deleteSecret failed (ignored):',
          err,
        );
      }

      // 2. Create a fresh agent + vault. We do NOT reuse any existing
      //    instance — the old state is tied to the now-invalid secret
      //    and the agent's internal DWN layer must be wired against a
      //    vault whose BearerDid matches the restored entropy.
      console.log('[agent-store] restoreFromMnemonic: creating agent...');
      const { agent, authManager, vault } = await initializeAgent();

      // 3. Re-seal the biometric vault with the caller-provided
      //    mnemonic. `agent.initialize` forwards `recoveryPhrase`
      //    straight into `BiometricVault.initialize` which derives the
      //    entropy, calls `NativeBiometricVault.generateAndStoreSecret`,
      //    and rebuilds the HD seed / BearerDid in memory. Any native
      //    rejection is mapped to a canonical VAULT_ERROR_* and
      //    surfaced via the screen. `AgentInitializeParams.password` is
      //    widened to optional by the postinstall patch, so we omit it.
      await agent.initialize({ recoveryPhrase: mnemonic });

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
    // until the DID is observed — onboarding / unlock flows trigger a
    // follow-up `refreshIdentities()` once `agentDid` is set, so no
    // coverage is lost by the early return.
    if (!hasAgentDid(agent)) return;

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
    if (vault) {
      try {
        await vault.reset();
      } catch (err) {
        console.warn('[agent-store] reset: vault.reset failed:', err);
      }
    } else {
      try {
        await NativeBiometricVault.deleteSecret(WALLET_ROOT_KEY_ALIAS);
      } catch (err) {
        console.warn(
          '[agent-store] reset: native deleteSecret failed (ignored):',
          err,
        );
      }
      // Clear the SecureStorage flags that BiometricVault would have
      // cleared if a vault instance existed. The two keys match the
      // constants exported from `biometric-vault.ts`.
      const fallbackStorage = new SecureStorageAdapter();
      try {
        await fallbackStorage.remove(INITIALIZED_STORAGE_KEY);
      } catch (err) {
        console.warn(
          '[agent-store] reset: no-vault fallback clear initialized failed:',
          err,
        );
      }
      try {
        await fallbackStorage.remove(BIOMETRIC_STATE_STORAGE_KEY);
      } catch (err) {
        console.warn(
          '[agent-store] reset: no-vault fallback clear biometric-state failed:',
          err,
        );
      }
    }

    // 2. Wipe the on-disk ENBOX_AGENT LevelDB data so a post-reset
    //    relaunch starts from a genuinely clean state rather than
    //    resurrecting identities / DWN records / sync cursors from the
    //    previous wallet. The helper closes any open handle first and
    //    resolves idempotently when nothing is on disk.
    try {
      await destroyAgentLevelDatabases(AGENT_DATA_PATH);
    } catch (err) {
      console.warn(
        '[agent-store] reset: LevelDB wipe failed (ignored):',
        err,
      );
    }

    // 3. Tear down the in-memory agent / authManager / vault state and
    //    null out the one-shot recovery phrase if it was still held.
    get().teardown();

    // 4. Clear persisted session state + PIN-era storage artefacts.
    //    `useSessionStore` is imported statically at the top of the
    //    module now that `session-store.ts` no longer pulls in the
    //    ESM-only `@enbox/agent` runtime (the shared constants live in
    //    the pure-data `vault-constants.ts` module).
    try {
      await useSessionStore.getState().reset();
    } catch (err) {
      console.warn('[agent-store] reset: session-store reset failed:', err);
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
