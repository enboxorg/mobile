/**
 * Biometric-first navigation gate matrix (VAL-UX-028).
 *
 * The navigator state machine is driven by a small derived snapshot
 * that combines the session-store signals (`biometricStatus`,
 * `hasCompletedOnboarding`, `isLocked`) with two per-launch signals
 * owned by the agent store (`vaultInitialized`, `pendingBackup`).
 *
 * Precedence (highest first):
 *   1. `unavailable` / `not-enrolled` → BiometricUnavailable (hard gate)
 *   2. `invalidated`                  → RecoveryRestore
 *   3. `unknown`                      → Loading (deferred — hydrate not done)
 *   4. `ready` + !hasCompletedOnboarding → Welcome
 *   5. `ready` + hasCompletedOnboarding + !vaultInitialized → BiometricSetup
 *   6. `ready` + vaultInitialized     + pendingBackup       → RecoveryPhrase
 *   7. `ready` + vaultInitialized     + isLocked            → biometric-unlock gate
 *   8. `ready` + vaultInitialized     + !isLocked           → Main
 *
 * The hard-gate rules (1) and (2) deliberately outrank every other
 * signal. A pending WalletConnect request, an in-flight agent, or a
 * deep link MUST NOT navigate away from these gates.
 */
export type AppRouteName =
  | 'Loading'
  | 'Welcome'
  | 'BiometricUnavailable'
  | 'BiometricSetup'
  | 'RecoveryPhrase'
  | 'BiometricUnlock'
  | 'RecoveryRestore'
  | 'Main';

export const BIOMETRIC_UNLOCK_ROUTE = 'BiometricUnlock' satisfies AppRouteName;

export interface SessionSnapshot {
  hasCompletedOnboarding: boolean;
  isLocked: boolean;
  /**
   * Whether the biometric vault secret exists on-device (i.e. a prior
   * `initializeFirstLaunch` / `restoreFromMnemonic` succeeded). This is
   * the persisted `hasIdentity` flag on the session store; it survives
   * cold launches.
   */
  vaultInitialized?: boolean;
  /**
   * Whether the current session is holding a freshly-generated mnemonic
   * that the user has not yet acknowledged. Drives the one-shot
   * `RecoveryPhrase` detour between `BiometricSetup` and `Main`.
   */
  pendingBackup?: boolean;
  biometricStatus?:
    | 'unknown'
    | 'unavailable'
    | 'not-enrolled'
    | 'ready'
    | 'invalidated';
}

export function getInitialRoute(snapshot: SessionSnapshot): AppRouteName {
  // (1) Hard gate: unavailable / not-enrolled outranks EVERY other
  // signal (see VAL-UX-030). The user cannot proceed without
  // enrolling a biometric on the device.
  if (
    snapshot.biometricStatus === 'unavailable' ||
    snapshot.biometricStatus === 'not-enrolled'
  ) {
    return 'BiometricUnavailable';
  }

  // (2) Invalidated → recovery-phrase-restore flow. Survives
  // relaunches via the persisted `enbox.vault.biometric-state` flag.
  if (snapshot.biometricStatus === 'invalidated') return 'RecoveryRestore';

  // (3) Hydrate not yet complete — defer routing to avoid a flash of
  // Welcome / BiometricSetup before the real signal lands.
  if (snapshot.biometricStatus === 'unknown') return 'Loading';

  // (4) First launch: show the Welcome pitch.
  if (!snapshot.hasCompletedOnboarding) return 'Welcome';

  // (5) Post-Welcome but no vault yet → enroll biometrics.
  if (!snapshot.vaultInitialized) return 'BiometricSetup';

  // (6) Vault exists but the mnemonic hasn't been confirmed yet.
  if (snapshot.pendingBackup) return 'RecoveryPhrase';

  // (7) Vault exists + session is locked → prompt biometrics.
  if (snapshot.isLocked) return BIOMETRIC_UNLOCK_ROUTE;

  // (8) Vault ready + unlocked → main wallet.
  return 'Main';
}
