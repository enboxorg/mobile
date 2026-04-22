/**
 * Tests for `useAutoLock`.
 *
 * Contract pinned here (VAL-UX-035, VAL-VAULT-020, VAL-VAULT-021):
 *
 *   - On every `active → background` OR `active → inactive` AppState
 *     transition, the hook MUST call BOTH
 *     `useSessionStore.getState().lock()` AND
 *     `useAgentStore.getState().teardown()` exactly once.
 *   - Transitions between two non-active states (e.g. `inactive →
 *     background`) MUST NOT fire a second teardown — the agent has
 *     already been disposed.
 *   - `background → active` is a no-op (the next unlock will re-create
 *     the agent via `unlockAgent()` which, in turn, calls the native
 *     biometric prompt again).
 *   - When the session is already locked (`isLocked === true`) at the
 *     time of a background/inactive event, neither `lock()` nor
 *     `teardown()` is called (avoids redundant state churn and log
 *     noise).
 *   - The hook MUST NOT reference `AUTO_LOCK_TIMEOUT_MS`. Timer-based
 *     grace periods are removed; lock-immediately semantics only.
 */

import { AppState, type AppStateStatus } from 'react-native';
import { renderHook } from '@testing-library/react-native';

// ---------------------------------------------------------------------------
// Store mocks. We replace both stores with a minimal `getState()` surface so
// the hook's spies are easy to assert on without pulling in the full
// zustand-backed modules (which would boot the biometric vault / @enbox/*
// runtime).
// ---------------------------------------------------------------------------

const mockLock = jest.fn();
const mockTeardown = jest.fn();
let mockIsLocked = false;

jest.mock('@/features/session/session-store', () => {
  const getState = () => ({
    lock: mockLock,
    isLocked: mockIsLocked,
  });
  return {
    __esModule: true,
    useSessionStore: { getState },
  };
});

jest.mock('@/lib/enbox/agent-store', () => {
  const getState = () => ({
    teardown: mockTeardown,
  });
  return {
    __esModule: true,
    useAgentStore: { getState },
  };
});

// ---------------------------------------------------------------------------
// AppState listener capture — drive the subscribed listener synchronously so
// we can assert call-counts per transition without relying on any real RN
// AppState implementation.
// ---------------------------------------------------------------------------

type ChangeListener = (state: AppStateStatus) => void;

function captureAppStateListener(): {
  emit: (state: AppStateStatus) => void;
  removeSpy: jest.Mock;
} {
  const listeners: ChangeListener[] = [];
  const removeSpy = jest.fn();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((event: string, cb: ChangeListener) => {
      if (event === 'change') listeners.push(cb);
      return { remove: removeSpy } as unknown as ReturnType<
        typeof AppState.addEventListener
      >;
    }) as unknown as typeof AppState.addEventListener);

  return {
    removeSpy,
    emit: (state: AppStateStatus) => {
      for (const l of listeners) l(state);
    },
  };
}

// ---------------------------------------------------------------------------
// Module under test — imported AFTER the store mocks are registered.
// ---------------------------------------------------------------------------

import { useAutoLock } from '@/hooks/use-auto-lock';

beforeEach(() => {
  mockLock.mockReset();
  mockTeardown.mockReset();
  mockIsLocked = false;
});

describe('useAutoLock', () => {
  it('calls session.lock() + agent.teardown() exactly once on active → background', () => {
    const { emit } = captureAppStateListener();
    renderHook(() => useAutoLock());

    emit('background');

    expect(mockLock).toHaveBeenCalledTimes(1);
    expect(mockTeardown).toHaveBeenCalledTimes(1);
  });

  it('calls session.lock() + agent.teardown() exactly once on active → inactive', () => {
    const { emit } = captureAppStateListener();
    renderHook(() => useAutoLock());

    emit('inactive');

    expect(mockLock).toHaveBeenCalledTimes(1);
    expect(mockTeardown).toHaveBeenCalledTimes(1);
  });

  it('does NOT double-teardown on active → inactive → background (single foreground→background transition)', () => {
    const { emit } = captureAppStateListener();
    renderHook(() => useAutoLock());

    emit('inactive');
    emit('background');

    expect(mockLock).toHaveBeenCalledTimes(1);
    expect(mockTeardown).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on background → active (foreground returns without re-locking)', () => {
    const { emit } = captureAppStateListener();
    renderHook(() => useAutoLock());

    emit('background');
    expect(mockLock).toHaveBeenCalledTimes(1);
    expect(mockTeardown).toHaveBeenCalledTimes(1);

    emit('active');
    expect(mockLock).toHaveBeenCalledTimes(1);
    expect(mockTeardown).toHaveBeenCalledTimes(1);
  });

  it('re-fires teardown when the app cycles active → background → active → inactive', () => {
    const { emit } = captureAppStateListener();
    renderHook(() => useAutoLock());

    emit('background');
    expect(mockLock).toHaveBeenCalledTimes(1);
    expect(mockTeardown).toHaveBeenCalledTimes(1);

    emit('active');
    expect(mockLock).toHaveBeenCalledTimes(1);
    expect(mockTeardown).toHaveBeenCalledTimes(1);

    emit('inactive');
    expect(mockLock).toHaveBeenCalledTimes(2);
    expect(mockTeardown).toHaveBeenCalledTimes(2);
  });

  it('skips teardown when session is already locked at the time of the background event', () => {
    mockIsLocked = true;
    const { emit } = captureAppStateListener();
    renderHook(() => useAutoLock());

    emit('background');

    expect(mockLock).not.toHaveBeenCalled();
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('skips teardown on inactive when the session is already locked', () => {
    mockIsLocked = true;
    const { emit } = captureAppStateListener();
    renderHook(() => useAutoLock());

    emit('inactive');

    expect(mockLock).not.toHaveBeenCalled();
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('unsubscribes from AppState on unmount', () => {
    const { emit, removeSpy } = captureAppStateListener();
    const { unmount } = renderHook(() => useAutoLock());

    unmount();
    expect(removeSpy).toHaveBeenCalledTimes(1);

    // Post-unmount events must be benign — even if our capture still
    // holds the closure, the hook must not track any state anymore.
    // (The subscription.remove() call on the real AppState guarantees
    // this in production.)
    emit('background');
    // Whether or not the stale listener fires in this capture harness,
    // it's fine because unmount cleanup is the contract under test.
  });
});

describe('useAutoLock — static contract', () => {
  it('does not reference AUTO_LOCK_TIMEOUT_MS in the hook source (VAL-UX-035 static grep)', () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    /* eslint-enable @typescript-eslint/no-var-requires */

    const source = fs.readFileSync(
      path.resolve(__dirname, '../use-auto-lock.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/AUTO_LOCK_TIMEOUT_MS/);
  });
});
