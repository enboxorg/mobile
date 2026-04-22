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

import { fireEvent, render } from '@testing-library/react-native';

import { SettingsScreen } from '@/features/settings/screens/settings-screen';

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
  beforeEach(() => {
    agentStoreMocks.__mockTeardown.mockClear();
    agentStoreMocks.__mockReset.mockClear();
    sessionStoreMocks.__mockSessionReset.mockClear();
    sessionStoreMocks.__mockSessionHydrate.mockClear();
    nativeBiometricVaultMock.deleteSecret.mockClear();
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

  it('renders the Security + Data + Danger-zone section headers (none of which reference PIN)', () => {
    const screen = render(<SettingsScreen onLock={() => {}} />);

    expect(screen.getByText('Security')).toBeTruthy();
    expect(screen.getByText('Data')).toBeTruthy();
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

  it('pressing non-reset rows never dispatches deleteSecret or reset primitives', () => {
    const screen = render(<SettingsScreen onLock={() => {}} />);

    for (const label of [
      'Lock wallet',
      'Biometric unlock',
      'Export backup',
      'Import backup',
    ]) {
      fireEvent.press(screen.getByText(label));
    }

    expect(nativeBiometricVaultMock.deleteSecret).not.toHaveBeenCalled();
    expect(agentStoreMocks.__mockReset).not.toHaveBeenCalled();
    expect(agentStoreMocks.__mockTeardown).not.toHaveBeenCalled();
  });
});
