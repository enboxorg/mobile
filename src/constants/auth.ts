export const PIN_LENGTH = 4;

export const MAX_UNLOCK_ATTEMPTS = 5;

/** Lockout durations in ms, indexed by consecutive lockout cycle (0-based). */
export const LOCKOUT_SCHEDULE_MS = [
  30_000,   // 30 seconds
  60_000,   // 1 minute
  300_000,  // 5 minutes
  900_000,  // 15 minutes
  3600_000, // 1 hour
] as const;

/** Default auto-lock timeout when the app moves to background (ms). */
export const AUTO_LOCK_TIMEOUT_MS = 0; // 0 = lock immediately on background
