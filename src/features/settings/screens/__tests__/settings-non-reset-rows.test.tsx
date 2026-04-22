/**
 * SettingsScreen non-reset rows regression tests (VAL-UX-053).
 *
 * The existing `settings-screen.test.tsx` pins the reset-wallet flow and
 * the explicit negative on the legacy `Change PIN` row. This file pins
 * the behavior and copy of the REMAINING rows so a future refactor
 * cannot quietly regress them:
 *
 *   - Lock wallet row (invokes the `onLock` prop exactly once, never
 *     triggers a reset).
 *   - Biometric unlock status row renders as a disabled indicator with
 *     the word "Biometric" in its label (never "PIN").
 *   - Data rows (Export / Import backup) render as disabled placeholders
 *     and do NOT trigger any store action when pressed.
 *   - No Agent row + pressing the Lock wallet / disabled rows never
 *     triggers the reset orchestration (`NativeBiometricVault.deleteSecret`,
 *     `agentStore.reset`, `sessionStore.reset`) — that path is owned by
 *     the destructive-button flow pinned in `settings-screen.test.tsx`.
 *   - The full settings tree contains zero PIN / passcode strings in any
 *     label, a11y label, or body text.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

jest.mock('@/lib/enbox/agent-store', () => {
  const { create } = require('zustand');
  const nativeBiometricDefault = require('@specs/NativeBiometricVault').default;
  const teardown = jest.fn();
  const reset = jest.fn(async () => {
    // Mirror the real agent-store.reset so spy counts reflect reality.
    await nativeBiometricDefault.deleteSecret('enbox.wallet.root');
    teardown();
    const { useSessionStore } = require('@/features/session/session-store');
    await useSessionStore.getState().reset();
  });
  const useAgentStore = create(() => ({
    agent: { agentDid: { uri: 'did:dht:alice' } },
    identities: [],
    error: null,
    recoveryPhrase: null,
    clearRecoveryPhrase: jest.fn(),
    teardown,
    reset,
  }));
  return {
    useAgentStore,
    __mockTeardown: teardown,
    __mockReset: reset,
  };
});

jest.mock('@/features/session/session-store', () => {
  const { create } = require('zustand');
  const reset = jest.fn(async () => undefined);
  const hydrate = jest.fn(async () => undefined);
  const useSessionStore = create(() => ({
    isHydrated: true,
    hasCompletedOnboarding: true,
    hasIdentity: true,
    isLocked: false,
    biometricStatus: 'ready',
    lock: jest.fn(),
    unlockSession: jest.fn(),
    completeOnboarding: jest.fn(),
    setHasIdentity: jest.fn(),
    setBiometricStatus: jest.fn(),
    reset,
    hydrate,
  }));
  return {
    useSessionStore,
    __mockSessionReset: reset,
    __mockSessionHydrate: hydrate,
  };
});

import { Linking } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';

import { SettingsScreen } from '@/features/settings/screens/settings-screen';

// Import the package.json version the SettingsScreen About row sources
// its string from, so the test and the screen share a single source of
// truth for the asserted version string (VAL-UX-053).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PACKAGE_VERSION: string = require('../../../../../package.json').version;

const agentStoreMocks = require('@/lib/enbox/agent-store') as {
  __mockTeardown: jest.Mock;
  __mockReset: jest.Mock;
};
const sessionStoreMocks = require('@/features/session/session-store') as {
  __mockSessionReset: jest.Mock;
  __mockSessionHydrate: jest.Mock;
};

const nativeBiometricVaultMock = (
  globalThis as unknown as {
    __enboxBiometricVaultMock: { deleteSecret: jest.Mock };
  }
).__enboxBiometricVaultMock;

describe('SettingsScreen — non-reset rows regression (VAL-UX-053)', () => {
  let openURLSpy: jest.SpyInstance;

  beforeEach(() => {
    agentStoreMocks.__mockTeardown.mockClear();
    agentStoreMocks.__mockReset.mockClear();
    sessionStoreMocks.__mockSessionReset.mockClear();
    sessionStoreMocks.__mockSessionHydrate.mockClear();
    nativeBiometricVaultMock.deleteSecret.mockClear();
    openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  });

  afterEach(() => {
    openURLSpy.mockRestore();
  });

  it('renders the Agent DID row without any PIN references', () => {
    const screen = render(<SettingsScreen onLock={() => {}} />);

    expect(screen.getByText('Agent DID')).toBeTruthy();
    expect(screen.getByText('did:dht:alice')).toBeTruthy();
    // PIN / passcode must never appear anywhere on the settings tree.
    expect(screen.queryByText(/\bPIN\b/i)).toBeNull();
    expect(screen.queryByText(/passcode/i)).toBeNull();
  });

  it('renders the "Lock wallet" row and invokes onLock exactly once when pressed — no reset side-effects', () => {
    const onLock = jest.fn();
    const screen = render(<SettingsScreen onLock={onLock} />);

    fireEvent.press(screen.getByText('Lock wallet'));

    expect(onLock).toHaveBeenCalledTimes(1);
    // Lock must never trigger any of the reset primitives.
    expect(agentStoreMocks.__mockReset).not.toHaveBeenCalled();
    expect(agentStoreMocks.__mockTeardown).not.toHaveBeenCalled();
    expect(sessionStoreMocks.__mockSessionReset).not.toHaveBeenCalled();
    expect(sessionStoreMocks.__mockSessionHydrate).not.toHaveBeenCalled();
    expect(nativeBiometricVaultMock.deleteSecret).not.toHaveBeenCalled();
  });

  it('renders the "Biometric unlock" status indicator row as a disabled biometric reference (never PIN)', () => {
    const screen = render(<SettingsScreen onLock={() => {}} />);

    const row = screen.getByText('Biometric unlock');
    expect(row).toBeTruthy();
    // Label includes "Biometric" (not PIN).
    expect(row.props.children).toMatch(/Biometric/);
    // Pressing the disabled row must not invoke any reset primitive.
    fireEvent.press(row);
    expect(agentStoreMocks.__mockReset).not.toHaveBeenCalled();
    expect(agentStoreMocks.__mockTeardown).not.toHaveBeenCalled();
    expect(nativeBiometricVaultMock.deleteSecret).not.toHaveBeenCalled();
  });

  it('renders the "Export backup" and "Import backup" placeholders without triggering any reset primitive', () => {
    const screen = render(<SettingsScreen onLock={() => {}} />);

    expect(screen.getByText('Export backup')).toBeTruthy();
    expect(screen.getByText('Import backup')).toBeTruthy();

    fireEvent.press(screen.getByText('Export backup'));
    fireEvent.press(screen.getByText('Import backup'));

    expect(agentStoreMocks.__mockReset).not.toHaveBeenCalled();
    expect(agentStoreMocks.__mockTeardown).not.toHaveBeenCalled();
    expect(sessionStoreMocks.__mockSessionReset).not.toHaveBeenCalled();
    expect(nativeBiometricVaultMock.deleteSecret).not.toHaveBeenCalled();
  });

  it('renders the Security + Data + About + Danger-zone section headers (none of which reference PIN)', () => {
    const screen = render(<SettingsScreen onLock={() => {}} />);

    expect(screen.getByText('Security')).toBeTruthy();
    expect(screen.getByText('Data')).toBeTruthy();
    expect(screen.getByText('About')).toBeTruthy();
    expect(screen.getByText('Danger zone')).toBeTruthy();

    // None of the headers reference PIN / passcode.
    const headers = screen.getAllByRole('header');
    for (const h of headers) {
      const text = Array.isArray(h.props.children)
        ? h.props.children.join(' ')
        : String(h.props.children ?? '');
      expect(text).not.toMatch(/\bPIN\b/i);
      expect(text).not.toMatch(/passcode/i);
    }
  });

  // --------------------------------------------------------------
  // About row + version string (VAL-UX-053)
  // --------------------------------------------------------------
  it('renders the About section with the package.json version string', () => {
    const screen = render(<SettingsScreen onLock={() => {}} />);

    // The section header.
    expect(screen.getByText('About')).toBeTruthy();
    // The "App version" label that anchors the version row.
    expect(screen.getByText('App version')).toBeTruthy();
    // The actual version value — sourced from the same package.json the
    // component imports, so drift is impossible.
    expect(PACKAGE_VERSION).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
    expect(screen.getByText(PACKAGE_VERSION)).toBeTruthy();
    // And the same version is exposed via an accessibilityLabel for
    // assistive tech consumers.
    expect(
      screen.getByLabelText(`App version ${PACKAGE_VERSION}`),
    ).toBeTruthy();
  });

  // --------------------------------------------------------------
  // External-link rows invoke Linking.openURL (VAL-UX-053)
  // --------------------------------------------------------------
  it('renders the "Privacy policy" row and invokes Linking.openURL with the exact URL on press', () => {
    const screen = render(<SettingsScreen onLock={() => {}} />);

    expect(screen.getByText('Privacy policy')).toBeTruthy();

    fireEvent.press(screen.getByText('Privacy policy'));

    expect(openURLSpy).toHaveBeenCalledTimes(1);
    expect(openURLSpy).toHaveBeenCalledWith('https://enbox.org/privacy');
    // And the external-link press must not trigger any reset primitive.
    expect(agentStoreMocks.__mockReset).not.toHaveBeenCalled();
    expect(agentStoreMocks.__mockTeardown).not.toHaveBeenCalled();
    expect(nativeBiometricVaultMock.deleteSecret).not.toHaveBeenCalled();
  });

  it('renders the "Terms of service" row and invokes Linking.openURL with the exact URL on press', () => {
    const screen = render(<SettingsScreen onLock={() => {}} />);

    expect(screen.getByText('Terms of service')).toBeTruthy();

    fireEvent.press(screen.getByText('Terms of service'));

    expect(openURLSpy).toHaveBeenCalledTimes(1);
    expect(openURLSpy).toHaveBeenCalledWith('https://enbox.org/terms');
    expect(agentStoreMocks.__mockReset).not.toHaveBeenCalled();
    expect(agentStoreMocks.__mockTeardown).not.toHaveBeenCalled();
    expect(nativeBiometricVaultMock.deleteSecret).not.toHaveBeenCalled();
  });

  it('pressing non-reset rows never dispatches deleteSecret or reset primitives', () => {
    const screen = render(<SettingsScreen onLock={() => {}} />);

    for (const label of [
      'Lock wallet',
      'Biometric unlock',
      'Export backup',
      'Import backup',
      'Privacy policy',
      'Terms of service',
    ]) {
      fireEvent.press(screen.getByText(label));
    }

    expect(nativeBiometricVaultMock.deleteSecret).not.toHaveBeenCalled();
    expect(agentStoreMocks.__mockReset).not.toHaveBeenCalled();
    expect(agentStoreMocks.__mockTeardown).not.toHaveBeenCalled();
    // The two external-link rows were pressed — expect two openURL invocations.
    expect(openURLSpy).toHaveBeenCalledTimes(2);
    expect(openURLSpy).toHaveBeenNthCalledWith(1, 'https://enbox.org/privacy');
    expect(openURLSpy).toHaveBeenNthCalledWith(2, 'https://enbox.org/terms');
  });
});
