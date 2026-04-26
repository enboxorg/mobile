import { create } from 'zustand';

import NativeBiometricVault from '@specs/NativeBiometricVault';
import {
  deleteSecureItem,
  getSecureItem,
  setSecureItem,
} from '@/lib/storage/secure-storage';
import {
  BIOMETRIC_STATE_STORAGE_KEY,
  INITIALIZED_STORAGE_KEY,
  WALLET_ROOT_KEY_ALIAS,
} from '@/lib/enbox/vault-constants';

const SESSION_KEY = 'session:state';

/**
 * Raw SecureStorage key where BiometricVault persists its `biometricState`
 * signal (via `@enbox/auth` SecureStorageAdapter which prefixes keys with
 * `enbox:`). Session-store reads the raw key directly so it can gate the
 * navigator on invalidated state before any biometric prompt fires.
 *
 * Derived from the canonical `BIOMETRIC_STATE_STORAGE_KEY` in
 * `vault-constants.ts` plus the `enbox:` prefix applied by
 * `SecureStorageAdapter`.
 */
const BIOMETRIC_STATE_RAW_KEY = `enbox:${BIOMETRIC_STATE_STORAGE_KEY}`;

/**
 * Raw SecureStorage key where BiometricVault persists its `INITIALIZED='true'`
 * sentinel after a successful `_doInitialize()`. Session-store reads it
 * directly so the orphan-secret recovery (Round-7 Finding 2) can detect
 * "the vault has previously been provisioned" without depending on the
 * separate Welcome `hasCompletedOnboarding` write — which is a
 * fire-and-forget persist that may not have committed before a
 * cold-kill.
 *
 * Same `enbox:`-prefixing convention as `BIOMETRIC_STATE_RAW_KEY`.
 */
const VAULT_INITIALIZED_RAW_KEY = `enbox:${INITIALIZED_STORAGE_KEY}`;

/**
 * Biometric availability state exposed to the navigator / onboarding UI.
 *   - `'unknown'`       : hydrate has not completed; defer routing.
 *   - `'unavailable'`   : device has no biometric hardware.
 *   - `'not-enrolled'`  : hardware exists but user has not enrolled a
 *                         biometric, OR all enrolled biometrics were
 *                         removed after a secret was provisioned.
 *   - `'ready'`         : biometrics are enrolled and usable.
 *   - `'invalidated'`   : biometric enrollment changed and the OS
 *                         invalidated the stored key. Requires
 *                         recovery-phrase restore.
 */
export type BiometricStatus =
  | 'unknown'
  | 'unavailable'
  | 'not-enrolled'
  | 'ready'
  | 'invalidated';

// --- Persisted state shape ---

interface PersistedSessionState {
  hasCompletedOnboarding: boolean;
  hasIdentity: boolean;
  /**
   * Durable `pending-first-backup` flag. Set to `true` the moment
   * `initializeFirstLaunch()` lands a new biometric-gated secret on
   * device; cleared only after the user confirms the recovery phrase
   * via RecoveryPhraseScreen.
   *
   * Why it MUST be persisted (VAL-VAULT-028): the one-shot recovery
   * phrase lives in `useAgentStore.recoveryPhrase` — i.e. in JS memory
   * — and is wiped by any `teardown()` (auto-lock on background, cold
   * kill). Without a persisted counterpart, a relaunch between "secret
   * provisioned" and "user confirmed backup" would observe `hasIdentity
   * = true` + `recoveryPhrase = null` and route straight to
   * `BiometricUnlock` → `Main`, stranding the user with a wallet they
   * never backed up. The persisted flag forces the navigator to route
   * back to RecoveryPhrase so the mnemonic can be re-derived from the
   * already-provisioned native secret (see
   * `useAgentStore.resumePendingBackup()`).
   *
   * Optional in the on-disk payload so older installs (persisted
   * before this field existed) hydrate as `false`, which is the
   * correct semantic — they have already passed the backup gate.
   */
  isPendingFirstBackup?: boolean;
}

function isPersistedSessionState(
  value: unknown,
): value is PersistedSessionState {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).hasCompletedOnboarding ===
      'boolean' &&
    typeof (value as Record<string, unknown>).hasIdentity === 'boolean'
  );
}

