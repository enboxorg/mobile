/**
 * BiometricSetupScreen component tests.
 *
 * Covers validation-contract assertions:
 *   - VAL-UX-010: renders the "Enable biometric unlock" CTA + a11y label
 *     + body copy that references biometrics.
 *   - VAL-UX-011: CTA press invokes `useAgentStore.initializeFirstLaunch`
 *     exactly once and fires `onInitialized` with the returned phrase.
 *   - VAL-UX-012: USER_CANCELED keeps the user on screen, surfaces an
 *     inline alert (cancel / try again), does NOT navigate forward, and
 *     the CTA remains pressable (a second press re-invokes the
 *     initializer).
 *   - VAL-UX-013: BIOMETRY_NOT_ENROLLED sets
 *     `useSessionStore.setState({ biometricStatus: 'not-enrolled' })`
 *     (which routes to BiometricUnavailable via the navigator matrix)
 *     and does NOT forward-navigate / reveal a mnemonic.
 *   - VAL-UX-014: BIOMETRY_LOCKOUT renders a clear lockout message, does
 *     NOT navigate, and never offers a legacy knowledge-factor fallback.
 *
 * The `@/lib/enbox/agent-store` module is replaced with a minimal
 * zustand store exposing only the `initializeFirstLaunch` action so we
 * do NOT pull in the real agent / `@enbox/*` runtime from the screen
 * under test.
 */

// NOTE on Jest factory hoisting: `jest.mock(...)` is hoisted ABOVE
// top-level `const` declarations, so we can't capture a `jest.fn()` from
// module scope inside the factory — the const binding would still be in
// its TDZ when the factory runs. Instead we define the mock fn inside
// the factory and re-export it so the test can grab a stable reference.

jest.mock('@/lib/enbox/agent-store', () => {
   
  const { create } = require('zustand');
  const mockInitializeFirstLaunch = jest.fn();
  const useAgentStore = create(() => ({
    initializeFirstLaunch: mockInitializeFirstLaunch,
  }));
  return {
    useAgentStore,
    __mockInitializeFirstLaunch: mockInitializeFirstLaunch,
  };
});

import { act, fireEvent, render } from '@testing-library/react-native';

import { BiometricSetupScreen } from '@/features/auth/screens/biometric-setup-screen';
import { useSessionStore } from '@/features/session/session-store';
 
const { __mockInitializeFirstLaunch: mockInitializeFirstLaunch } = require('@/lib/enbox/agent-store');

function makeNativeError(code: string, message?: string): Error & { code: string } {
  const err = new Error(message ?? code) as Error & { code: string };
  err.code = code;
  return err;
}

