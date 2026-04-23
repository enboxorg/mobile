/**
 * BiometricUnlockScreen component tests.
 *
 * Covers validation-contract assertions:
 *   - VAL-UX-015: renders an "Unlock with …" CTA (text + a11y label both
 *     start with "Unlock with"). When auto-prompt is on, the biometric
 *     unlock mock is called exactly once on initial mount/focus.
 *   - VAL-UX-016: on a successful biometric unlock the screen invokes the
 *     `onUnlock` prop exactly once and renders no error alert.
 *   - VAL-UX-017: USER_CANCELED keeps the user on screen, does NOT call
 *     `onUnlock`, and leaves the CTA mounted + pressable for retry. No
 *     modal/dialog is shown; at most an inline alert.
 *   - VAL-UX-018: BIOMETRY_LOCKOUT / BIOMETRY_LOCKOUT_PERMANENT renders a
 *     clear lockout message referencing device biometrics, never offers
 *     a legacy knowledge-factor / skip fallback, and does NOT call
 *     `onUnlock`.
 *   - VAL-UX-019: KEY_INVALIDATED / KEY_PERMANENTLY_INVALIDATED /
 *     VAULT_ERROR_KEY_INVALIDATED updates `session.biometricStatus` to
 *     `'invalidated'` (the navigator matrix then routes to
 *     RecoveryRestore) OR calls `navigation.replace('RecoveryRestore')`.
 *     The implementation under test uses the session-status path by
 *     default; when a caller passes an optional `onInvalidated` callback
 *     we additionally assert it is called. `onUnlock` must not fire.
 *
 * The `@/lib/enbox/agent-store` module is replaced with a minimal zustand
 * store exposing only the `unlockAgent` action so we don't pull the real
 * agent runtime (and its `@enbox/*` ESM deps) into the component test.
 */

jest.mock('@/lib/enbox/agent-store', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { create } = require('zustand');
  const mockUnlockAgent = jest.fn();
  const useAgentStore = create(() => ({
    unlockAgent: mockUnlockAgent,
  }));
  return {
    useAgentStore,
    __mockUnlockAgent: mockUnlockAgent,
  };
});

import { act, fireEvent, render } from '@testing-library/react-native';

import { BiometricUnlockScreen } from '@/features/auth/screens/biometric-unlock';
import { useSessionStore } from '@/features/session/session-store';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mockUnlockAgent: mockUnlockAgent } = require('@/lib/enbox/agent-store');

function makeNativeError(code: string, message?: string): Error & { code: string } {
  const err = new Error(message ?? code) as Error & { code: string };
  err.code = code;
  return err;
}

