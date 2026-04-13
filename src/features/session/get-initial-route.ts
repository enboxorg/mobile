export type AppRouteName = 'Welcome' | 'CreatePin' | 'Unlock' | 'Main';

export interface SessionSnapshot {
  hasCompletedOnboarding: boolean;
  hasPinSet: boolean;
  isLocked: boolean;
}

export function getInitialRoute(snapshot: SessionSnapshot): AppRouteName {
  if (!snapshot.hasCompletedOnboarding) return 'Welcome';
  if (!snapshot.hasPinSet) return 'CreatePin';
  if (snapshot.isLocked) return 'Unlock';
  return 'Main';
}