// --- Store ---

export interface SessionState {
  isHydrated: boolean;
  hasCompletedOnboarding: boolean;
  hasIdentity: boolean;
  isLocked: boolean;
  /**
   * Durable `pending-first-backup` flag — see
   * `PersistedSessionState.isPendingFirstBackup` for the full rationale.
   * Hydrated from SecureStorage on launch and persisted on every write;
   * the AppNavigator OR-combines it with the in-memory
   * `agentStore.recoveryPhrase !== null` signal to decide whether the
   * RecoveryPhrase gate should remain in front of the user.
   */
  isPendingFirstBackup: boolean;
  /** Biometric availability state (driven by hydrate + vault signals). */
  biometricStatus: BiometricStatus;

  hydrate: () => Promise<void>;
  completeOnboarding: () => void;
  unlockSession: () => void;
  lock: () => void;
  setHasIdentity: (value: boolean) => void;
  /**
   * Commit the `pending-first-backup` flag and persist it atomically.
   *
   * Set to `true` as soon as `initializeFirstLaunch()` lands a new
   * biometric-gated secret (alongside `setHasIdentity(true)`). Cleared
   * only by the user confirming the phrase on RecoveryPhraseScreen.
   * MUST round-trip through SecureStorage so a relaunch before
   * confirmation still routes back to the RecoveryPhrase gate.
   *
   * Returns a `Promise<void>` so callers that need to coordinate
   * downstream navigation on a durable write (e.g. the confirm handler
   * can await before calling `unlockSession()`) can do so. Failures
   * are swallowed by the underlying `persistSession` — the state flip
   * still succeeds in memory so the UI remains responsive, and the
   * next persisted write will re-commit the correct value.
   */
  setPendingFirstBackup: (value: boolean) => Promise<void>;
  /**
   * Atomically commit the post-setup snapshot.
   *
   * Called by `AppNavigator.handleSetupInitialized` the instant
   * `initializeFirstLaunch()` returns with a freshly provisioned
   * biometric secret + recovery phrase. Persists BOTH
   * `hasIdentity = true` and `isPendingFirstBackup = true` in a single
   * `setSecureItem(SESSION_KEY, ...)` write so there is NO interleaved
   * state where one flag is on-disk and the other isn't — a
   * cold-kill that hits between two separate persists (VAL-VAULT-028)
   * could otherwise leave `{hasIdentity: true, isPendingFirstBackup:
   * false}` on disk, stranding the user on Main with an un-backed-up
   * wallet.
   *
   * Returns a `Promise<void>` so the navigator can sequence the
   * in-memory flip after the on-disk commit has at least been
   * scheduled. Failures are swallowed by the underlying
   * `persistSession` — identical to `setHasIdentity` / `completeOnboarding`.
   */
  commitSetupInitialized: () => Promise<void>;
  /** Transition the biometric status exposed to the navigator. */
  setBiometricStatus: (next: BiometricStatus) => void;
  /**
   * Atomically commit the post-recovery-restore session snapshot.
   *
   * Persists the onboarding/identity half of the session to
   * SecureStorage FIRST via `persistSessionOrThrow(...)`, and only
   * on a successful commit flips the four route-driving flags —
   * `biometricStatus: 'ready'`, `hasCompletedOnboarding: true`,
   * `hasIdentity: true`, `isLocked: false` — in a single `setState`
   * call. Callers (notably `RecoveryRestoreScreen`) MUST await this
   * helper before handing control back to the navigator.
   *
   * Rationale: AppNavigator routes declaratively from these flags,
   * so a "flip first, persist second" ordering creates a cold-kill
   * race. A process kill that lands after the in-memory flip but
   * before the `setSecureItem(SESSION_KEY, ...)` commit would leave
   * the user with a persisted legacy snapshot while the in-memory
   * UI has already left RecoveryRestore — on relaunch `hydrate()`
   * re-reads the stale payload and misroutes the restored wallet.
   * Persisting first guarantees that by the time any navigator
   * selector observes the flipped flags, the on-disk state already
   * agrees. On persist failure NO flags change (no visible partial
   * flip to the navigator) and the rejection propagates to the
   * caller so `RecoveryRestoreScreen` can render a retry alert
   * instead of navigating away.
   *
   * The raw `setState` call that previously lived in
   * `recovery-restore-screen.tsx` bypassed the store's persistence
   * path entirely; this helper is the single source of truth for
   * committing a successful restore.
   */
  hydrateRestored: () => Promise<void>;
  reset: () => Promise<void>;
}

