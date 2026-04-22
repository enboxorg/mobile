import { create } from 'zustand';

import { LOCKOUT_SCHEDULE_MS, MAX_UNLOCK_ATTEMPTS } from '@/constants/auth';
import { hashPin, verifyPin } from '@/lib/auth/pin-hash';
import { isValidPinFormat } from '@/lib/auth/pin-format';
import NativeBiometricVault from '@specs/NativeBiometricVault';
import {
  deleteSecureItem,
  getSecureItem,
  setSecureItem,
} from '@/lib/storage/secure-storage';

const SESSION_KEY = 'session:state';
const PIN_HASH_KEY = 'auth:pin-hash';
const LOCKOUT_KEY = 'auth:lockout';

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

// --- Persisted state shapes ---

interface PersistedSessionState {
  hasCompletedOnboarding: boolean;
  hasIdentity: boolean;
}

function isPersistedSessionState(value: unknown): value is PersistedSessionState {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).hasCompletedOnboarding === 'boolean' &&
    typeof (value as Record<string, unknown>).hasIdentity === 'boolean'
  );
}

interface LockoutState {
  failedAttempts: number;
  lockedUntil: number | null;
  lockoutCycle: number;
}

function isLockoutState(value: unknown): value is LockoutState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.failedAttempts === 'number' &&
    (v.lockedUntil === null || typeof v.lockedUntil === 'number') &&
    typeof v.lockoutCycle === 'number'
  );
}

// --- Store ---

export interface SessionState {
  isHydrated: boolean;
  hasCompletedOnboarding: boolean;
  hasPinSet: boolean;
  isLocked: boolean;
  hasIdentity: boolean;
  failedAttempts: number;
  lockedUntil: number | null;
  lockoutCycle: number;
  /** Biometric availability state (driven by hydrate + vault signals). */
  biometricStatus: BiometricStatus;

  hydrate: () => Promise<void>;
  completeOnboarding: () => void;
  createPin: (pin: string) => Promise<void>;
  unlock: (pin: string) => Promise<boolean>;
  unlockSession: () => void;
  lock: () => void;
  setHasIdentity: (value: boolean) => void;
  /** Transition the biometric status exposed to the navigator. */
  setBiometricStatus: (next: BiometricStatus) => void;
  reset: () => Promise<void>;
}

function persistSession(state: PersistedSessionState): void {
  setSecureItem(SESSION_KEY, JSON.stringify(state)).catch((err) => {
    console.warn('[session] persist failed:', err);
  });
}

function persistLockout(state: LockoutState): void {
  setSecureItem(LOCKOUT_KEY, JSON.stringify(state)).catch((err) => {
    console.warn('[session] lockout persist failed:', err);
  });
}

function getLockoutDuration(cycle: number): number {
  return LOCKOUT_SCHEDULE_MS[Math.min(cycle, LOCKOUT_SCHEDULE_MS.length - 1)];
}

/**
 * Detect a persisted `session:state` payload produced by the legacy
 * PIN-era session store (fields `hasPinSet` / `failedAttempts` /
 * `lockedUntil` / `lockoutCycle` / `pinHash`). Parsing a biometric-era
 * payload returns `false`.
 */
