/**
 * SettingsScreen component tests.
 *
 * Covers validation-contract assertions:
 *
 *   - VAL-UX-036: `Reset wallet` row, after user confirmation, invokes
 *     `NativeBiometricVault.deleteSecret` (via `useAgentStore.reset()`),
 *     `useAgentStore.getState().teardown()`, and
 *     `useSessionStore.getState().reset()` exactly once each, then
 *     triggers a `useSessionStore.hydrate()` so the navigator routes
 *     back to `Welcome`. Confirmation copy must reference the
 *     biometric-protected wallet and must NOT mention a PIN.
 *
 *   - VAL-UX-037: stale `Change PIN` row is removed; no `PIN` text
 *     appears anywhere on the settings tree (label, a11y, visible copy).
 *
 * The test replaces `@/lib/enbox/agent-store` and
 * `@/features/session/session-store` with lightweight zustand stores so
 * we can spy on the orchestration primitives without booting the real
 * `@enbox/agent` runtime. `NativeBiometricVault.deleteSecret` is exposed
 * via the jest.setup.js default mock (`global.__enboxBiometricVaultMock`)
 * so we can assert it is invoked when the underlying store's `reset`
 * action is called by the wrapper.
 */

// NOTE on Jest factory hoisting: `jest.mock(...)` is hoisted above
// top-level `const` declarations. Define mock functions inside the
// factory and re-export them so tests can capture stable references.

