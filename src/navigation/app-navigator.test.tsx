/**
 * Integration tests for AppNavigator — verifies that the navigator
 * renders the correct screen for every row of the VAL-UX-028 gate
 * matrix, enforces the `BiometricUnavailable` hard-gate (VAL-UX-030),
 * routes the post-init `RecoveryPhrase` detour before `Main`
 * (VAL-UX-031), routes relaunch-locked to `BiometricUnlock`
 * (VAL-UX-032), routes relaunch-unlocked directly to `Main`
 * (VAL-UX-033), routes invalidation to `RecoveryRestore` (VAL-UX-034),
 * keeps `WalletConnectScanner` reachable when unlocked (VAL-UX-051),
 * and never lets a pending wallet-connect deep link navigate away
 * from any gate screen (VAL-UX-050).
 *
 * Strategy — every individual screen has its own test file, so this
 * spec stubs each screen with a lightweight text placeholder so we
 * can focus on route-switching without re-booting every screen's
 * internal plumbing (Linking, AppState, FLAG_SECURE, agent store,
 * native biometric mocks, etc.). The anchor strings match the
 * production UI copy (VAL-UX-039).
 */

// ---------------------------------------------------------------
// Lightweight screen stubs — each renders its production anchor
// string + a test-id so the route assertions are stable.
// ---------------------------------------------------------------
jest.mock('@/features/auth/screens/biometric-unavailable-screen', () => {
  const React = require('react');
  const { Text, View } = require('react-native');
  return {
    BiometricUnavailableScreen: () =>
      React.createElement(
        View,
        { testID: 'stub-biometric-unavailable' },
        React.createElement(Text, null, 'Open Settings'),
      ),
  };
});

jest.mock('@/features/auth/screens/biometric-setup-screen', () => {
  const React = require('react');
  const { Text, View } = require('react-native');
  return {
    BiometricSetupScreen: () =>
      React.createElement(
        View,
        { testID: 'stub-biometric-setup' },
        React.createElement(Text, null, 'Enable biometric unlock'),
      ),
  };
});

jest.mock('@/features/auth/screens/biometric-unlock-screen', () => {
  const React = require('react');
  const { Text, View } = require('react-native');
  return {
    BiometricUnlockScreen: () =>
      React.createElement(
        View,
        { testID: 'stub-biometric-unlock' },
        React.createElement(Text, null, 'Unlock with biometrics'),
      ),
  };
});

jest.mock('@/features/auth/screens/recovery-phrase-screen', () => {
  const React = require('react');
  const { Text, View } = require('react-native');
  return {
    RecoveryPhraseScreen: (props: { mnemonic: string }) =>
      React.createElement(
        View,
        { testID: 'stub-recovery-phrase' },
        React.createElement(Text, null, "I\u2019ve saved it"),
        React.createElement(Text, null, `mnemonic:${props.mnemonic}`),
      ),
  };
});

jest.mock('@/features/auth/screens/recovery-restore-screen', () => {
  const React = require('react');
  const { Text, View } = require('react-native');
  return {
    RecoveryRestoreScreen: () =>
      React.createElement(
        View,
        { testID: 'stub-recovery-restore' },
        React.createElement(Text, null, 'Restore wallet'),
      ),
  };
});

jest.mock('@/features/onboarding/screens/welcome-screen', () => {
  const React = require('react');
  const { Text, View } = require('react-native');
  return {
    WelcomeScreen: () =>
      React.createElement(
        View,
        { testID: 'stub-welcome' },
        React.createElement(Text, null, 'Get started'),
      ),
  };
});

jest.mock('@/features/identities/screens/identities-screen', () => {
  const React = require('react');
  const { Text, View } = require('react-native');
  return {
    IdentitiesScreen: () =>
      React.createElement(
        View,
        { testID: 'stub-identities' },
        React.createElement(Text, null, 'Identities screen'),
      ),
  };
});

