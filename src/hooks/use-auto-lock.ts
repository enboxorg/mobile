import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { AUTO_LOCK_TIMEOUT_MS } from '@/constants/auth';
import { useSessionStore } from '@/features/session/session-store';

/**
 * Locks the session when the app moves to the background.
 *
 * If AUTO_LOCK_TIMEOUT_MS is 0, locks immediately on background.
 * If > 0, locks after the timeout elapses while backgrounded.
 */
export function useAutoLock() {
  const lock = useSessionStore((s) => s.lock);
  const isLocked = useSessionStore((s) => s.isLocked);
  const backgroundedAt = useRef<number | null>(null);

  useEffect(() => {
    function handleAppStateChange(next: AppStateStatus) {
      if (isLocked) return;

      if (next === 'background' || next === 'inactive') {
        if (AUTO_LOCK_TIMEOUT_MS === 0) {
          lock();
        } else {
          backgroundedAt.current = Date.now();
        }
      } else if (next === 'active' && backgroundedAt.current !== null) {
        const elapsed = Date.now() - backgroundedAt.current;
        backgroundedAt.current = null;
        if (elapsed >= AUTO_LOCK_TIMEOUT_MS) {
          lock();
        }
      }
    }

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [lock, isLocked]);
}
