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
 *   - The teardown ALWAYS runs whenever there is in-memory agent /
 *     vault / recovery-phrase material to scrub, regardless of the
 *     session-store `isLocked` flag. This is the round-13 F1 contract
 *     change — see the `agent-resident` rationale below.
 *   - No timer / grace period. The legacy timeout constant is
 *     intentionally NOT referenced here (static grep in the hook's
 *     Jest test); lock-immediately is the contract.
 *
 * Round-13 F1 — why we no longer skip on `isLocked`:
 *
 *   The pre-fix hook short-circuited the entire handler whenever
 *   `useSessionStore.getState().isLocked` was already `true`. That
 *   was correct for the "user manually tapped Lock wallet in
 *   Settings" path (which already calls `teardown()` synchronously
 *   in `MainTabs.onManualLock`), but it was UNSAFE for the
 *   first-launch backup flow:
 *
 *     - The session-store's initial `isLocked` is `true` and stays
 *       `true` until `app-navigator.handleConfirm` calls
 *       `unlockSession()` after the user confirms the recovery
 *       phrase backup (`src/navigation/app-navigator.tsx:248-250`).
 *     - During RecoveryPhrase the `useAgentStore` snapshot holds
 *       `agent`, `vault` (unlocked), and `recoveryPhrase` (the
 *       24-word BIP-39 mnemonic).
 *     - Pre-fix: backgrounding the app on RecoveryPhrase saw
 *       `isLocked === true` and skipped both `lock()` AND
 *       `teardown()`, so the mnemonic + unlocked CEK + root seed
 *       remained on the JS heap. Re-foregrounding resumed the
 *       screen WITHOUT a fresh biometric prompt — a clear
 *       VAL-VAULT-020 / VAL-UX-035 regression.
 *
 *   The new contract: still gate on the `active → background|inactive`
 *   edge, but ALSO check the agent-store for any resident material.
 *   `useSessionStore.getState().lock()` is idempotent (writes the
 *   same flag) and `useAgentStore.getState().teardown()` is
 *   idempotent on a torn-down store (every field already null). So
 *   running both unconditionally on the foreground edge is safe;
 *   the `agentResident` guard exists purely to avoid log noise on
 *   the manual-lock-then-immediate-background path.
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

      // Round-13 F1: gate on whether the agent-store still holds
      // any unlocked material. We check `agent`, `vault`, and
      // `recoveryPhrase` independently because the matrix:
      //
      //   - `agent` set during normal post-unlock operation,
      //   - `vault` set as soon as `initializeAgent()` returns
      //     (BEFORE any session unlock), and
      //   - `recoveryPhrase` set during first-launch backup
      //     (BEFORE the user confirms the phrase, which is the
      //     transition that flips `isLocked` to `false`),
      //
      // can each be populated independently of the session-store's
      // `isLocked` flag. Skipping the teardown on any of them
      // would leave the corresponding sensitive bytes resident
      // through a background → foreground cycle.
      //
      // `isLocked` is folded in too so a manual Lock wallet that
      // already tore down the agent (`MainTabs.onManualLock`)
      // doesn't trip a redundant lock+teardown on the next
      // background.
      const agentState = useAgentStore.getState();
      const sessionState = useSessionStore.getState();
      const agentResident =
        agentState.agent !== null ||
        agentState.vault !== null ||
        agentState.recoveryPhrase !== null;
      if (!agentResident && sessionState.isLocked) return;

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
