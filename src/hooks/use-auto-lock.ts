import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { useAgentStore } from '@/lib/enbox/agent-store';
import { useSessionStore } from '@/features/session/session-store';

/**
 * Auto-lock hook.
 *
 * On every `AppState` transition from `'active'` to either `'background'`
 * or `'inactive'`, the hook calls BOTH:
 *
 *   1. `useSessionStore.getState().lock()`      — flips `isLocked: true`.
 *   2. `useAgentStore.getState().teardown()`    — disposes the Web5/DWN
 *                                                 agent + unlocked vault
 *                                                 material so the next
 *                                                 foreground requires a
 *                                                 fresh biometric prompt.
 *
 * Guarantees (VAL-UX-035, VAL-VAULT-020, VAL-VAULT-021):
 *
 *   - Exactly one lock + teardown per `active → background|inactive`
 *     transition. Repeated transitions between non-active states (e.g.
 *     `inactive → background`) do NOT double-teardown.
 *   - When the session is already locked at the time of a
 *     background/inactive event, BOTH actions are skipped — the agent
 *     has already been disposed (or is about to be) by the prior
 *     transition.
 *   - No timer / grace period. The legacy timeout constant is
 *     intentionally NOT referenced here (static grep in the hook's
 *     Jest test); lock-immediately is the contract.
 *
 * The hook intentionally does NOT consume selectors via
 * `useSessionStore(s => s.lock)` — reading from `.getState()` inside
 * the AppState callback avoids re-subscribing the effect every time
 * one of the stores updates.
 */
export function useAutoLock(): void {
  // Track the previous AppState so we only fire on a true
  // `active → background|inactive` edge. The hook is always mounted
  // with the app in the foreground, so the initial state is `'active'`.
  // Any teardown-bearing transition must therefore begin from
  // `'active'`.
  const lastAppState = useRef<AppStateStatus>('active');

  useEffect(() => {
    function handleAppStateChange(next: AppStateStatus): void {
      const prev = lastAppState.current;
      lastAppState.current = next;

      // Only act on `active → background|inactive` edges. Any other
      // transition (e.g. `inactive → background`, `background →
      // active`, `active → active`) is a no-op for auto-lock.
      if (prev !== 'active') return;
      if (next !== 'background' && next !== 'inactive') return;

      // If the session is already locked, skip — a prior transition
      // has already torn down the agent and flipped the session state.
      // This defends against any edge where `prev` was somehow kept as
      // `'active'` while the store was locked by another code path
      // (e.g. manual lock via Settings).
      if (useSessionStore.getState().isLocked) return;

      useSessionStore.getState().lock();
      useAgentStore.getState().teardown();
    }

    const subscription = AppState.addEventListener(
      'change',
      handleAppStateChange,
    );
    return () => subscription.remove();
  }, []);
}