/**
 * Persist the identity/onboarding half of the session to SecureStorage.
 *
 * Returns a Promise<void> that resolves once `setSecureItem` has either
 * committed the write OR failed (failures are swallowed here so that
 * non-awaiting callers — e.g. `completeOnboarding` / `setHasIdentity` —
 * never produce an unhandled rejection). Callers that need to observe
 * a SecureStorage rejection (e.g. `hydrateRestored`, which gates
 * RecoveryRestoreScreen navigation on a durable write) MUST use
 * `persistSessionOrThrow` instead — the swallow is deliberate here.
 */
function persistSession(state: PersistedSessionState): Promise<void> {
  return setSecureItem(SESSION_KEY, JSON.stringify(state)).catch((err) => {
    console.warn('[session] persist failed:', err);
  });
}

/**
 * Propagating variant of `persistSession`. Writes the identity/onboarding
 * half of the session to SecureStorage and REJECTS when the underlying
 * `setSecureItem(SESSION_KEY, ...)` write fails.
 *
 * Used exclusively by `hydrateRestored` so that a silent SecureStorage
 * failure during post-recovery commit surfaces as a rejection to
 * `RecoveryRestoreScreen`, which can then render a retry alert instead
 * of navigating away on a not-actually-persisted restore. All other
 * callers (`completeOnboarding`, `setHasIdentity`) should continue to
 * use the non-throwing `persistSession` so they remain rejection-safe.
 */
function persistSessionOrThrow(
  state: PersistedSessionState,
): Promise<void> {
  return setSecureItem(SESSION_KEY, JSON.stringify(state));
}

/**
 * Probe the native biometric module for current availability. Returns the
 * structured response or `null` when the module is unavailable / throws
 * (e.g. during unit tests without a mock). Never throws.
 */
async function probeBiometricAvailability(): Promise<{
  available: boolean;
  enrolled: boolean;
} | null> {
  try {
    const result = await NativeBiometricVault.isBiometricAvailable();
    if (!result || typeof result !== 'object') return null;
    return {
      available: Boolean(result.available),
      enrolled: Boolean(result.enrolled),
    };
  } catch {
    return null;
  }
}

