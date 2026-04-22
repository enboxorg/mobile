import { getInitialRoute } from '@/features/session/get-initial-route';

describe('getInitialRoute', () => {
  it('routes first-time users to Welcome', () => {
    expect(
      getInitialRoute({ hasCompletedOnboarding: false, isLocked: true }),
    ).toBe('Welcome');
  });

  it('routes onboarded users to Main', () => {
    expect(
      getInitialRoute({ hasCompletedOnboarding: true, isLocked: false }),
    ).toBe('Main');
  });

  it('routes biometricStatus=`invalidated` to RecoveryRestore (takes precedence)', () => {
    expect(
      getInitialRoute({
        hasCompletedOnboarding: true,
        isLocked: true,
        biometricStatus: 'invalidated',
      }),
    ).toBe('RecoveryRestore');
  });

  it('routes biometricStatus=`unavailable` to BiometricUnavailable', () => {
    expect(
      getInitialRoute({
        hasCompletedOnboarding: true,
        isLocked: true,
        biometricStatus: 'unavailable',
      }),
    ).toBe('BiometricUnavailable');
  });

  it('routes biometricStatus=`not-enrolled` to BiometricUnavailable', () => {
    expect(
      getInitialRoute({
        hasCompletedOnboarding: false,
        isLocked: true,
        biometricStatus: 'not-enrolled',
      }),
    ).toBe('BiometricUnavailable');
  });

  it('falls through to onboarding when biometricStatus=`ready` and onboarding not complete', () => {
    expect(
      getInitialRoute({
        hasCompletedOnboarding: false,
        isLocked: true,
        biometricStatus: 'ready',
      }),
    ).toBe('Welcome');
  });

  it('falls through to Main when biometricStatus=`ready` and onboarding complete', () => {
    expect(
      getInitialRoute({
        hasCompletedOnboarding: true,
        isLocked: false,
        biometricStatus: 'ready',
      }),
    ).toBe('Main');
  });
});
