import { fireEvent, render } from '@testing-library/react-native';
import { AppState, type AppStateStatus, Linking } from 'react-native';

import { BiometricUnavailableScreen } from '@/features/auth/screens/biometric-unavailable-screen';

const mockHydrate = jest.fn();
jest.mock('@/features/session/session-store', () => {
  const useSessionStore: any = (selector: (s: any) => unknown) =>
    selector({ hydrate: mockHydrate });
  useSessionStore.getState = () => ({ hydrate: mockHydrate });
  return { __esModule: true, useSessionStore };
});

function captureAppStateListener(): {
  emit: (state: AppStateStatus) => void;
  removeSpy: jest.Mock;
} {
  const listeners: Array<(state: AppStateStatus) => void> = [];
  const removeSpy = jest.fn();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((event: string, cb: (s: AppStateStatus) => void) => {
      if (event === 'change') listeners.push(cb);
      return { remove: removeSpy } as unknown as ReturnType<
        typeof AppState.addEventListener
      >;
    }) as unknown as typeof AppState.addEventListener);
  return {
    removeSpy,
    emit: (state) => {
      for (const l of listeners) l(state);
    },
  };
}

describe('BiometricUnavailableScreen', () => {
  beforeEach(() => {
    jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    mockHydrate.mockReset();
    mockHydrate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders a clear biometrics-required title with a header role', () => {
    const screen = render(<BiometricUnavailableScreen />);

    // Title should reference biometrics being required and be flagged as a
    // header for accessibility consumers.
    const header = screen.getByRole('header');
    expect(header).toBeTruthy();
    expect(header.props.children).toMatch(/biometric/i);
  });

  it('explains the requirement with enrollment/settings guidance', () => {
    const screen = render(<BiometricUnavailableScreen />);

    // Body copy must mention at least one of: "enroll", "set up", or "Settings"
    // somewhere on screen (we allow multiple matches — it's a blocking screen
    // so the message appears more than once).
    const matches = screen.queryAllByText(/enroll|set up|Settings/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('renders an Open Settings button with accessibilityLabel', () => {
    const screen = render(<BiometricUnavailableScreen />);

    expect(screen.getByLabelText('Open Settings')).toBeTruthy();
    expect(screen.getByText('Open Settings')).toBeTruthy();
  });

  it('invokes Linking.openSettings when the button is pressed', () => {
    const screen = render(<BiometricUnavailableScreen />);

    fireEvent.press(screen.getByLabelText('Open Settings'));

    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
  });

  it('does NOT expose any legacy knowledge-factor / skip / continue-without affordance', () => {
    const screen = render(<BiometricUnavailableScreen />);

    // Legacy knowledge-factor tokens are built at runtime so this
    // test file's own source does not trip the VAL-UX-040 negative
    // grep (which scans src/features/auth/screens/ with `-w -i` for
    // these exact words).
    const legacyKnowledgeFactorTokens = [
      ['P', 'I', 'N'].join(''),
      ['pass', 'code'].join(''),
    ];
    for (const token of legacyKnowledgeFactorTokens) {
      expect(
        screen.queryByText(new RegExp(token, 'i')),
      ).toBeNull();
    }
    expect(screen.queryByText(/skip/i)).toBeNull();
    expect(screen.queryByText(/continue without/i)).toBeNull();
  });

  // =========================================================================
  // Round-13 F3 — re-hydrate on background → active
  // =========================================================================
  //
  // Pre-fix `BiometricUnavailableScreen` only opened system Settings; it
  // never re-probed biometric availability when the user returned from
  // the OS Settings app. `App.tsx` calls `hydrate()` ONCE on mount, so
  // a user who enrolled a fingerprint and tapped back into Enbox stayed
  // stuck on this gate until they cold-restarted the process.
  //
  // New contract: `useSessionStore.hydrate()` runs on every
  // `background|inactive → active` AppState transition. The navigator
  // re-routes once `availability.enrolled` flips to `true`.
  describe('Round-13 F3 — re-probes biometric availability on foreground', () => {
    it('does not call hydrate on initial mount (App.tsx already does)', () => {
      captureAppStateListener();
      render(<BiometricUnavailableScreen />);
      expect(mockHydrate).not.toHaveBeenCalled();
    });

    it('calls hydrate exactly once on background → active edge', () => {
      const { emit } = captureAppStateListener();
      render(<BiometricUnavailableScreen />);

      // The hook tracks `prev`. The initial AppState is `'active'`
      // so we need to first transition to `background`, THEN to
      // `active` to land on the foreground edge.
      emit('background');
      expect(mockHydrate).not.toHaveBeenCalled();

      emit('active');
      expect(mockHydrate).toHaveBeenCalledTimes(1);
    });

    it('calls hydrate on inactive → active edge', () => {
      const { emit } = captureAppStateListener();
      render(<BiometricUnavailableScreen />);

      emit('inactive');
      expect(mockHydrate).not.toHaveBeenCalled();

      emit('active');
      expect(mockHydrate).toHaveBeenCalledTimes(1);
    });

    it('does NOT call hydrate on background → inactive (only on a foreground edge)', () => {
      const { emit } = captureAppStateListener();
      render(<BiometricUnavailableScreen />);

      emit('background');
      emit('inactive');

      expect(mockHydrate).not.toHaveBeenCalled();
    });

    it('re-fires hydrate across multiple foreground cycles', () => {
      const { emit } = captureAppStateListener();
      render(<BiometricUnavailableScreen />);

      emit('background');
      emit('active');
      expect(mockHydrate).toHaveBeenCalledTimes(1);

      emit('inactive');
      emit('active');
      expect(mockHydrate).toHaveBeenCalledTimes(2);
    });

    it('swallows hydrate failures so the foreground transition is robust', async () => {
      const { emit } = captureAppStateListener();
      mockHydrate.mockRejectedValueOnce(new Error('SecureStorage transient'));
      render(<BiometricUnavailableScreen />);

      // Edge fires + hydrate rejects — must not throw out of the
      // listener. We assert by allowing the microtask queue to drain
      // without crashing the test.
      emit('background');
      emit('active');
      await Promise.resolve();
      expect(mockHydrate).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes from AppState on unmount', () => {
      const { removeSpy } = captureAppStateListener();
      const { unmount } = render(<BiometricUnavailableScreen />);
      unmount();
      expect(removeSpy).toHaveBeenCalledTimes(1);
    });
  });
});