function isLegacyPinSessionPayload(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const v = raw as Record<string, unknown>;
  return (
    'hasPinSet' in v ||
    'failedAttempts' in v ||
    'lockedUntil' in v ||
    'lockoutCycle' in v ||
    'pinHash' in v
  );
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
  hasPinSet: false,
  isLocked: true,
  hasIdentity: false,
  failedAttempts: 0,
  lockedUntil: null,
  lockoutCycle: 0,
  biometricStatus: 'unknown',

  hydrate: async () => {
    try {
      const [rawSession, rawPin, rawLockout, rawBiometricState] =
        await Promise.all([
          getSecureItem(SESSION_KEY),
          getSecureItem(PIN_HASH_KEY),
          getSecureItem(LOCKOUT_KEY),
          getSecureItem(BIOMETRIC_STATE_RAW_KEY),
        ]);

      // -----------------------------------------------------------------
      // Legacy PIN-era migration
      // -----------------------------------------------------------------
      // Detect any of the three legacy keys (auth:pin-hash, auth:lockout,
      // session:state containing PIN-era fields) and wipe them in one
      // pass. The user's previous PIN-encrypted vault is not recoverable
      // from biometrics alone, so we return the navigator to a clean
      // onboarding state and surface a recovery-restore prompt if the
      // wallet had already completed onboarding.
      let session: Partial<PersistedSessionState> = {};
      let sessionWasLegacy = false;
      if (rawSession) {
        try {
          const parsed: unknown = JSON.parse(rawSession);
          if (isLegacyPinSessionPayload(parsed)) {
            sessionWasLegacy = true;
            // Preserve the `hasCompletedOnboarding` / `hasIdentity` bits
            // so a legacy wallet that reached Main at least keeps those
            // markers; everything else is dropped.
            if (isPersistedSessionState(parsed)) {
              session = {
                hasCompletedOnboarding: parsed.hasCompletedOnboarding,
                hasIdentity: parsed.hasIdentity,
              };
            } else if (typeof (parsed as any).hasCompletedOnboarding === 'boolean') {
              session = {
                hasCompletedOnboarding: (parsed as any).hasCompletedOnboarding,
                hasIdentity: Boolean((parsed as any).hasIdentity),
              };
            }
          } else if (isPersistedSessionState(parsed)) {
            session = parsed;
          }
        } catch {
          // ignore parse errors
        }
      }

      const hadLegacyPinHash = rawPin !== null;
      const hadLegacyLockout = rawLockout !== null;
      const isLegacyMigration =
        sessionWasLegacy || hadLegacyPinHash || hadLegacyLockout;

      if (isLegacyMigration) {
        // Delete every legacy storage key. Best-effort — any failure is
        // logged but does not block hydrate from completing.
        const deletions = [PIN_HASH_KEY, LOCKOUT_KEY];
        if (sessionWasLegacy) deletions.push(SESSION_KEY);
        await Promise.all(
          deletions.map((key) =>
            deleteSecureItem(key).catch((err) => {
              console.warn(
                `[session] legacy migration: deleteSecureItem(${key}) failed:`,
                err,
              );
            }),
          ),
        );

        // Persist the migrated (biometric-era) session payload so future
        // hydrates read a clean record instead of re-triggering migration.
        if (sessionWasLegacy) {
          persistSession({
            hasCompletedOnboarding: session.hasCompletedOnboarding ?? false,
            hasIdentity: session.hasIdentity ?? false,
          });
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
        biometricStatus = 'invalidated';
      } else if (availability) {
        if (!availability.available) {
          biometricStatus = 'unavailable';
        } else if (!availability.enrolled) {
          // Distinguish "fingerprint removed after install" from
          // "never enrolled" via hasSecret: the former implies the user
          // previously had a working vault, the latter is a first-launch
          // state. Both land on the BiometricUnavailable gate but
          // surface `'not-enrolled'` for telemetry / UX copy.
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

      // Never silently route a legacy-PIN user into the fresh-install
      // flow: if they had a completed onboarding on PIN, we flag their
      // biometric state as `'invalidated'` so the navigator renders the
      // RecoveryRestore screen and asks for their recovery phrase.
      if (
        isLegacyMigration &&
        biometricStatus === 'ready' &&
        (session.hasCompletedOnboarding || hadLegacyPinHash)
      ) {
        biometricStatus = 'invalidated';
      }

      // -----------------------------------------------------------------
      // Commit final hydrated state
      // -----------------------------------------------------------------
      let lockout: LockoutState = {
        failedAttempts: 0,
        lockedUntil: null,
        lockoutCycle: 0,
      };
      if (!isLegacyMigration && rawLockout) {
        try {
          const parsed: unknown = JSON.parse(rawLockout);
          if (isLockoutState(parsed)) {
            if (parsed.lockedUntil !== null && Date.now() >= parsed.lockedUntil) {
              lockout = {
                failedAttempts: 0,
                lockedUntil: null,
                lockoutCycle: parsed.lockoutCycle,
              };
              persistLockout(lockout);
            } else {
              lockout = parsed;
            }
          }
        } catch {
          // ignore
        }
      }

      set({
        hasCompletedOnboarding: session.hasCompletedOnboarding ?? false,
        hasIdentity: session.hasIdentity ?? false,
        // Post-migration, all PIN-era flags reset to defaults so the
        // consumer never observes a stale PIN state.
        hasPinSet: isLegacyMigration ? false : rawPin !== null,
        failedAttempts: lockout.failedAttempts,
        lockedUntil: lockout.lockedUntil,
        lockoutCycle: lockout.lockoutCycle,
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
    persistSession({ hasCompletedOnboarding: s.hasCompletedOnboarding, hasIdentity: s.hasIdentity });
  },

  createPin: async (pin) => {
    if (!isValidPinFormat(pin)) {
      throw new Error('Invalid PIN format');
    }
    const hashed = await hashPin(pin);
    await setSecureItem(PIN_HASH_KEY, hashed);
    // Persist the PIN immediately so onboarding survives later vault-init failures.
    // Keep the session locked until the vault is actually initialized.
    set({ hasPinSet: true, isLocked: true, failedAttempts: 0, lockedUntil: null, lockoutCycle: 0 });
    persistLockout({ failedAttempts: 0, lockedUntil: null, lockoutCycle: 0 });
  },

  unlock: async (pin) => {
    if (!isValidPinFormat(pin)) return false;

    const s = get();
    if (s.lockedUntil !== null && Date.now() < s.lockedUntil) return false;

    const storedHash = await getSecureItem(PIN_HASH_KEY);
    if (!storedHash) return false;

    const match = await verifyPin(pin, storedHash);

    if (match) {
      // The caller unlocks the session only after the agent/vault is ready.
      set({ failedAttempts: 0, lockedUntil: null, lockoutCycle: 0 });
      persistLockout({ failedAttempts: 0, lockedUntil: null, lockoutCycle: 0 });
      return true;
    }

    // Failed attempt — exponential lockout
    const attempts = s.failedAttempts + 1;
    if (attempts >= MAX_UNLOCK_ATTEMPTS) {
      const cycle = s.lockoutCycle;
      const duration = getLockoutDuration(cycle);
      const until = Date.now() + duration;
      set({ failedAttempts: 0, lockedUntil: until, lockoutCycle: cycle + 1 });
      persistLockout({ failedAttempts: 0, lockedUntil: until, lockoutCycle: cycle + 1 });
    } else {
      set({ failedAttempts: attempts });
      persistLockout({ failedAttempts: attempts, lockedUntil: null, lockoutCycle: s.lockoutCycle });
    }

    return false;
  },

  unlockSession: () => set({ isLocked: false }),

  lock: () => set({ isLocked: true }),

  setHasIdentity: (value) => {
    set({ hasIdentity: value });
    const s = get();
    persistSession({ hasCompletedOnboarding: s.hasCompletedOnboarding, hasIdentity: value });
  },

  setBiometricStatus: (next) => {
    set({ biometricStatus: next });
  },

  reset: async () => {
    await Promise.all([
      deleteSecureItem(SESSION_KEY),
      deleteSecureItem(PIN_HASH_KEY),
      deleteSecureItem(LOCKOUT_KEY),
      // Always clear the biometric-state flag so a post-reset install
      // does not resurrect an old `'invalidated'` signal.
      deleteSecureItem(BIOMETRIC_STATE_RAW_KEY).catch(() => undefined),
    ]);
    set({
      isHydrated: true,
      hasCompletedOnboarding: false,
      hasPinSet: false,
      isLocked: true,
      hasIdentity: false,
      failedAttempts: 0,
      lockedUntil: null,
      lockoutCycle: 0,
      biometricStatus: 'unknown',
    });
  },
}));