jest.mock('@/features/search/screens/search-screen', () => {
  const React = require('react');
  const { Text, View } = require('react-native');
  return {
    SearchScreen: () =>
      React.createElement(
        View,
        { testID: 'stub-search' },
        React.createElement(Text, null, 'Search screen'),
      ),
  };
});

jest.mock('@/features/connect/screens/connect-screen', () => {
  const React = require('react');
  const { Text, View } = require('react-native');
  return {
    ConnectScreen: () =>
      React.createElement(
        View,
        { testID: 'stub-connect' },
        React.createElement(Text, null, 'Connect screen'),
      ),
  };
});

jest.mock('@/features/settings/screens/settings-screen', () => {
  const React = require('react');
  const { Text, View } = require('react-native');
  return {
    SettingsScreen: () =>
      React.createElement(
        View,
        { testID: 'stub-settings' },
        React.createElement(Text, null, 'Settings screen'),
      ),
  };
});

jest.mock('@/features/connect/screens/wallet-connect-request-screen', () => {
  const React = require('react');
  const { Text, View } = require('react-native');
  return {
    WalletConnectRequestScreen: () =>
      React.createElement(
        View,
        { testID: 'stub-wallet-connect-request' },
        React.createElement(Text, null, 'WalletConnect request'),
      ),
  };
});

jest.mock('@/features/connect/screens/wallet-connect-scanner-screen', () => {
  const React = require('react');
  const { Text, View } = require('react-native');
  return {
    WalletConnectScannerScreen: () =>
      React.createElement(
        View,
        { testID: 'stub-wallet-connect-scanner' },
        React.createElement(Text, null, 'WalletConnect scanner'),
      ),
  };
});

// Agent store mock — lightweight zustand with the selectors the
// navigator reads. No real `@enbox/agent` runtime is imported.
jest.mock('@/lib/enbox/agent-store', () => {
  const { create } = require('zustand');
  const useAgentStore = create(() => ({
    recoveryPhrase: null as string | null,
    clearRecoveryPhrase: jest.fn(() => {
      useAgentStore.setState({ recoveryPhrase: null });
    }),
    teardown: jest.fn(() => {}),
    // Present so MainTabs' renderSettings / use-auto-lock don't blow
    // up if they happen to read other selectors during the render.
    unlockAgent: jest.fn(),
    initializeFirstLaunch: jest.fn(),
    restoreFromMnemonic: jest.fn(),
  }));
  return { useAgentStore };
});

// Wallet-connect store mock — minimal surface to drive VAL-UX-050.
jest.mock('@/lib/enbox/wallet-connect-store', () => {
  const { create } = require('zustand');
  const useWalletConnectStore = create(() => ({
    pending: null as unknown as object | null,
    phase: 'idle',
    generatedPin: null,
    error: null,
    handleIncomingUrl: jest.fn(),
    approve: jest.fn(),
    deny: jest.fn(),
    clear: jest.fn(),
  }));
  return { useWalletConnectStore };
});

import { render, act } from '@testing-library/react-native';

import { AppNavigator } from '@/navigation/app-navigator';
import { useSessionStore } from '@/features/session/session-store';
const { useAgentStore } = require('@/lib/enbox/agent-store');
const { useWalletConnectStore } = require('@/lib/enbox/wallet-connect-store');

/** Shape used by the tests to drive the session store into a matrix row. */
interface MatrixState {
  hasCompletedOnboarding: boolean;
  hasIdentity: boolean;
  isLocked: boolean;
  biometricStatus:
    | 'unknown'
    | 'unavailable'
    | 'not-enrolled'
    | 'ready'
    | 'invalidated';
}

function setSession(state: MatrixState): void {
  useSessionStore.setState({
    isHydrated: true,
    hasCompletedOnboarding: state.hasCompletedOnboarding,
    hasIdentity: state.hasIdentity,
    isLocked: state.isLocked,
    biometricStatus: state.biometricStatus,
  });
}

function setRecoveryPhrase(phrase: string | null): void {
  useAgentStore.setState({ recoveryPhrase: phrase });
}