export const useSessionStore = create<SessionState>((set, get) => ({
  isHydrated: false,
  hasCompletedOnboarding: false,
  hasIdentity: false,
  isLocked: true,
  isPendingFirstBackup: false,
  biometricStatus: 'unknown',

  hydrate: async () => {
    try {
      // Round-7 Finding 2: ALSO read the vault's own
      // ``INITIALIZED_STORAGE_KEY`` sentinel. The orphan-secret
      // recovery below uses it as a parallel "user previously had a
      // working vault" signal independent of the Welcome
      // ``hasCompletedOnboarding`` write — which is fire-and-forget
      // (``persistSession`` swallows errors and the caller does not
      // await) so a cold-kill between native-secret provisioning and
      // the Welcome persist can leave us with
      // ``hasCompletedOnboarding=false`` on disk while
      // ``hasSecret=true`` natively. The vault's own ``INITIALIZED``
      // flag is the authoritative durable signal that
      // ``_doInitialize()`` ran to completion.
      const [rawSession, rawBiometricState, rawVaultInitialized] =
        await Promise.all([
          getSecureItem(SESSION_KEY),
          getSecureItem(BIOMETRIC_STATE_RAW_KEY),
          getSecureItem(VAULT_INITIALIZED_RAW_KEY),
        ]);

      let session: Partial<PersistedSessionState> = {};
      if (rawSession) {
        try {
          const parsed: unknown = JSON.parse(rawSession);
          if (isPersistedSessionState(parsed)) {
            session = parsed;
          }
        } catch {
          // ignore parse errors — treat as clean state
        }
      }

      // -----------------------------------------------------------------
      // Biometric availability + persisted invalidation flag
      // -----------------------------------------------------------------
      const availability = await probeBiometricAvailability();
      const hasSecret = await NativeBiometricVault.hasSecret(
        WALLET_ROOT_KEY_ALIAS,
      ).catch(() => false);

      let biometricStatus: BiometricStatus = 'unknown';
      if (rawBiometricState === 'invalidated') {
        // KEY_INVALIDATED flag persists across relaunches and forces the
        // recovery flow regardless of the current hardware probe result.
        biometricStatus = 'invalidated';
      } else if (availability) {
        if (!availability.available) {
          biometricStatus = 'unavailable';
        } else if (!availability.enrolled) {
          // Distinguish "fingerprint removed after install" from
          // "never enrolled" via hasSecret: both land on the
          // BiometricUnavailable gate but the signal is the same UX copy.
          biometricStatus = 'not-enrolled';
        } else {
          biometricStatus = 'ready';
        }
      } else if (hasSecret) {
        // Native probe failed but a secret exists → assume ready; any
        // failure during the subsequent unlock will transition the state
        // via the vault's own error handling.
        biometricStatus = 'ready';
      }

      // -----------------------------------------------------------------
      // Orphaned-secret recovery (VAL-VAULT-028 + Round-7 Finding 2)
      //
      // If the app crashed between "native secret provisioned inside
      // `initializeFirstLaunch()`" and "`commitSetupInitialized()`
      // landed its SecureStorage write", the on-disk session would
      // hold `hasIdentity: false` while the native keystore already
      // holds a biometric-gated secret. A naive hydrate would then
      // route back to BiometricSetup and `initializeFirstLaunch()`
      // would skip the `agent.initialize({})` branch (since
      // `agent.firstLaunch()` returns `false` — the LevelDB entry
      // already exists), returning `recoveryPhrase = ''` and never
      // surfacing the phrase to the user.
      //
      // Round-7 Finding 2: the pre-fix orphan condition required
      // `committedHasCompletedOnboarding === true`, but
      // `completeOnboarding()` is fire-and-forget (its
      // `persistSession` swallows errors and the caller does not
      // await). A kill timeline that goes Welcome→continue (in-memory
      // flag flips, persist queued)→BiometricSetup→native secret
      // provisioned→kill (BEFORE the Welcome persist commits) leaves
      // us with `hasSecret=true` AND `committedHasCompletedOnboarding
      // === false` on relaunch, skipping orphan promotion and routing
      // back to Welcome→Setup where `agent.firstLaunch()` returns
      // `false` (LevelDB entry already exists) and the user never
      // sees their recovery phrase. Use the vault's own
      // `INITIALIZED_STORAGE_KEY='true'` sentinel — written
      // synchronously at the END of `_doInitialize()` — as a
      // parallel "vault was provisioned" signal so the orphan check
      // does not depend on a separate, possibly-pending write
      // landing first.
      //
      // The orphan now fires when ALL of these hold:
      //   - `hasIdentity === false` (the post-setup persist never landed).
      //   - `hasSecret === true` (the native keystore has a secret).
      //   - `vaultPriorInitialized === true` (the vault itself recorded
      //     a successful initialize via INITIALIZED, OR the vault has
      //     observed a biometric state at least once via biometricState
      //     ∈ {ready, invalidated}, OR the user got past Welcome via
      //     `committedHasCompletedOnboarding`). Any of these prove
      //     "this is not a fresh install".
      //
      // When the orphan fires we promote the session snapshot to
      // `{hasIdentity: true, isPendingFirstBackup: true}` so the
      // navigator routes to RecoveryPhrase where the resume-backup
      // flow (`agentStore.resumePendingBackup()`) can re-derive the
      // same mnemonic from the stored entropy. The promotion is
      // committed back to SecureStorage so subsequent relaunches see
      // the correct snapshot even if the resume flow itself is
      // interrupted.
      const committedHasCompletedOnboarding =
        session.hasCompletedOnboarding ?? false;
      const committedHasIdentity = session.hasIdentity ?? false;
      const committedIsPendingFirstBackup = Boolean(
        session.isPendingFirstBackup,
      );
      // Vault-side prior-init signals. ``rawVaultInitialized === 'true'``
      // is the authoritative one (set at the END of `_doInitialize()`
      // and never cleared except by `reset()`). The
      // `biometricState ∈ {ready, invalidated}` check is a fallback
      // for the rare case where the `INITIALIZED` write succeeded
      // earlier on this device but was somehow cleared while the
      // native secret was not — observed during testing on
      // SecureStorage-backend swaps.
      const vaultPriorInitialized =
        rawVaultInitialized === 'true' ||
        rawBiometricState === 'ready' ||
        rawBiometricState === 'invalidated';
      const isOrphanedSecret =
        !committedHasIdentity &&
        hasSecret &&
        (committedHasCompletedOnboarding || vaultPriorInitialized);

      const effectiveHasIdentity = committedHasIdentity || isOrphanedSecret;
      const effectiveIsPendingFirstBackup =
        committedIsPendingFirstBackup || isOrphanedSecret;
      // When the orphan fires via the vault-side signal but the
      // Welcome persist never landed, also flip
      // `hasCompletedOnboarding` back on. The user previously
      // engaged the setup flow far enough for `_doInitialize()` to
      // run to completion — they are categorically NOT on a fresh
      // install, so re-routing them through Welcome would be wrong.
      const effectiveHasCompletedOnboarding =
        committedHasCompletedOnboarding || isOrphanedSecret;

      set({
        hasCompletedOnboarding: effectiveHasCompletedOnboarding,
        hasIdentity: effectiveHasIdentity,
        // `isPendingFirstBackup` is optional on disk so older installs
        // (persisted before the field existed) hydrate as `false`, which
        // matches the semantic "already backed up / never provisioned".
        isPendingFirstBackup: effectiveIsPendingFirstBackup,
        biometricStatus,
        isHydrated: true,
      });

      // Fire-and-forget re-persist when we promoted an orphaned
      // secret — best-effort so a failure does not keep the user
      // from reaching RecoveryPhrase (the in-memory flip above has
      // already advanced the navigator). On subsequent launches,
      // `commitSetupInitialized()` effectively runs again because
      // `hydrate` re-evaluates the orphan condition.
      if (isOrphanedSecret) {
        console.warn(
          '[session] orphaned native secret detected; promoting to isPendingFirstBackup',
          {
            committedHasCompletedOnboarding,
            committedHasIdentity,
            hasSecret,
            vaultPriorInitialized,
          },
        );
        // `void` marks a deliberately-unawaited fire-and-forget promise.
        // eslint-disable-next-line no-void
        void persistSession({
          hasCompletedOnboarding: effectiveHasCompletedOnboarding,
          hasIdentity: true,
          isPendingFirstBackup: true,
        });
      }
    } catch {
      set({ isHydrated: true });
    }
  },

  completeOnboarding: () => {
    set({ hasCompletedOnboarding: true });
    const s = get();
    persistSession({
      hasCompletedOnboarding: s.hasCompletedOnboarding,
      hasIdentity: s.hasIdentity,
      isPendingFirstBackup: s.isPendingFirstBackup,
    });
  },

  unlockSession: () => set({ isLocked: false }),

  lock: () => set({ isLocked: true }),

  setHasIdentity: (value) => {
    set({ hasIdentity: value });
    const s = get();
    persistSession({
      hasCompletedOnboarding: s.hasCompletedOnboarding,
      hasIdentity: value,
      isPendingFirstBackup: s.isPendingFirstBackup,
    });
  },

  setPendingFirstBackup: async (value) => {
    set({ isPendingFirstBackup: value });
    const s = get();
    await persistSession({
      hasCompletedOnboarding: s.hasCompletedOnboarding,
      hasIdentity: s.hasIdentity,
      isPendingFirstBackup: value,
    });
  },

  commitSetupInitialized: async () => {
    // Flip BOTH flags in a single `set()` call so the navigator
    // never observes a half-transitioned render.
    set({ hasIdentity: true, isPendingFirstBackup: true });
    const s = get();
    await persistSession({
      hasCompletedOnboarding: s.hasCompletedOnboarding,
      hasIdentity: true,
      isPendingFirstBackup: true,
    });
  },

  setBiometricStatus: (next) => {
    set({ biometricStatus: next });
  },

  hydrateRestored: async () => {
    // Persist-BEFORE-flip ordering. The route-driving flags
    // (`biometricStatus`, `hasCompletedOnboarding`, `hasIdentity`,
    // `isLocked`) must NOT change until the SecureStorage write for
    // the onboarding/identity snapshot has fully committed. The
    // earlier "flip first, persist second" implementation had a
    // cold-kill race: AppNavigator re-rendered on the in-memory
    // setState, so a process kill that landed in the gap between
    // `setState` and the awaited `setSecureItem(SESSION_KEY, ...)`
    // commit would leave the user with a persisted legacy snapshot
    // while the in-memory UI had already left RecoveryRestore. On
    // relaunch, `hydrate()` would re-read the stale on-disk payload
    // and misroute the restored wallet.
    //
    // Contract:
    //   1. `await persistSessionOrThrow(...)` FIRST. If SecureStorage
    //      rejects, the route-driving flags stay exactly as the
    //      caller left them (no visible partial flip to the
    //      navigator) and the rejection propagates to the caller
    //      (typically `RecoveryRestoreScreen`, which renders a retry
    //      alert).
    //   2. Only on persist success do we atomically flip all four
    //      flags in a single `setState` call so the navigator's
    //      selectors observe a consistent snapshot.
    //
    // `persistSession` (non-throwing) is kept for fire-and-forget
    // callers — we must not use it here because a swallowed rejection
    // would make `hydrateRestored` resolve even though the on-disk
    // state is stale, which is the bug this helper exists to prevent.
    // Recovery-phrase restore gives us a wallet whose mnemonic the user
    // has JUST typed — they own the phrase, so there is nothing left to
    // back up. Always commit `isPendingFirstBackup: false` alongside the
    // identity/onboarding half so a kill/relaunch right after restore
    // never re-traps the user on RecoveryPhrase (VAL-VAULT-028).
    await persistSessionOrThrow({
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isPendingFirstBackup: false,
    });
    set({
      biometricStatus: 'ready',
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isPendingFirstBackup: false,
      isLocked: false,
    });
  },

  reset: async () => {
    await Promise.all([
      deleteSecureItem(SESSION_KEY),
      // Always clear the biometric-state flag so a post-reset install
      // does not resurrect an old `'invalidated'` signal.
      deleteSecureItem(BIOMETRIC_STATE_RAW_KEY).catch(() => undefined),
      // Round-8 Finding 5: also clear the vault's
      // `INITIALIZED_STORAGE_KEY` sentinel. Round-7 F2 added this
      // key as an orphan-detection signal in `hydrate()` (the
      // ``vaultPriorInitialized`` predicate), but the pre-fix
      // ``reset()`` only deleted the session and biometric-state
      // keys — leaving ``enbox.vault.initialized='true'`` resident
      // on disk. ``agentStore.reset()`` calls ``vault.reset()``
      // which does delete this key, but the session-store's
      // ``reset()`` is also called directly by tests and by
      // selected error-recovery paths. After such a direct reset,
      // a subsequent ``hydrate()`` would observe
      // ``vaultPriorInitialized=true`` AND no native secret (we
      // just reset) and fall through to the regular fresh-install
      // path — but only because ``hasSecret=false`` short-
      // circuits the orphan check first. The day a future change
      // makes ``hasSecret`` return ``true`` after a session reset
      // (e.g. orphaned native secret recovery interacts oddly
      // with a pending reset), the stale INITIALIZED would
      // trigger orphan promotion against a vault that should be
      // treated as fresh — silently re-routing the user to
      // RecoveryPhrase backup of a wallet they've not provisioned
      // in this lifecycle. Symmetric cleanup is the right
      // posture: anything ``hydrate()`` reads, ``reset()`` clears.
      deleteSecureItem(VAULT_INITIALIZED_RAW_KEY).catch(() => undefined),
    ]);
    set({
      isHydrated: true,
      hasCompletedOnboarding: false,
      hasIdentity: false,
      isLocked: true,
      isPendingFirstBackup: false,
      biometricStatus: 'unknown',
    });
  },
}));
