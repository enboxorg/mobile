import { getInitialRoute } from '@/features/session/get-initial-route';

describe('getInitialRoute', () => {
  it('routes first-time users to Welcome', () => {
    expect(
      getInitialRoute({ hasCompletedOnboarding: false, hasPinSet: false, isLocked: true }),
    ).toBe('Welcome');
  });

  it('routes users without a PIN to CreatePin', () => {
    expect(
      getInitialRoute({ hasCompletedOnboarding: true, hasPinSet: false, isLocked: true }),
    ).toBe('CreatePin');
  });

  it('routes locked users to Unlock', () => {
    expect(
      getInitialRoute({ hasCompletedOnboarding: true, hasPinSet: true, isLocked: true }),
    ).toBe('Unlock');
  });

  it('routes unlocked users to Main', () => {
    expect(
      getInitialRoute({ hasCompletedOnboarding: true, hasPinSet: true, isLocked: false }),
    ).toBe('Main');
  });
});
