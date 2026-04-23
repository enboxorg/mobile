import { create } from 'zustand';

import NativeBiometricVault from '@specs/NativeBiometricVault';
import {
  deleteSecureItem,
  getSecureItem,
  setSecureItem,
} from '@/lib/storage/secure-storage';

const SESSION_KEY = 'session:state';

/**
 * Keychain/Keystore alias that holds the wallet's root biometric-gated
 * secret. Duplicated from `src/lib/enbox/biometric-vault.ts` on purpose:
 * importing the vault module here would pull in the ESM-only
 * `@enbox/agent` runtime, which breaks Jest's module resolution for
 * session-store tests. The two constants MUST stay in sync.
 */
const WALLET_ROOT_KEY_ALIAS = 'enbox.wallet.root';

/**
 * Raw SecureStorage key where BiometricVault persists its `biometricState`
 * signal (via `@enbox/auth` SecureStorageAdapter which prefixes keys with
 * `enbox:`). Session-store reads the raw key directly so it can gate the
 * navigator on invalidated state before any biometric prompt fires.
 */
const BIOMETRIC_STATE_RAW_KEY = 'enbox:enbox.vault.biometric-state';

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
  /** Biometric availability state (driven by hydrate + vault signals). */
  biometricStatus: BiometricStatus;

  hydrate: () => Promise<void>;
  completeOnboarding: () => void;
  unlockSession: () => void;
  lock: () => void;
  setHasIdentity: (value: boolean) => void;
  /** Transition the biometric status exposed to the navigator. */
  setBiometricStatus: (next: BiometricStatus) => void;
  /**
   * Atomically commit the post-recovery-restore session snapshot.
   *
   * Applies all four session flags — `biometricStatus: 'ready'`,
   * `hasCompletedOnboarding: true`, `hasIdentity: true`,
   * `isLocked: false` — in a single `setState`, then awaits
   * `persistSession()` so the underlying
   * `setSecureItem(SESSION_KEY, ...)` write has fully committed to
   * SecureStorage before the promise resolves. Callers (notably
   * `RecoveryRestoreScreen`) MUST await this helper before handing
   * control back to the navigator so a cold kill immediately after
   * restore cannot rehydrate stale flags.
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
 * never produce an unhandled rejection). Callers that MUST observe the
 * commit before proceeding (notably `hydrateRestored`, which is awaited
 * by `RecoveryRestoreScreen` before it hands control back to the
 * navigator) should `await` the returned promise.
 */
function persistSession(state: PersistedSessionState): Promise<void> {
  return setSecureItem(SESSION_KEY, JSON.stringify(state)).catch((err) => {
    console.warn('[session] persist failed:', err);
  });
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
  biometricStatus: 'unknown',

  hydrate: async () => {
    try {
      const [rawSession, rawBiometricState] = await Promise.all([
        getSecureItem(SESSION_KEY),
        getSecureItem(BIOMETRIC_STATE_RAW_KEY),
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

      set({
        hasCompletedOnboarding: session.hasCompletedOnboarding ?? false,
        hasIdentity: session.hasIdentity ?? false,
        biometricStatus,
        isHydrated: true,
      });
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
    });
  },

  setBiometricStatus: (next) => {
    set({ biometricStatus: next });
  },

  hydrateRestored: async () => {
    // One atomic state transition followed by one persist call — see
    // the docstring on `SessionState.hydrateRestored` for the rationale.
    // We await `persistSession` so the underlying SecureStorage write
    // has fully committed before the promise resolves; callers rely on
    // that guarantee to defeat the cold-kill durability race where a
    // relaunch running `hydrate()` against a not-yet-written SESSION_KEY
    // would rehydrate stale flags.
    set({
      biometricStatus: 'ready',
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isLocked: false,
    });
    await persistSession({
      hasCompletedOnboarding: true,
      hasIdentity: true,
    });
  },

  reset: async () => {
    await Promise.all([
      deleteSecureItem(SESSION_KEY),
      // Always clear the biometric-state flag so a post-reset install
      // does not resurrect an old `'invalidated'` signal.
      deleteSecureItem(BIOMETRIC_STATE_RAW_KEY).catch(() => undefined),
    ]);
    set({
      isHydrated: true,
      hasCompletedOnboarding: false,
      hasIdentity: false,
      isLocked: true,
      biometricStatus: 'unknown',
    });
  },
}));