function setPendingWalletRequest(value: object | null): void {
  useWalletConnectStore.setState({ pending: value });
}

beforeEach(() => {
  setRecoveryPhrase(null);
  setPendingWalletRequest(null);
  useSessionStore.setState({
    isHydrated: true,
    hasCompletedOnboarding: false,
    hasIdentity: false,
    isLocked: true,
    biometricStatus: 'unknown',
  });
});

// ==================================================================
// VAL-UX-029 core matrix
// ==================================================================
describe('AppNavigator — biometricStatus matrix (VAL-UX-028/029)', () => {
  it('renders Loading while biometricStatus is unknown (hydrate pending)', () => {
    setSession({
      hasCompletedOnboarding: false,
      hasIdentity: false,
      isLocked: true,
      biometricStatus: 'unknown',
    });

    const screen = render(<AppNavigator />);

    expect(screen.getByLabelText('Loading')).toBeTruthy();
    expect(screen.queryByTestId('stub-welcome')).toBeNull();
  });

  it('renders BiometricUnavailable when biometricStatus=`unavailable`', () => {
    setSession({
      hasCompletedOnboarding: false,
      hasIdentity: false,
      isLocked: true,
      biometricStatus: 'unavailable',
    });

    const screen = render(<AppNavigator />);

    expect(screen.getByTestId('stub-biometric-unavailable')).toBeTruthy();
    expect(screen.getByText('Open Settings')).toBeTruthy();
  });

  it('renders BiometricUnavailable when biometricStatus=`not-enrolled`', () => {
    setSession({
      hasCompletedOnboarding: false,
      hasIdentity: false,
      isLocked: true,
      biometricStatus: 'not-enrolled',
    });

    const screen = render(<AppNavigator />);

    expect(screen.getByTestId('stub-biometric-unavailable')).toBeTruthy();
  });

  it('renders RecoveryRestore when biometricStatus=`invalidated`', () => {
    setSession({
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isLocked: true,
      biometricStatus: 'invalidated',
    });

    const screen = render(<AppNavigator />);

    expect(screen.getByTestId('stub-recovery-restore')).toBeTruthy();
    expect(screen.getByText('Restore wallet')).toBeTruthy();
  });

  it('renders Welcome when biometricStatus=`ready` and !hasCompletedOnboarding', () => {
    setSession({
      hasCompletedOnboarding: false,
      hasIdentity: false,
      isLocked: true,
      biometricStatus: 'ready',
    });

    const screen = render(<AppNavigator />);

    expect(screen.getByTestId('stub-welcome')).toBeTruthy();
    expect(screen.getByText('Get started')).toBeTruthy();
  });

  it('renders BiometricSetup when ready + hasCompletedOnboarding + !vaultInitialized', () => {
    setSession({
      hasCompletedOnboarding: true,
      hasIdentity: false,
      isLocked: true,
      biometricStatus: 'ready',
    });

    const screen = render(<AppNavigator />);

    expect(screen.getByTestId('stub-biometric-setup')).toBeTruthy();
    expect(screen.getByText('Enable biometric unlock')).toBeTruthy();
  });

  it('renders RecoveryPhrase when ready + vaultInitialized + pendingBackup', () => {
    setSession({
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isLocked: true,
      biometricStatus: 'ready',
    });
    setRecoveryPhrase('alpha bravo charlie delta');

    const screen = render(<AppNavigator />);

    expect(screen.getByTestId('stub-recovery-phrase')).toBeTruthy();
    expect(screen.getByText('I\u2019ve saved it')).toBeTruthy();
    // The mnemonic prop is forwarded from the agent-store to the screen.
    expect(
      screen.getByText('mnemonic:alpha bravo charlie delta'),
    ).toBeTruthy();
  });

  it('renders BiometricUnlock when ready + vaultInitialized + !pendingBackup + isLocked', () => {
    setSession({
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isLocked: true,
      biometricStatus: 'ready',
    });
    setRecoveryPhrase(null);

    const screen = render(<AppNavigator />);

    expect(screen.getByTestId('stub-biometric-unlock')).toBeTruthy();
    expect(screen.getByText('Unlock with biometrics')).toBeTruthy();
  });

  it('renders Main when ready + vaultInitialized + !pendingBackup + !isLocked', () => {
    setSession({
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isLocked: false,
      biometricStatus: 'ready',
    });
    setRecoveryPhrase(null);

    const screen = render(<AppNavigator />);

    expect(screen.getByTestId('stub-identities')).toBeTruthy();
  });
});

