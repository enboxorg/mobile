import { create } from 'zustand';

import { LOCKOUT_SCHEDULE_MS, MAX_UNLOCK_ATTEMPTS } from '@/constants/auth';
import { hashPin, verifyPin } from '@/lib/auth/pin-hash';
import { isValidPinFormat } from '@/lib/auth/pin-format';
import {
  deleteSecureItem,
  getSecureItem,
  setSecureItem,
} from '@/lib/storage/secure-storage';

const SESSION_KEY = 'session:state';
const PIN_HASH_KEY = 'auth:pin-hash';
const LOCKOUT_KEY = 'auth:lockout';

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

  hydrate: () => Promise<void>;
  completeOnboarding: () => void;
  createPin: (pin: string) => Promise<void>;
  unlock: (pin: string) => Promise<boolean>;
  lock: () => void;
  setHasIdentity: (value: boolean) => void;
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

export const useSessionStore = create<SessionState>((set, get) => ({
  isHydrated: false,
  hasCompletedOnboarding: false,
  hasPinSet: false,
  isLocked: true,
  hasIdentity: false,
  failedAttempts: 0,
  lockedUntil: null,
  lockoutCycle: 0,

  hydrate: async () => {
    try {
      const [rawSession, rawPin, rawLockout] = await Promise.all([
        getSecureItem(SESSION_KEY),
        getSecureItem(PIN_HASH_KEY),
        getSecureItem(LOCKOUT_KEY),
      ]);

      let session: Partial<PersistedSessionState> = {};
      if (rawSession) {
        const parsed: unknown = JSON.parse(rawSession);
        if (isPersistedSessionState(parsed)) session = parsed;
      }

      let lockout: LockoutState = { failedAttempts: 0, lockedUntil: null, lockoutCycle: 0 };
      if (rawLockout) {
        const parsed: unknown = JSON.parse(rawLockout);
        if (isLockoutState(parsed)) {
          if (parsed.lockedUntil !== null && Date.now() >= parsed.lockedUntil) {
            lockout = { failedAttempts: 0, lockedUntil: null, lockoutCycle: parsed.lockoutCycle };
            persistLockout(lockout);
          } else {
            lockout = parsed;
          }
        }
      }

      set({
        hasCompletedOnboarding: session.hasCompletedOnboarding ?? false,
        hasIdentity: session.hasIdentity ?? false,
        hasPinSet: rawPin !== null,
        failedAttempts: lockout.failedAttempts,
        lockedUntil: lockout.lockedUntil,
        lockoutCycle: lockout.lockoutCycle,
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
    set({ hasPinSet: true, isLocked: false, failedAttempts: 0, lockedUntil: null, lockoutCycle: 0 });
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
      set({ isLocked: false, failedAttempts: 0, lockedUntil: null, lockoutCycle: 0 });
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

  lock: () => set({ isLocked: true }),

  setHasIdentity: (value) => {
    set({ hasIdentity: value });
    const s = get();
    persistSession({ hasCompletedOnboarding: s.hasCompletedOnboarding, hasIdentity: value });
  },

  reset: async () => {
    await Promise.all([
      deleteSecureItem(SESSION_KEY),
      deleteSecureItem(PIN_HASH_KEY),
      deleteSecureItem(LOCKOUT_KEY),
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
    });
  },
}));