jest.mock('@/lib/enbox/agent-store', () => {
  const { create } = require('zustand');
  const nativeBiometricDefault = require('@specs/NativeBiometricVault').default;

  const teardown = jest.fn();
  const reset = jest.fn(async () => {
    // Mirror the real agent-store.reset() contract closely enough for
    // VAL-UX-036 assertions: call NativeBiometricVault.deleteSecret,
    // invoke teardown, and reset the session store. Order matters so
    // the ordering assertion in the test can pin it.
    await nativeBiometricDefault.deleteSecret('enbox.wallet.root');
    teardown();
    const { useSessionStore } = require('@/features/session/session-store');
    await useSessionStore.getState().reset();
  });

  const useAgentStore = create(() => ({
    agent: null,
    identities: [] as unknown[],
    error: null as string | null,
    recoveryPhrase: null as string | null,
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

  const reset = jest.fn(async () => {
    useSessionStore.setState({
      hasCompletedOnboarding: false,
      hasIdentity: false,
      isLocked: true,
      biometricStatus: 'unknown',
    });
  });

  const hydrate = jest.fn(async () => {
    useSessionStore.setState({ biometricStatus: 'ready', isHydrated: true });
  });

  const useSessionStore = create(() => ({
    isHydrated: true,
    hasCompletedOnboarding: true,
    hasIdentity: true,
    isLocked: false,
    biometricStatus: 'ready' as
      | 'unknown'
      | 'unavailable'
      | 'not-enrolled'
      | 'ready'
      | 'invalidated',
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

import { Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';

import { SettingsScreen } from '@/features/settings/screens/settings-screen';

const agentStoreMocks = require('@/lib/enbox/agent-store') as {
  __mockTeardown: jest.Mock;
  __mockReset: jest.Mock;
};
const sessionStoreMocks = require('@/features/session/session-store') as {
  __mockSessionReset: jest.Mock;
  __mockSessionHydrate: jest.Mock;
};

// The NativeBiometricVault module is globally mocked in jest.setup.js.
// Grab the exposed mock so we can assert on deleteSecret directly.
const nativeBiometricVaultMock = (
  globalThis as unknown as {
    __enboxBiometricVaultMock: { deleteSecret: jest.Mock };
  }
).__enboxBiometricVaultMock;

type AlertButton = {
  text?: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void | Promise<void>;
};

interface CapturedAlert {
  title: string;
  message: string | undefined;
  buttons: AlertButton[] | undefined;
}

function spyAlert(): {
  spy: jest.SpyInstance;
  captured: CapturedAlert[];
} {
  const captured: CapturedAlert[] = [];
  const spy = jest.spyOn(Alert, 'alert').mockImplementation(
    (
      title: string,
      message?: string,
      buttons?: AlertButton[],
      _options?: unknown,
    ) => {
      captured.push({ title, message, buttons });
    },
  );
  return { spy, captured };
}

describe('SettingsScreen', () => {
  let alertSpy: jest.SpyInstance;
  let capturedAlerts: CapturedAlert[];

  beforeEach(() => {
    agentStoreMocks.__mockTeardown.mockClear();
    agentStoreMocks.__mockReset.mockClear();
    sessionStoreMocks.__mockSessionReset.mockClear();
    sessionStoreMocks.__mockSessionHydrate.mockClear();
    nativeBiometricVaultMock.deleteSecret.mockClear();

    const alertBinding = spyAlert();
    alertSpy = alertBinding.spy;
    capturedAlerts = alertBinding.captured;
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  // --------------------------------------------------------------
  // VAL-UX-037 — stale `Change PIN` row removed
  // --------------------------------------------------------------
  describe('VAL-UX-037 — no PIN references', () => {
    it('does not render a "Change PIN" row', () => {
      const screen = render(<SettingsScreen onLock={() => {}} />);

      expect(screen.queryByText('Change PIN')).toBeNull();
      // Also no a11y label with PIN.
      expect(screen.queryByLabelText(/change pin/i)).toBeNull();
    });

    it('never renders the literal `PIN` anywhere on the settings tree', () => {
      const screen = render(<SettingsScreen onLock={() => {}} />);

      expect(screen.queryByText(/PIN/i)).toBeNull();
    });

    it('still renders the post-refactor Security rows (Lock wallet + Biometric unlock)', () => {
      const screen = render(<SettingsScreen onLock={() => {}} />);

      expect(screen.getByText('Lock wallet')).toBeTruthy();
      expect(screen.getByText('Biometric unlock')).toBeTruthy();
      expect(screen.getByText('Reset wallet')).toBeTruthy();
    });
  });

  // --------------------------------------------------------------
  // VAL-UX-036 — Reset wallet orchestration
  // --------------------------------------------------------------
  describe('VAL-UX-036 — reset wallet flow', () => {
    it('shows a confirmation alert with biometric-referenced copy (no PIN) when Reset wallet is pressed', () => {
      const screen = render(<SettingsScreen onLock={() => {}} />);

      fireEvent.press(screen.getByText('Reset wallet'));

      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(capturedAlerts).toHaveLength(1);

      const { title, message, buttons } = capturedAlerts[0];

      expect(title).toBe('Reset wallet');
      expect(message).toBeDefined();
      // Mentions biometric-protected wallet wording.
      expect(message ?? '').toMatch(/biometric/i);
      expect(message ?? '').toMatch(/wallet/i);
      // Must not reference a PIN anywhere.
      expect(message ?? '').not.toMatch(/\bpin\b/i);

      // Two buttons: Cancel + destructive Reset.
      expect(buttons?.length).toBe(2);
      expect(buttons?.[0]?.text).toBe('Cancel');
      expect(buttons?.[0]?.style).toBe('cancel');
      expect(buttons?.[1]?.text).toBe('Reset');
      expect(buttons?.[1]?.style).toBe('destructive');
    });

    it('does NOT invoke any reset primitive when the user cancels the confirmation alert', async () => {
      const screen = render(<SettingsScreen onLock={() => {}} />);

      fireEvent.press(screen.getByText('Reset wallet'));
      const cancelButton = capturedAlerts[0].buttons?.[0];

      await act(async () => {
        await cancelButton?.onPress?.();
      });

      expect(agentStoreMocks.__mockReset).not.toHaveBeenCalled();
      expect(agentStoreMocks.__mockTeardown).not.toHaveBeenCalled();
      expect(sessionStoreMocks.__mockSessionReset).not.toHaveBeenCalled();
      expect(sessionStoreMocks.__mockSessionHydrate).not.toHaveBeenCalled();
      expect(nativeBiometricVaultMock.deleteSecret).not.toHaveBeenCalled();
    });

    it('calls NativeBiometricVault.deleteSecret + teardown + sessionStore.reset + hydrate in order when the user confirms', async () => {
      const screen = render(<SettingsScreen onLock={() => {}} />);

      fireEvent.press(screen.getByText('Reset wallet'));
      const destructiveButton = capturedAlerts[0].buttons?.[1];

      await act(async () => {
        await destructiveButton?.onPress?.();
      });

      // Each primitive was invoked exactly once.
      expect(nativeBiometricVaultMock.deleteSecret).toHaveBeenCalledTimes(
        1,
      );
      expect(agentStoreMocks.__mockReset).toHaveBeenCalledTimes(1);
      expect(agentStoreMocks.__mockTeardown).toHaveBeenCalledTimes(1);
      expect(sessionStoreMocks.__mockSessionReset).toHaveBeenCalledTimes(
        1,
      );
      expect(sessionStoreMocks.__mockSessionHydrate).toHaveBeenCalledTimes(
        1,
      );

      // Ordering assertion: native deleteSecret must fire before
      // teardown, which must fire before sessionStore.reset, which
      // must fire before the final hydrate that bounces the user to
      // Welcome. We compare `invocationCallOrder` to pin the sequence.
      const deleteSecretOrder =
        nativeBiometricVaultMock.deleteSecret.mock.invocationCallOrder[0];
      const teardownOrder =
        agentStoreMocks.__mockTeardown.mock.invocationCallOrder[0];
      const sessionResetOrder =
        sessionStoreMocks.__mockSessionReset.mock.invocationCallOrder[0];
      const hydrateOrder =
        sessionStoreMocks.__mockSessionHydrate.mock.invocationCallOrder[0];

      expect(deleteSecretOrder).toBeLessThan(teardownOrder);
      expect(teardownOrder).toBeLessThan(sessionResetOrder);
      expect(sessionResetOrder).toBeLessThan(hydrateOrder);
    });

    it('calls deleteSecret against the canonical wallet-root keystore alias', async () => {
      const screen = render(<SettingsScreen onLock={() => {}} />);

      fireEvent.press(screen.getByText('Reset wallet'));
      const destructiveButton = capturedAlerts[0].buttons?.[1];

      await act(async () => {
        await destructiveButton?.onPress?.();
      });

      expect(nativeBiometricVaultMock.deleteSecret).toHaveBeenCalledWith(
        'enbox.wallet.root',
      );
    });

    // Round-11 F2: pre-fix this test codified the SWALLOW-AND-HYDRATE
    // contract ("hydrate runs even on reset failure"). That defeated
    // the round-9/round-10 fail-LOUD reset contract: a real Keystore
    // failure / LevelDB wipe failure / session-store reset failure
    // would surface to `useAgentStore.reset()` as a thrown error, but
    // the user would see the alert close cleanly and the navigator
    // would refresh to `Welcome` as if the reset succeeded — yet the
    // OS-gated secret / on-disk identities / stale session flags
    // would still be alive on disk. The new contract is fail-LOUD at
    // the UI:
    //   1. The reset failure is surfaced to the user via a follow-up
    //      Alert (with retry/cancel buttons).
    //   2. Hydrate is SUPPRESSED on the failure path. Hydrating after
    //      a partial reset traps the user in unlock loops because the
    //      navigator routes to Unlock against a half-cleared
    //      SecureStorage view.
    //   3. The retry sentinels persisted by `agent-store.reset()`
    //      handle the cleanup recovery on the next cold launch
    //      regardless of whether the user taps Retry.
    it('surfaces the reset failure via Alert AND suppresses hydrate when agentStore.reset() rejects (Round-11 F2)', async () => {
      agentStoreMocks.__mockReset.mockRejectedValueOnce(
        Object.assign(new Error('simulated reset failure'), {
          code: 'VAULT_ERROR',
        }),
      );
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const screen = render(<SettingsScreen onLock={() => {}} />);

        fireEvent.press(screen.getByText('Reset wallet'));
        const destructiveButton = capturedAlerts[0].buttons?.[1];

        await act(async () => {
          await destructiveButton?.onPress?.();
        });

        // Reset was attempted.
        expect(agentStoreMocks.__mockReset).toHaveBeenCalledTimes(1);
        // CRITICAL: hydrate MUST NOT run on the failure path.
        // Hydrating after a partial reset traps the user in
        // unlock loops because routing fires against a
        // half-cleared SecureStorage view.
        expect(
          sessionStoreMocks.__mockSessionHydrate,
        ).not.toHaveBeenCalled();
        // The user-facing follow-up Alert was shown:
        //   capturedAlerts[0] = the initial confirmation alert.
        //   capturedAlerts[1] = the new Round-11 failure alert.
        expect(capturedAlerts.length).toBeGreaterThanOrEqual(2);
        const failureAlert = capturedAlerts[1];
        expect(failureAlert.title).toBe('Reset failed');
        expect(failureAlert.message ?? '').toMatch(/VAULT_ERROR/);
        expect(failureAlert.message ?? '').toMatch(/simulated reset failure/);
        // Retry + Cancel buttons.
        expect(failureAlert.buttons?.length).toBe(2);
        expect(failureAlert.buttons?.[0]?.text).toBe('Cancel');
        expect(failureAlert.buttons?.[1]?.text).toBe('Retry');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('Retry button on the failure alert re-invokes performReset', async () => {
      agentStoreMocks.__mockReset
        .mockRejectedValueOnce(new Error('first attempt failed'))
        .mockResolvedValueOnce(undefined);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const screen = render(<SettingsScreen onLock={() => {}} />);

        fireEvent.press(screen.getByText('Reset wallet'));
        await act(async () => {
          await capturedAlerts[0].buttons?.[1]?.onPress?.();
        });

        expect(agentStoreMocks.__mockReset).toHaveBeenCalledTimes(1);
        // First attempt failed → failure alert shown, hydrate skipped.
        expect(sessionStoreMocks.__mockSessionHydrate).not.toHaveBeenCalled();

        // Tap Retry on the failure alert.
        await act(async () => {
          await capturedAlerts[1].buttons?.[1]?.onPress?.();
        });

        // Reset re-invoked; second attempt succeeded → hydrate now runs.
        expect(agentStoreMocks.__mockReset).toHaveBeenCalledTimes(2);
        expect(sessionStoreMocks.__mockSessionHydrate).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // --------------------------------------------------------------
  // Lock wallet row — regression
  // --------------------------------------------------------------
  describe('Lock wallet row', () => {
    it('calls onLock when the Lock wallet row is pressed', () => {
      const onLock = jest.fn();
      const screen = render(<SettingsScreen onLock={onLock} />);

      fireEvent.press(screen.getByText('Lock wallet'));

      expect(onLock).toHaveBeenCalledTimes(1);
    });
  });
});