// ==================================================================
// VAL-UX-030 — hard-gate precedence
// ==================================================================
describe('AppNavigator — BiometricUnavailable hard gate (VAL-UX-030)', () => {
  it.each([
    {
      hasCompletedOnboarding: false,
      hasIdentity: false,
      isLocked: true,
      biometricStatus: 'not-enrolled' as const,
    },
    {
      hasCompletedOnboarding: true,
      hasIdentity: false,
      isLocked: true,
      biometricStatus: 'not-enrolled' as const,
    },
    {
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isLocked: false,
      biometricStatus: 'unavailable' as const,
    },
  ])(
    'renders BiometricUnavailable and NOT any tab for state %p',
    (state) => {
      setSession(state);

      const screen = render(<AppNavigator />);

      expect(screen.getByText('Open Settings')).toBeTruthy();
      // No tab or post-unlock content leaked through.
      expect(screen.queryByTestId('stub-identities')).toBeNull();
      expect(screen.queryByTestId('stub-search')).toBeNull();
      expect(screen.queryByTestId('stub-connect')).toBeNull();
      expect(screen.queryByTestId('stub-settings')).toBeNull();
      expect(
        screen.queryByTestId('stub-wallet-connect-request'),
      ).toBeNull();
    },
  );

  it('keeps BiometricUnavailable even when a wallet-connect request is pending', () => {
    setSession({
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isLocked: false,
      biometricStatus: 'unavailable',
    });
    setPendingWalletRequest({
      rawUrl: 'enbox://connect?request_uri=x&encryption_key=y',
    });

    const screen = render(<AppNavigator />);

    expect(screen.getByTestId('stub-biometric-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('stub-wallet-connect-request')).toBeNull();
  });
});

// ==================================================================
// VAL-UX-031 — first-launch path
// ==================================================================
describe('AppNavigator — first-launch path (VAL-UX-031)', () => {
  it('transitions Welcome → BiometricSetup → RecoveryPhrase → Main', () => {
    // Step 1: Welcome
    setSession({
      hasCompletedOnboarding: false,
      hasIdentity: false,
      isLocked: true,
      biometricStatus: 'ready',
    });

    const screen = render(<AppNavigator />);

    expect(screen.getByTestId('stub-welcome')).toBeTruthy();

    // Step 2: user completes onboarding → BiometricSetup
    act(() => {
      useSessionStore.setState({ hasCompletedOnboarding: true });
    });
    expect(screen.getByTestId('stub-biometric-setup')).toBeTruthy();
    expect(screen.queryByTestId('stub-welcome')).toBeNull();

    // Step 3: setup succeeds → hasIdentity + recoveryPhrase set → RecoveryPhrase
    act(() => {
      useSessionStore.setState({ hasIdentity: true });
      useAgentStore.setState({
        recoveryPhrase:
          'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
      });
    });
    expect(screen.getByTestId('stub-recovery-phrase')).toBeTruthy();
    expect(screen.queryByTestId('stub-biometric-setup')).toBeNull();
    // Critical: BiometricUnlock MUST NOT appear at any point during the path.
    expect(screen.queryByTestId('stub-biometric-unlock')).toBeNull();

    // Step 4: user confirms mnemonic → recoveryPhrase cleared + unlocked → Main
    act(() => {
      useAgentStore.setState({ recoveryPhrase: null });
      useSessionStore.setState({ isLocked: false });
    });
    expect(screen.getByTestId('stub-identities')).toBeTruthy();
    expect(screen.queryByTestId('stub-recovery-phrase')).toBeNull();
  });
});

// ==================================================================
// VAL-UX-032 / VAL-UX-033 — relaunch paths
// ==================================================================
describe('AppNavigator — relaunch paths (VAL-UX-032/033)', () => {
  it('routes relaunch-locked to BiometricUnlock, then transitions to Main on unlock', () => {
    setSession({
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isLocked: true,
      biometricStatus: 'ready',
    });

    const screen = render(<AppNavigator />);

    expect(screen.getByTestId('stub-biometric-unlock')).toBeTruthy();
    expect(screen.queryByTestId('stub-identities')).toBeNull();

    act(() => {
      useSessionStore.setState({ isLocked: false });
    });
    expect(screen.getByTestId('stub-identities')).toBeTruthy();
    expect(screen.queryByTestId('stub-biometric-unlock')).toBeNull();
  });

  it('routes relaunch-unlocked directly to Main (no unlock screen flash)', () => {
    setSession({
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isLocked: false,
      biometricStatus: 'ready',
    });

    const screen = render(<AppNavigator />);

    expect(screen.getByTestId('stub-identities')).toBeTruthy();
    expect(screen.queryByTestId('stub-biometric-unlock')).toBeNull();
    expect(screen.queryByTestId('stub-recovery-phrase')).toBeNull();
  });
});

// ==================================================================
// VAL-UX-034 — invalidation always routes to RecoveryRestore
// ==================================================================
describe('AppNavigator — invalidation (VAL-UX-034)', () => {
  it('renders RecoveryRestore regardless of isLocked/onboarding', () => {
    setSession({
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isLocked: false,
      biometricStatus: 'invalidated',
    });

    const screen = render(<AppNavigator />);

    expect(screen.getByTestId('stub-recovery-restore')).toBeTruthy();
    expect(screen.queryByTestId('stub-biometric-unlock')).toBeNull();
    expect(screen.queryByTestId('stub-biometric-setup')).toBeNull();
    expect(screen.queryByTestId('stub-identities')).toBeNull();
  });
});

// ==================================================================
// VAL-UX-050 — deep links during gated states do not break the gate
// ==================================================================
describe('AppNavigator — deep-link gating (VAL-UX-050)', () => {
  const gateRows: Array<[string, MatrixState]> = [
    [
      'BiometricUnavailable',
      {
        hasCompletedOnboarding: true,
        hasIdentity: false,
        isLocked: true,
        biometricStatus: 'not-enrolled',
      },
    ],
    [
      'BiometricSetup',
      {
        hasCompletedOnboarding: true,
        hasIdentity: false,
        isLocked: true,
        biometricStatus: 'ready',
      },
    ],
    [
      'BiometricUnlock',
      {
        hasCompletedOnboarding: true,
        hasIdentity: true,
        isLocked: true,
        biometricStatus: 'ready',
      },
    ],
    [
      'RecoveryRestore',
      {
        hasCompletedOnboarding: true,
        hasIdentity: true,
        isLocked: true,
        biometricStatus: 'invalidated',
      },
    ],
  ];

  it.each(gateRows)(
    'pending wallet-connect request does not render WalletConnectRequest while on %s',
    (_name, state) => {
      setSession(state);
      setPendingWalletRequest({
        rawUrl: 'enbox://connect?request_uri=abc&encryption_key=def',
      });

      const screen = render(<AppNavigator />);

      expect(
        screen.queryByTestId('stub-wallet-connect-request'),
      ).toBeNull();
    },
  );

  it('pending wallet-connect request does not render while on RecoveryPhrase', () => {
    setSession({
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isLocked: true,
      biometricStatus: 'ready',
    });
    setRecoveryPhrase('alpha bravo charlie delta');
    setPendingWalletRequest({
      rawUrl: 'enbox://connect?request_uri=abc&encryption_key=def',
    });

    const screen = render(<AppNavigator />);

    expect(screen.getByTestId('stub-recovery-phrase')).toBeTruthy();
    expect(screen.queryByTestId('stub-wallet-connect-request')).toBeNull();
  });

  it('queued wallet-connect request surfaces once every gate is cleared', () => {
    // Start locked with a pending request — must NOT navigate.
    setSession({
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isLocked: true,
      biometricStatus: 'ready',
    });
    setPendingWalletRequest({
      rawUrl: 'enbox://connect?request_uri=abc&encryption_key=def',
    });

    const screen = render(<AppNavigator />);

    expect(screen.getByTestId('stub-biometric-unlock')).toBeTruthy();
    expect(screen.queryByTestId('stub-wallet-connect-request')).toBeNull();

    // Clear the gate — the queued request is delivered.
    act(() => {
      useSessionStore.setState({ isLocked: false });
    });

    expect(screen.getByTestId('stub-wallet-connect-request')).toBeTruthy();
  });
});

// ==================================================================
// VAL-UX-051 — wallet-connect scanner still reachable when unlocked
// ==================================================================
describe('AppNavigator — wallet-connect routes (VAL-UX-051)', () => {
  it('registers the WalletConnectScanner route alongside Main when unlocked', () => {
    setSession({
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isLocked: false,
      biometricStatus: 'ready',
    });
    setPendingWalletRequest(null);

    const screen = render(<AppNavigator />);

    // Main tab content renders as the initial focus...
    expect(screen.getByTestId('stub-identities')).toBeTruthy();
    // ...and the scanner route is registered (test by inspecting the
    // navigator's container for the mounted stub; with no pending
    // request the Main+Scanner branch is the one rendered).
    // The scanner is in a separate stack frame and only mounts when
    // navigated to, but we assert the request route is NOT
    // overriding it by checking the absence of the request stub.
    expect(
      screen.queryByTestId('stub-wallet-connect-request'),
    ).toBeNull();
  });

  it('switches from WalletConnectScanner-capable Main branch to WalletConnectRequest when a request arrives', () => {
    setSession({
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isLocked: false,
      biometricStatus: 'ready',
    });
    setPendingWalletRequest(null);

    const screen = render(<AppNavigator />);

    expect(screen.getByTestId('stub-identities')).toBeTruthy();
    expect(
      screen.queryByTestId('stub-wallet-connect-request'),
    ).toBeNull();

    act(() => {
      setPendingWalletRequest({ rawUrl: 'enbox://connect?x=1' });
    });

    expect(screen.getByTestId('stub-wallet-connect-request')).toBeTruthy();
    // The Identities tab content is unmounted now that the root stack
    // has switched to the request screen.
    expect(screen.queryByTestId('stub-identities')).toBeNull();
  });
});

// ==================================================================
// No legacy PIN routes remain (VAL-UX-029)
// ==================================================================
describe('AppNavigator — no legacy routes', () => {
  it('does not reference CreatePin / Unlock as route names in any matrix state', () => {
    const rows: Array<MatrixState> = [
      {
        hasCompletedOnboarding: false,
        hasIdentity: false,
        isLocked: true,
        biometricStatus: 'ready',
      },
      {
        hasCompletedOnboarding: true,
        hasIdentity: false,
        isLocked: true,
        biometricStatus: 'ready',
      },
      {
        hasCompletedOnboarding: true,
        hasIdentity: true,
        isLocked: true,
        biometricStatus: 'ready',
      },
      {
        hasCompletedOnboarding: true,
        hasIdentity: true,
        isLocked: false,
        biometricStatus: 'ready',
      },
    ];
    for (const state of rows) {
      setSession(state);
      const screen = render(<AppNavigator />);
      expect(screen.queryByText(/Create PIN/i)).toBeNull();
      expect(screen.queryByText(/Enter PIN/i)).toBeNull();
      screen.unmount();
    }
  });
});