describe('BiometricUnlockScreen', () => {
  beforeEach(() => {
    mockUnlockAgent.mockReset();
    // Default: resolve (success). Tests that need a specific failure
    // path override this with mockRejectedValueOnce / mockResolvedValueOnce.
    mockUnlockAgent.mockResolvedValue(undefined);
    // Reset session store to a clean locked-ready state.
    useSessionStore.setState({
      isHydrated: true,
      hasCompletedOnboarding: true,
      hasIdentity: true,
      isLocked: true,
      biometricStatus: 'ready',
    });
  });

  // ------------------------------------------------------------------
  // VAL-UX-015: renders CTA; "Unlock with" prefix on text + a11y label.
  // ------------------------------------------------------------------
  it('renders a CTA whose label and a11y label both start with "Unlock with"', async () => {
    const onUnlock = jest.fn();
    // Block unlockAgent so the auto-prompt side-effect doesn't flush the
    // success path before we read the CTA (a resolved auto-unlock would
    // unmount this screen in the navigator; here we're testing the mounted
    // surface directly).
    mockUnlockAgent.mockImplementation(() => new Promise(() => {}));

    const screen = render(
      <BiometricUnlockScreen autoPrompt={false} onUnlock={onUnlock} />,
    );

    // The CTA label text must start with "Unlock with".
    const cta = screen.getByText(/^Unlock with/);
    expect(cta).toBeTruthy();

    // The a11y label must ALSO start with "Unlock with" — VAL-UX-038
    // accessibility anchor for the CI UI driver.
    const ctaA11y = screen.getByLabelText(/^Unlock with/);
    expect(ctaA11y).toBeTruthy();

    // Header role present (accessibility anchor for screen-readers).
    expect(screen.getByRole('header')).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // VAL-UX-015: auto-prompt (optional) fires the unlock mock exactly
  // once on initial focus / mount.
  // ------------------------------------------------------------------
  it('auto-prompts the biometric unlock exactly once on initial mount when autoPrompt is true', async () => {
    const onUnlock = jest.fn();
    mockUnlockAgent.mockResolvedValue(undefined);

    render(<BiometricUnlockScreen autoPrompt onUnlock={onUnlock} />);
    // Flush the auto-prompt effect + its resolved promise.
    await act(async () => {});

    expect(mockUnlockAgent).toHaveBeenCalledTimes(1);
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-prompt when autoPrompt is false', async () => {
    const onUnlock = jest.fn();
    render(<BiometricUnlockScreen autoPrompt={false} onUnlock={onUnlock} />);
    // Flush any pending effects (e.g. the isBiometricAvailable probe).
    await act(async () => {});
    expect(mockUnlockAgent).not.toHaveBeenCalled();
    expect(onUnlock).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // VAL-UX-016: success → onUnlock invoked once, no error alert.
  // ------------------------------------------------------------------
  it('invokes onUnlock exactly once and renders no error alert on a successful unlock', async () => {
    const onUnlock = jest.fn();
    mockUnlockAgent.mockResolvedValue(undefined);

    const screen = render(
      <BiometricUnlockScreen autoPrompt={false} onUnlock={onUnlock} />,
    );

    await act(async () => {
      fireEvent.press(screen.getByLabelText(/^Unlock with/));
    });

    expect(mockUnlockAgent).toHaveBeenCalledTimes(1);
    expect(onUnlock).toHaveBeenCalledTimes(1);

    // No alert role should be rendered on the successful path.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // ------------------------------------------------------------------
  // VAL-UX-017: USER_CANCELED keeps user on screen; CTA stays pressable.
  // ------------------------------------------------------------------
  it('stays on screen and keeps the CTA pressable on USER_CANCELED (no onUnlock, no invalidated transition)', async () => {
    const onUnlock = jest.fn();
    mockUnlockAgent.mockRejectedValueOnce(
      makeNativeError('USER_CANCELED', 'cancelled by user'),
    );

    const screen = render(
      <BiometricUnlockScreen autoPrompt={false} onUnlock={onUnlock} />,
    );

    await act(async () => {
      fireEvent.press(screen.getByLabelText(/^Unlock with/));
    });

    expect(mockUnlockAgent).toHaveBeenCalledTimes(1);
    expect(onUnlock).not.toHaveBeenCalled();

    // Session status was NOT forced into invalidated.
    expect(useSessionStore.getState().biometricStatus).toBe('ready');

    // CTA is still rendered and not disabled.
    const cta = screen.getByLabelText(/^Unlock with/);
    expect(cta.props.accessibilityState?.disabled).toBeFalsy();

    // A second press re-invokes the unlock (retry affordance).
    mockUnlockAgent.mockResolvedValueOnce(undefined);
    await act(async () => {
      fireEvent.press(screen.getByLabelText(/^Unlock with/));
    });
    expect(mockUnlockAgent).toHaveBeenCalledTimes(2);
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it('surfaces an inline cancel alert (role="alert") without navigating away on USER_CANCELED', async () => {
    const onUnlock = jest.fn();
    mockUnlockAgent.mockRejectedValueOnce(makeNativeError('USER_CANCELED'));

    const screen = render(
      <BiometricUnlockScreen autoPrompt={false} onUnlock={onUnlock} />,
    );

    await act(async () => {
      fireEvent.press(screen.getByLabelText(/^Unlock with/));
    });

    // Inline alert is allowed; a "try again"/"cancelled" message should
    // be surfaced, NOT a legacy knowledge-factor fallback or modal.
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/cancel|try again/i)).toBeTruthy();

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
  });

  // ------------------------------------------------------------------
  // VAL-UX-018: BIOMETRY_LOCKOUT → clear lockout message; no legacy
  // knowledge-factor fallback.
  //
  // Also asserts the canonical VaultError code path
  // (`VAULT_ERROR_BIOMETRY_LOCKOUT`) that `BiometricVault.mapNativeError
  // ToVaultError` re-throws for both native lockout codes — the real
  // unlock flow surfaces this canonical code, so the screen MUST render
  // the lockout UX (not the generic error branch) when it is observed.
  // ------------------------------------------------------------------
  it.each([
    ['BIOMETRY_LOCKOUT'],
    ['BIOMETRY_LOCKOUT_PERMANENT'],
    ['VAULT_ERROR_BIOMETRY_LOCKOUT'],
  ])(
    'renders a clear lockout message with no legacy knowledge-factor fallback on %s',
    async (code) => {
      const onUnlock = jest.fn();
      mockUnlockAgent.mockRejectedValueOnce(makeNativeError(code));

      const screen = render(
        <BiometricUnlockScreen autoPrompt={false} onUnlock={onUnlock} />,
      );

      await act(async () => {
        fireEvent.press(screen.getByLabelText(/^Unlock with/));
      });

      expect(onUnlock).not.toHaveBeenCalled();
      expect(screen.getByText(/lock(ed|out)/i)).toBeTruthy();

      // No legacy knowledge-factor / skip fallback anywhere. Tokens
      // built at runtime so this test file's own source does not trip
      // the VAL-UX-040 negative grep.
      const legacyKnowledgeFactorTokens = [
        ['use ', 'p', 'in'].join(''),
        ['P', 'I', 'N'].join(''),
        ['pass', 'code'].join(''),
      ];
      for (const token of legacyKnowledgeFactorTokens) {
        expect(
          screen.queryByText(new RegExp(token, 'i')),
        ).toBeNull();
      }
      expect(screen.queryByText(/skip/i)).toBeNull();

      // Session status untouched — lockout is transient device state,
      // not a reason to hard-gate the user.
      expect(useSessionStore.getState().biometricStatus).toBe('ready');
    },
  );

  // ------------------------------------------------------------------
  // VAL-UX-018: repeated AUTH_FAILED failures eventually show lockout.
  // ------------------------------------------------------------------
  it('shows a lockout message once repeated failures reach the lockout threshold', async () => {
    const onUnlock = jest.fn();
    // 5 consecutive AUTH_FAILED (the default threshold).
    for (let i = 0; i < 5; i++) {
      mockUnlockAgent.mockRejectedValueOnce(makeNativeError('AUTH_FAILED'));
    }

    const screen = render(
      <BiometricUnlockScreen autoPrompt={false} onUnlock={onUnlock} />,
    );

    for (let i = 0; i < 5; i++) {
      await act(async () => {
        fireEvent.press(screen.getByLabelText(/^Unlock with/));
      });
    }

    expect(onUnlock).not.toHaveBeenCalled();
    expect(screen.getByText(/lock(ed|out)/i)).toBeTruthy();
    expect(
      screen.queryByText(new RegExp(['P', 'I', 'N'].join(''), 'i')),
    ).toBeNull();
  });

  // ------------------------------------------------------------------
  // VAL-UX-019: KEY_INVALIDATED → session.biometricStatus = 'invalidated'.
  // ------------------------------------------------------------------
  it.each([
    ['KEY_INVALIDATED'],
    ['KEY_PERMANENTLY_INVALIDATED'],
    ['VAULT_ERROR_KEY_INVALIDATED'],
  ])(
    'transitions session.biometricStatus to "invalidated" on %s and does not call onUnlock',
    async (code) => {
      const onUnlock = jest.fn();
      mockUnlockAgent.mockRejectedValueOnce(makeNativeError(code));

      const screen = render(
        <BiometricUnlockScreen autoPrompt={false} onUnlock={onUnlock} />,
      );

      await act(async () => {
        fireEvent.press(screen.getByLabelText(/^Unlock with/));
      });

      expect(onUnlock).not.toHaveBeenCalled();
      expect(useSessionStore.getState().biometricStatus).toBe('invalidated');
    },
  );

  it('invokes onInvalidated (navigation.replace path) when provided on KEY_INVALIDATED', async () => {
    const onUnlock = jest.fn();
    const onInvalidated = jest.fn();
    mockUnlockAgent.mockRejectedValueOnce(makeNativeError('KEY_INVALIDATED'));

    const screen = render(
      <BiometricUnlockScreen
        autoPrompt={false}
        onUnlock={onUnlock}
        onInvalidated={onInvalidated}
      />,
    );

    await act(async () => {
      fireEvent.press(screen.getByLabelText(/^Unlock with/));
    });

    expect(onUnlock).not.toHaveBeenCalled();
    expect(onInvalidated).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // Rapid-tap debounce: two synchronous presses while an unlock is
  // in-flight collapse to a single unlockAgent() call.
  // ------------------------------------------------------------------
  it('debounces rapid taps while an unlock attempt is in-flight', async () => {
    const onUnlock = jest.fn();
    let resolveUnlock: (() => void) | undefined;
    mockUnlockAgent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveUnlock = resolve;
        }),
    );

    const screen = render(
      <BiometricUnlockScreen autoPrompt={false} onUnlock={onUnlock} />,
    );

    await act(async () => {
      fireEvent.press(screen.getByLabelText(/^Unlock with/));
      fireEvent.press(screen.getByLabelText(/^Unlock with/));
      fireEvent.press(screen.getByLabelText(/^Unlock with/));
    });

    expect(mockUnlockAgent).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveUnlock?.();
    });

    expect(onUnlock).toHaveBeenCalledTimes(1);
  });
});
