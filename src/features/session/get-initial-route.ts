export type AppRouteName =
  | 'Welcome'
  | 'CreatePin'
  | 'Unlock'
  | 'Main'
  | 'BiometricUnavailable'
  | 'RecoveryRestore';

export interface SessionSnapshot {
  hasCompletedOnboarding: boolean;
  hasPinSet: boolean;
  isLocked: boolean;
  /**
   * Optional biometric status propagated from the session store. When
   * absent, the legacy PIN routing matrix is used (back-compat for the
   * current PIN-era UI still present in Milestone 3).
   */
  biometricStatus?:
    | 'unknown'
    | 'unavailable'
    | 'not-enrolled'
    | 'ready'
    | 'invalidated';
}

export function getInitialRoute(snapshot: SessionSnapshot): AppRouteName {
  // Biometric gates take precedence when a status is supplied. These
  // gates are authoritative — they block any further routing decisions.
  if (snapshot.biometricStatus === 'invalidated') return 'RecoveryRestore';
  if (
    snapshot.biometricStatus === 'unavailable' ||
    snapshot.biometricStatus === 'not-enrolled'
  ) {
    return 'BiometricUnavailable';
  }

  // Legacy PIN-era routing (biometric status is 'unknown' or 'ready').
  if (!snapshot.hasCompletedOnboarding) return 'Welcome';
  if (!snapshot.hasPinSet) return 'CreatePin';
  if (snapshot.isLocked) return 'Unlock';
  return 'Main';
}
