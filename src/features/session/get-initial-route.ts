export type AppRouteName =
  | 'Welcome'
  | 'Main'
  | 'BiometricUnavailable'
  | 'RecoveryRestore';

export interface SessionSnapshot {
  hasCompletedOnboarding: boolean;
  isLocked: boolean;
  /**
   * Biometric availability gate propagated from the session store. When
   * `'invalidated'` it forces the recovery-restore flow; `'unavailable'`
   * and `'not-enrolled'` both route to the BiometricUnavailable gate.
   * Any other value (including `'unknown'` / `'ready'`) falls through to
   * the onboarding → main routing based on `hasCompletedOnboarding`.
   */
  biometricStatus?:
    | 'unknown'
    | 'unavailable'
    | 'not-enrolled'
    | 'ready'
    | 'invalidated';
}

export function getInitialRoute(snapshot: SessionSnapshot): AppRouteName {
  // Biometric gates take precedence. These gates are authoritative —
  // they block any further routing decisions.
  if (snapshot.biometricStatus === 'invalidated') return 'RecoveryRestore';
  if (
    snapshot.biometricStatus === 'unavailable' ||
    snapshot.biometricStatus === 'not-enrolled'
  ) {
    return 'BiometricUnavailable';
  }

  if (!snapshot.hasCompletedOnboarding) return 'Welcome';
  return 'Main';
}