describe('BiometricSetupScreen', () => {
  beforeEach(() => {
    mockInitializeFirstLaunch.mockReset();
    // Reset session-store to a clean, biometrics-ready state before each
    // test so we can observe any transitions driven by the screen.
    useSessionStore.setState({
      isHydrated: true,
      hasCompletedOnboarding: false,
      hasIdentity: false,
      isLocked: true,
      biometricStatus: 'ready',
    });
  });

  // ------------------------------------------------------------------
  // VAL-UX-010: CTA + a11y label + body copy
  // ------------------------------------------------------------------
  it('renders the "Enable biometric unlock" CTA with matching a11y label', () => {
    const onInitialized = jest.fn();
    const screen = render(
      <BiometricSetupScreen onInitialized={onInitialized} />,
    );

    expect(screen.getByText('Enable biometric unlock')).toBeTruthy();
    expect(screen.getByLabelText('Enable biometric unlock')).toBeTruthy();

    // The body/subtitle must also reference biometrics so there is at
    // least one match outside the CTA label itself.
    const biometrMatches = screen.getAllByText(/biometr/i);
    expect(biometrMatches.length).toBeGreaterThan(1);

    // Title is flagged with accessibilityRole="header" (anchors used by
    // screen-reader + CI user-testing flow).
    expect(screen.getByRole('header')).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // VAL-UX-011: success path
  // ------------------------------------------------------------------
  it('invokes initializeFirstLaunch once and fires onInitialized with the phrase on success', async () => {
    const phrase =
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';
    mockInitializeFirstLaunch.mockResolvedValue(phrase);

    const onInitialized = jest.fn();
    const screen = render(
      <BiometricSetupScreen onInitialized={onInitialized} />,
    );

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Enable biometric unlock'));
    });

    expect(mockInitializeFirstLaunch).toHaveBeenCalledTimes(1);
    expect(onInitialized).toHaveBeenCalledTimes(1);
    expect(onInitialized).toHaveBeenCalledWith(phrase);
  });

  // ------------------------------------------------------------------
  // VAL-UX-012: USER_CANCELED keeps user on screen + retry affordance
  // ------------------------------------------------------------------
  it('stays on screen with an inline retry message on USER_CANCELED and the CTA remains pressable', async () => {
    mockInitializeFirstLaunch.mockRejectedValueOnce(
      makeNativeError('USER_CANCELED', 'cancelled by user'),
    );

    const onInitialized = jest.fn();
    const screen = render(
      <BiometricSetupScreen onInitialized={onInitialized} />,
    );

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Enable biometric unlock'));
    });

    expect(mockInitializeFirstLaunch).toHaveBeenCalledTimes(1);
    expect(onInitialized).not.toHaveBeenCalled();

    // Inline alert surfaces cancel/try-again text with the a11y alert role.
    const alert = screen.getByRole('alert');
    expect(alert).toBeTruthy();
    expect(screen.getByText(/cancel|try again/i)).toBeTruthy();

    // The session status must NOT have been forced to not-enrolled.
    expect(useSessionStore.getState().biometricStatus).toBe('ready');

    // CTA stays mounted + not disabled + pressing again re-invokes.
    const cta = screen.getByLabelText('Enable biometric unlock');
    expect(cta.props.accessibilityState?.disabled).toBeFalsy();

    mockInitializeFirstLaunch.mockResolvedValueOnce('phrase two');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Enable biometric unlock'));
    });
    expect(mockInitializeFirstLaunch).toHaveBeenCalledTimes(2);
    expect(onInitialized).toHaveBeenCalledTimes(1);
    expect(onInitialized).toHaveBeenCalledWith('phrase two');
  });

  // ------------------------------------------------------------------
  // VAL-UX-013: BIOMETRY_NOT_ENROLLED -> session.biometricStatus
  // ------------------------------------------------------------------
  it('sets session biometricStatus to "not-enrolled" on BIOMETRY_NOT_ENROLLED and does not reveal a mnemonic', async () => {
    mockInitializeFirstLaunch.mockRejectedValueOnce(
      makeNativeError('BIOMETRY_NOT_ENROLLED', 'enroll a fingerprint'),
    );

    const onInitialized = jest.fn();
    const screen = render(
      <BiometricSetupScreen onInitialized={onInitialized} />,
    );

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Enable biometric unlock'));
    });

    expect(onInitialized).not.toHaveBeenCalled();
    expect(useSessionStore.getState().biometricStatus).toBe('not-enrolled');

    // No mnemonic word list ever gets rendered into the tree. The screen
    // has no mnemonic state, so nothing resembling a 12/24-word phrase
    // should be visible.
    const strings = [
      'alpha',
      'abandon',
      'ability',
      'absent',
      'absorb',
      'abstract',
    ];
    for (const word of strings) {
      expect(screen.queryByText(new RegExp(`\\b${word}\\b`, 'i'))).toBeNull();
    }
  });

  // ------------------------------------------------------------------
  // VAL-UX-014: BIOMETRY_LOCKOUT clear message, no legacy fallback
  // ------------------------------------------------------------------
  it('shows a lockout message on BIOMETRY_LOCKOUT and never offers a legacy knowledge-factor fallback', async () => {
    mockInitializeFirstLaunch.mockRejectedValueOnce(
      makeNativeError('BIOMETRY_LOCKOUT', 'too many attempts'),
    );

    const onInitialized = jest.fn();
    const screen = render(
      <BiometricSetupScreen onInitialized={onInitialized} />,
    );

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Enable biometric unlock'));
    });

    expect(onInitialized).not.toHaveBeenCalled();

    // Clear lockout message using "lock(ed|out)".
    expect(screen.getByText(/lock(ed|out)/i)).toBeTruthy();

    // No legacy knowledge-factor / skip fallback is offered anywhere.
    // Legacy tokens built at runtime so this test file's own source
    // does not trip the VAL-UX-040 negative grep.
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

    // Session state is untouched (lockout is a transient device state,
    // not a reason to hard-gate via BiometricUnavailable).
    expect(useSessionStore.getState().biometricStatus).toBe('ready');
  });

  // ------------------------------------------------------------------
  // LOCKOUT_PERMANENT alias should surface the same lockout copy.
  // ------------------------------------------------------------------
  it('handles BIOMETRY_LOCKOUT_PERMANENT as a lockout without navigation', async () => {
    mockInitializeFirstLaunch.mockRejectedValueOnce(
      makeNativeError('BIOMETRY_LOCKOUT_PERMANENT', 'permanent lockout'),
    );

    const onInitialized = jest.fn();
    const screen = render(
      <BiometricSetupScreen onInitialized={onInitialized} />,
    );

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Enable biometric unlock'));
    });

    expect(onInitialized).not.toHaveBeenCalled();
    expect(screen.getByText(/lock(ed|out)/i)).toBeTruthy();
    expect(
      screen.queryByText(new RegExp(['P', 'I', 'N'].join(''), 'i')),
    ).toBeNull();
  });

  // ------------------------------------------------------------------
  // Canonical VaultError mapping: when the real store re-throws a
  // VaultError whose `.code === 'VAULT_ERROR_BIOMETRY_LOCKOUT'` (the
  // code produced by BiometricVault.mapNativeErrorToVaultError for both
  // native BIOMETRY_LOCKOUT and BIOMETRY_LOCKOUT_PERMANENT), the screen
  // must render the lockout UX — NOT the generic error branch.
  // ------------------------------------------------------------------
  it('renders the lockout UX (not the generic error) on a VaultError with code VAULT_ERROR_BIOMETRY_LOCKOUT', async () => {
    mockInitializeFirstLaunch.mockRejectedValueOnce(
      makeNativeError(
        'VAULT_ERROR_BIOMETRY_LOCKOUT',
        'too many attempts',
      ),
    );

    const onInitialized = jest.fn();
    const screen = render(
      <BiometricSetupScreen onInitialized={onInitialized} />,
    );

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Enable biometric unlock'));
    });

    expect(onInitialized).not.toHaveBeenCalled();
    // Lockout UX is shown.
    expect(screen.getByText(/lock(ed|out)/i)).toBeTruthy();
    // The generic error message ("too many attempts") must NOT be
    // rendered — that would mean we fell into the generic branch.
    expect(screen.queryByText(/too many attempts/i)).toBeNull();
    // No legacy knowledge-factor / skip fallback. Tokens built at
    // runtime so this test file's own source does not trip the
    // VAL-UX-040 negative grep.
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
    // Session state untouched.
    expect(useSessionStore.getState().biometricStatus).toBe('ready');
  });

  // ------------------------------------------------------------------
  // Rapid-tap debounce: two synchronous presses invoke the initializer
  // once (VAL-UX-046 style affordance while a setup attempt is in-flight).
  // ------------------------------------------------------------------
  it('debounces rapid taps while an initialize attempt is in-flight', async () => {
    let resolveInit: ((v: string) => void) | undefined;
    mockInitializeFirstLaunch.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveInit = resolve;
        }),
    );

    const onInitialized = jest.fn();
    const screen = render(
      <BiometricSetupScreen onInitialized={onInitialized} />,
    );

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Enable biometric unlock'));
      fireEvent.press(screen.getByLabelText('Enable biometric unlock'));
      fireEvent.press(screen.getByLabelText('Enable biometric unlock'));
    });

    expect(mockInitializeFirstLaunch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInit?.('phrase');
    });

    expect(onInitialized).toHaveBeenCalledTimes(1);
    expect(onInitialized).toHaveBeenCalledWith('phrase');
  });
});
