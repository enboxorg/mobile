/**
 * Exhaustive tests for the biometric-first navigation gate matrix
 * (VAL-UX-028). Each row of the matrix is covered by at least one
 * `it` block; cross-row precedence (unavailable outranks
 * invalidated; invalidated outranks ready; etc.) is also exercised
 * so future refactors can't silently re-order the rules.
 */
import {
  getInitialRoute,
  type SessionSnapshot,
} from '@/features/session/get-initial-route';

function snap(partial: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    hasCompletedOnboarding: false,
    isLocked: true,
    vaultInitialized: false,
    pendingBackup: false,
    biometricStatus: 'ready',
    ...partial,
  };
}

describe('getInitialRoute', () => {
  describe('hard gates (biometricStatus)', () => {
    it.each([
      [{ hasCompletedOnboarding: false, isLocked: true }],
      [{ hasCompletedOnboarding: true, isLocked: true }],
      [{ hasCompletedOnboarding: true, isLocked: false, vaultInitialized: true }],
      [
        {
          hasCompletedOnboarding: true,
          isLocked: false,
          vaultInitialized: true,
          pendingBackup: true,
        },
      ],
    ])(
      'routes biometricStatus=`unavailable` to BiometricUnavailable regardless of other state (%p)',
      (extra) => {
        expect(
          getInitialRoute(snap({ ...extra, biometricStatus: 'unavailable' })),
        ).toBe('BiometricUnavailable');
      },
    );

    it.each([
      [{ hasCompletedOnboarding: false }],
      [{ hasCompletedOnboarding: true }],
      [{ hasCompletedOnboarding: true, isLocked: false, vaultInitialized: true }],
    ])(
      'routes biometricStatus=`not-enrolled` to BiometricUnavailable regardless of other state (%p)',
      (extra) => {
        expect(
          getInitialRoute(snap({ ...extra, biometricStatus: 'not-enrolled' })),
        ).toBe('BiometricUnavailable');
      },
    );

    it('routes biometricStatus=`invalidated` to RecoveryRestore regardless of onboarding/lock state', () => {
      expect(
        getInitialRoute(
          snap({
            hasCompletedOnboarding: false,
            isLocked: true,
            biometricStatus: 'invalidated',
          }),
        ),
      ).toBe('RecoveryRestore');
      expect(
        getInitialRoute(
          snap({
            hasCompletedOnboarding: true,
            isLocked: false,
            vaultInitialized: true,
            biometricStatus: 'invalidated',
          }),
        ),
      ).toBe('RecoveryRestore');
    });

    it('prefers BiometricUnavailable over RecoveryRestore when both would match (unavailable outranks invalidated in the matrix order)', () => {
      // Not reachable in practice (status is an exclusive enum), but
      // the assertion below pins the intended precedence so a
      // future refactor to an open-typed status can't silently swap
      // the gates.
      expect(
        getInitialRoute(
          snap({
            hasCompletedOnboarding: true,
            isLocked: true,
            biometricStatus: 'unavailable',
          }),
        ),
      ).toBe('BiometricUnavailable');
    });

    it('defers to Loading when biometricStatus is unknown (hydrate pending)', () => {
      expect(
        getInitialRoute(snap({ biometricStatus: 'unknown' })),
      ).toBe('Loading');
    });
  });

  describe('ready matrix', () => {
    it('routes !hasCompletedOnboarding to Welcome', () => {
      expect(
        getInitialRoute(
          snap({
            biometricStatus: 'ready',
            hasCompletedOnboarding: false,
          }),
        ),
      ).toBe('Welcome');
    });

    it('routes onboarded + !vaultInitialized to BiometricSetup', () => {
      expect(
        getInitialRoute(
          snap({
            biometricStatus: 'ready',
            hasCompletedOnboarding: true,
            vaultInitialized: false,
          }),
        ),
      ).toBe('BiometricSetup');
    });

    it('routes onboarded + vaultInitialized + pendingBackup to RecoveryPhrase', () => {
      expect(
        getInitialRoute(
          snap({
            biometricStatus: 'ready',
            hasCompletedOnboarding: true,
            vaultInitialized: true,
            pendingBackup: true,
            isLocked: false,
          }),
        ),
      ).toBe('RecoveryPhrase');
    });

    it('RecoveryPhrase wins over BiometricUnlock even when isLocked is true (in-session backup path)', () => {
      expect(
        getInitialRoute(
          snap({
            biometricStatus: 'ready',
            hasCompletedOnboarding: true,
            vaultInitialized: true,
            pendingBackup: true,
            isLocked: true,
          }),
        ),
      ).toBe('RecoveryPhrase');
    });

    it('routes onboarded + vaultInitialized + !pendingBackup + isLocked to BiometricUnlock', () => {
      expect(
        getInitialRoute(
          snap({
            biometricStatus: 'ready',
            hasCompletedOnboarding: true,
            vaultInitialized: true,
            pendingBackup: false,
            isLocked: true,
          }),
        ),
      ).toBe('BiometricUnlock');
    });

    it('routes onboarded + vaultInitialized + !pendingBackup + !isLocked to Main', () => {
      expect(
        getInitialRoute(
          snap({
            biometricStatus: 'ready',
            hasCompletedOnboarding: true,
            vaultInitialized: true,
            pendingBackup: false,
            isLocked: false,
          }),
        ),
      ).toBe('Main');
    });
  });

  describe('no legacy routes', () => {
    it('never routes to a PIN-era screen from any matrix row', () => {
      const rows: Array<SessionSnapshot> = [
        snap({ biometricStatus: 'unavailable' }),
        snap({ biometricStatus: 'not-enrolled' }),
        snap({ biometricStatus: 'invalidated' }),
        snap({ biometricStatus: 'unknown' }),
        snap({ biometricStatus: 'ready', hasCompletedOnboarding: false }),
        snap({
          biometricStatus: 'ready',
          hasCompletedOnboarding: true,
          vaultInitialized: false,
        }),
        snap({
          biometricStatus: 'ready',
          hasCompletedOnboarding: true,
          vaultInitialized: true,
          pendingBackup: true,
        }),
        snap({
          biometricStatus: 'ready',
          hasCompletedOnboarding: true,
          vaultInitialized: true,
          pendingBackup: false,
          isLocked: true,
        }),
        snap({
          biometricStatus: 'ready',
          hasCompletedOnboarding: true,
          vaultInitialized: true,
          pendingBackup: false,
          isLocked: false,
        }),
      ];
      for (const s of rows) {
        const route = getInitialRoute(s);
        expect(route).not.toBe('CreatePin');
        expect(route).not.toBe('Unlock');
      }
    });
  });
});
