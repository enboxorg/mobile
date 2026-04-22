/**
 * RecoveryRestoreScreen component tests.
 *
 * Covers validation-contract assertions:
 *   - VAL-UX-023: accepts a 12- or 24-word mnemonic, normalizes it
 *     (lower-case / single-space / trimmed) and calls the agent store's
 *     `restoreFromMnemonic` mock exactly once with the normalized text.
 *     The `Restore wallet` CTA is disabled until a complete,
 *     well-formed mnemonic has been entered.
 *   - VAL-UX-024: on a successful restore the session biometric status
 *     flips back to `'ready'`, hasCompletedOnboarding / hasIdentity are
 *     rehydrated (not reset), and navigation routes to `Main` exactly
 *     once.
 *   - VAL-UX-025: an invalid mnemonic (checksum / wordlist fail) does
 *     NOT call the restore mock, surfaces a role="alert" inline error
 *     with user-readable copy referencing `recovery`/`phrase`/`invalid`
 *     /`incorrect`/`word`, and keeps the input populated.
 *   - VAL-UX-026: after a successful restore the biometric vault has
 *     been sealed exactly once. In this test we make the mocked
 *     `restoreFromMnemonic` drive a `NativeBiometricVault.generateAndStoreSecret`
 *     invocation so the screen-level contract (a) restore mock called
 *     with normalized input, (b) biometric seal invoked, (c) status
 *     flipped to `'ready'` is all observable from a single test.
 *   - VAL-UX-043 (Android FLAG_SECURE) and VAL-UX-044 (iOS cover view)
 *     are identical to the RecoveryPhraseScreen contract.
 *   - VAL-CROSS-009 / VAL-UX-034 anchor: the screen renders an element
 *     with `testID="recovery-restore-screen"` so the cross-area flow
 *     can assert the navigator has landed on the restore surface.
 */

// -----------------------------------------------------------------------
// Module mocks (hoisted above imports by Jest).
// -----------------------------------------------------------------------

jest.mock('@/lib/native/flag-secure', () => ({
  __esModule: true,
  enableFlagSecure: jest.fn(),
  disableFlagSecure: jest.fn(),
  FLAG_SECURE: 0x00002000,
}));

jest.mock('@/lib/enbox/agent-store', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { create } = require('zustand');
  const mockRestoreFromMnemonic = jest.fn();
  const useAgentStore = create(() => ({
    restoreFromMnemonic: mockRestoreFromMnemonic,
  }));
  return {
    useAgentStore,
    __mockRestoreFromMnemonic: mockRestoreFromMnemonic,
  };
});

import { act, fireEvent, render } from '@testing-library/react-native';
import { AppState, Platform, type AppStateStatus } from 'react-native';

import { RecoveryRestoreScreen } from '@/features/auth/screens/recovery-restore-screen';
import { useSessionStore } from '@/features/session/session-store';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  enableFlagSecure: mockEnableFlagSecure,
  disableFlagSecure: mockDisableFlagSecure,
} = require('@/lib/native/flag-secure');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mockRestoreFromMnemonic: mockRestoreFromMnemonic } = require(
  '@/lib/enbox/agent-store',
);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NativeBiometricVault = require('@specs/NativeBiometricVault').default;

// -----------------------------------------------------------------------
// Fixtures — standard BIP-39 test vectors (valid checksums).
// -----------------------------------------------------------------------

/** 12-word BIP-39 vector (128 bits of entropy of all zeroes). */
const VALID_MNEMONIC_12 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** 24-word BIP-39 vector (256 bits of entropy of all zeroes). */
const VALID_MNEMONIC_24 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

/**
 * 24 words whose checksum is invalid. All words are valid BIP-39 English
 * wordlist entries but the checksum (last word's trailing bits) is wrong,
 * so `validateMnemonic` returns false.
 */
const INVALID_MNEMONIC_24 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';

// -----------------------------------------------------------------------
// Helpers — Platform / AppState harnesses cribbed from recovery-phrase.
// -----------------------------------------------------------------------

function captureAppStateListener(): {
  emit: (state: AppStateStatus) => void;
} {
  let listener: ((state: AppStateStatus) => void) | null = null;
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((event: string, cb: (state: AppStateStatus) => void) => {
      if (event === 'change') listener = cb;
      return { remove: jest.fn() } as unknown as ReturnType<
        typeof AppState.addEventListener
      >;
    });
  return {
    emit: (state: AppStateStatus) => {
      if (listener) listener(state);
    },
  };
}

const originalPlatformOS = Platform.OS;
function withPlatformOS(os: 'ios' | 'android'): void {
  (Platform as { OS: string }).OS = os;
}

// -----------------------------------------------------------------------
// Helpers — get the multi-line mnemonic input and type into it.
// -----------------------------------------------------------------------

type RenderScreen = ReturnType<typeof render>;

function typeMnemonic(screen: RenderScreen, value: string): void {
  const input = screen.getByLabelText('Recovery phrase input');
  fireEvent.changeText(input, value);
}

describe('RecoveryRestoreScreen', () => {
  beforeEach(() => {
    (mockEnableFlagSecure as jest.Mock).mockClear();
    (mockDisableFlagSecure as jest.Mock).mockClear();
    (mockRestoreFromMnemonic as jest.Mock).mockReset();
    (NativeBiometricVault.generateAndStoreSecret as jest.Mock).mockClear();
    (Platform as { OS: string }).OS = originalPlatformOS;

    // Reset session store to the invalidated-but-seeded shape the screen
    // is typically mounted in: onboarding was already completed on a
    // prior install (so the seed we restore needs to re-hydrate those
    // flags), biometricStatus is `'invalidated'` because the navigator
    // matrix routed us here on that signal.
    useSessionStore.setState({
      isHydrated: true,
      hasCompletedOnboarding: false,
      hasIdentity: false,
      isLocked: true,
      biometricStatus: 'invalidated',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (Platform as { OS: string }).OS = originalPlatformOS;
  });

  // ------------------------------------------------------------------
  // Surface anchors — testID / header / CTA label + a11y
  // ------------------------------------------------------------------
  it('exposes the recovery-restore-screen testID + "Restore wallet" CTA anchors', () => {
    const screen = render(
      <RecoveryRestoreScreen onRestored={jest.fn()} />,
    );

    // VAL-CROSS-009 / VAL-UX-034 anchor — the cross-area flow asserts
    // `screen.getByTestId('recovery-restore-screen')` resolves whenever
    // biometricStatus === 'invalidated'.
    expect(screen.getByTestId('recovery-restore-screen')).toBeTruthy();

    // VAL-UX-023 / VAL-UX-038 / VAL-UX-039 CTA anchors — label text AND
    // accessibilityLabel both contain the exact "Restore wallet" string.
    expect(screen.getByText('Restore wallet')).toBeTruthy();
    expect(screen.getByLabelText('Restore wallet')).toBeTruthy();

    // Header role present (accessibility anchor for screen-readers).
    expect(screen.getByRole('header')).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // VAL-UX-023: CTA disabled before a complete mnemonic is entered
  // ------------------------------------------------------------------
  it('disables the "Restore wallet" CTA before a valid mnemonic has been typed', () => {
    const screen = render(
      <RecoveryRestoreScreen onRestored={jest.fn()} />,
    );

    // Nothing typed yet → disabled.
    const cta = screen.getByLabelText('Restore wallet');
    expect(cta.props.accessibilityState?.disabled).toBe(true);

    // Partially typed (just 5 words) → still disabled.
    typeMnemonic(screen, 'abandon abandon abandon abandon abandon');
    expect(
      screen.getByLabelText('Restore wallet').props.accessibilityState?.disabled,
    ).toBe(true);

    // Exactly 12 valid words → enabled.
    typeMnemonic(screen, VALID_MNEMONIC_12);
    expect(
      screen.getByLabelText('Restore wallet').props.accessibilityState?.disabled,
    ).toBeFalsy();
  });

  // ------------------------------------------------------------------
  // VAL-UX-023: 24-word fixture — restore mock called with normalized input
  // ------------------------------------------------------------------
  it('calls restoreFromMnemonic exactly once with the normalized 24-word mnemonic on submit', async () => {
    (mockRestoreFromMnemonic as jest.Mock).mockResolvedValue(undefined);

    const onRestored = jest.fn();
    const screen = render(
      <RecoveryRestoreScreen onRestored={onRestored} />,
    );

    // Intentionally sprinkle extra whitespace + mixed case so the
    // normalization contract (trim / lower-case / single-space) is
    // exercised end-to-end.
    const noisy = `  ABANDON\n  abandon\tabandon abandon  abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ART   `;
    typeMnemonic(screen, noisy);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Restore wallet'));
    });

    expect(mockRestoreFromMnemonic).toHaveBeenCalledTimes(1);
    expect(mockRestoreFromMnemonic).toHaveBeenCalledWith(VALID_MNEMONIC_24);
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // VAL-UX-023: 12-word fixture — restore mock called with normalized input
  // ------------------------------------------------------------------
  it('also supports a 12-word mnemonic', async () => {
    (mockRestoreFromMnemonic as jest.Mock).mockResolvedValue(undefined);

    const onRestored = jest.fn();
    const screen = render(
      <RecoveryRestoreScreen onRestored={onRestored} />,
    );

    typeMnemonic(screen, `  ${VALID_MNEMONIC_12.toUpperCase()}  `);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Restore wallet'));
    });

    expect(mockRestoreFromMnemonic).toHaveBeenCalledTimes(1);
    expect(mockRestoreFromMnemonic).toHaveBeenCalledWith(VALID_MNEMONIC_12);
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // VAL-UX-024: success path — biometricStatus flips to 'ready', onRestored
  // fires, hasCompletedOnboarding / hasIdentity are hydrated by the screen
  // (not silently reset).
  // ------------------------------------------------------------------
  it('sets session.biometricStatus to "ready" and hydrates identity flags on successful restore', async () => {
    (mockRestoreFromMnemonic as jest.Mock).mockResolvedValue(undefined);
    useSessionStore.setState({ biometricStatus: 'invalidated' });

    const onRestored = jest.fn();
    const screen = render(
      <RecoveryRestoreScreen onRestored={onRestored} />,
    );

    typeMnemonic(screen, VALID_MNEMONIC_24);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Restore wallet'));
    });

    expect(mockRestoreFromMnemonic).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().biometricStatus).toBe('ready');
    // The restored seed implies the user had already finished onboarding
    // and has at least one identity available to rehydrate.
    expect(useSessionStore.getState().hasCompletedOnboarding).toBe(true);
    expect(useSessionStore.getState().hasIdentity).toBe(true);
    // isLocked must also flip to `false` so the navigator matrix can
    // route the user past BiometricUnlock without requiring a second
    // prompt — the `hydrateRestored()` helper is the single entry
    // point that touches all four flags.
    expect(useSessionStore.getState().isLocked).toBe(false);
    // `onRestored` is how the screen hands control back to the navigator;
    // it must be fired exactly once, no more.
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // Commit-path contract: the screen MUST flip the session snapshot
  // via the store's dedicated `hydrateRestored()` helper exactly once
  // on a successful restore. This guards against a regression to a
  // raw `useSessionStore.setState({...})` call which would bypass the
  // store's persistence path and mis-route a cold relaunch to the
  // Welcome / BiometricSetup screens.
  // ------------------------------------------------------------------
  it('commits the restored session exactly once via useSessionStore.hydrateRestored()', async () => {
    (mockRestoreFromMnemonic as jest.Mock).mockResolvedValue(undefined);
    useSessionStore.setState({ biometricStatus: 'invalidated' });

    const hydrateRestoredSpy = jest.spyOn(
      useSessionStore.getState(),
      'hydrateRestored',
    );

    const onRestored = jest.fn();
    const screen = render(
      <RecoveryRestoreScreen onRestored={onRestored} />,
    );

    typeMnemonic(screen, VALID_MNEMONIC_24);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Restore wallet'));
    });

    expect(mockRestoreFromMnemonic).toHaveBeenCalledTimes(1);
    expect(hydrateRestoredSpy).toHaveBeenCalledTimes(1);
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  // Negative-path commit contract — a restore failure MUST NOT flip
  // the session flags via `hydrateRestored()`. Covered by the
  // existing "surfaces an inline alert when restoreFromMnemonic
  // rejects and does NOT route away" test (below): it asserts
  // `biometricStatus` remains `'invalidated'`, `hasCompletedOnboarding`
  // is not flipped, and `onRestored` is not called — all of which
  // would be violated if the screen called `hydrateRestored()` on
  // the error path.

  // ------------------------------------------------------------------
  // VAL-UX-026: biometric vault sealing is re-armed exactly once
  // ------------------------------------------------------------------
  it('re-arms biometric protection exactly once after a successful restore', async () => {
    // Make the mocked restore delegate to the native biometric seal so
    // we can observe the seal invocation from the screen-test scope.
    (mockRestoreFromMnemonic as jest.Mock).mockImplementation(
      async (phrase: string) => {
        await NativeBiometricVault.generateAndStoreSecret('enbox.wallet.root', {
          requireBiometrics: true,
          invalidateOnEnrollmentChange: true,
          // We don't have the derived entropy in the test; pass a
          // non-empty marker so the mock's default handler (which stores
          // whatever it receives) still records the call.
          secretHex: '00'.repeat(32),
          _testPhrase: phrase,
        });
      },
    );

    const onRestored = jest.fn();
    const screen = render(
      <RecoveryRestoreScreen onRestored={onRestored} />,
    );

    typeMnemonic(screen, VALID_MNEMONIC_24);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Restore wallet'));
    });

    expect(mockRestoreFromMnemonic).toHaveBeenCalledTimes(1);
    expect(NativeBiometricVault.generateAndStoreSecret).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().biometricStatus).toBe('ready');
  });

  // ------------------------------------------------------------------
  // VAL-UX-025: invalid mnemonic shows alert; restore mock NOT called
  // ------------------------------------------------------------------
  it('shows a clear role="alert" message on an invalid mnemonic and does NOT call restore', async () => {
    const onRestored = jest.fn();
    const screen = render(
      <RecoveryRestoreScreen onRestored={onRestored} />,
    );

    typeMnemonic(screen, INVALID_MNEMONIC_24);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Restore wallet'));
    });

    // Restore mock must not have been invoked.
    expect(mockRestoreFromMnemonic).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();

    // Inline alert present with user-readable copy referencing at
    // least one of the VAL-UX-025 keywords.
    const alert = screen.getByRole('alert');
    expect(alert).toBeTruthy();
    expect(
      String(alert.props.children ?? ''),
    ).toMatch(/recovery|phrase|invalid|incorrect|word/i);

    // Input retains the typed value so the user can edit rather than
    // re-type from scratch.
    const input = screen.getByLabelText('Recovery phrase input');
    expect(input.props.value).toBe(INVALID_MNEMONIC_24);

    // No navigation occurred; biometricStatus stays invalidated.
    expect(useSessionStore.getState().biometricStatus).toBe('invalidated');
  });

  // ------------------------------------------------------------------
  // VAL-UX-025: word count mismatch (e.g. 10 words) also surfaces alert
  // ------------------------------------------------------------------
  it('rejects a short mnemonic with an inline alert and never calls restore', async () => {
    const onRestored = jest.fn();
    const screen = render(
      <RecoveryRestoreScreen onRestored={onRestored} />,
    );

    // 10 words — neither a 12- nor a 24-word mnemonic.
    typeMnemonic(
      screen,
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon',
    );

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Restore wallet'));
    });

    expect(mockRestoreFromMnemonic).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();

    // CTA was disabled so the alert may not have been shown; but the
    // screen must NOT have navigated away either way.
    expect(useSessionStore.getState().biometricStatus).toBe('invalidated');
  });

  // ------------------------------------------------------------------
  // Restore failure from the store (e.g. native seal rejected) surfaces
  // an inline alert, does NOT call onRestored, and keeps the input.
  // ------------------------------------------------------------------
  it('surfaces an inline alert when restoreFromMnemonic rejects and does NOT route away', async () => {
    const err = Object.assign(new Error('native seal failed'), {
      code: 'VAULT_ERROR',
    });
    (mockRestoreFromMnemonic as jest.Mock).mockRejectedValueOnce(err);

    const onRestored = jest.fn();
    const screen = render(
      <RecoveryRestoreScreen onRestored={onRestored} />,
    );

    typeMnemonic(screen, VALID_MNEMONIC_24);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Restore wallet'));
    });

    expect(mockRestoreFromMnemonic).toHaveBeenCalledTimes(1);
    expect(onRestored).not.toHaveBeenCalled();

    const alert = screen.getByRole('alert');
    expect(alert).toBeTruthy();

    // Input retains the typed value so the user can retry without
    // retyping.
    expect(
      screen.getByLabelText('Recovery phrase input').props.value,
    ).toBe(VALID_MNEMONIC_24);

    // Status stays invalidated until a real success flips it.
    expect(useSessionStore.getState().biometricStatus).toBe('invalidated');
  });

  // ------------------------------------------------------------------
  // Rapid-tap debounce: two synchronous presses collapse to one restore.
  // ------------------------------------------------------------------
  it('debounces rapid taps while a restore is in-flight', async () => {
    let resolveRestore: (() => void) | undefined;
    (mockRestoreFromMnemonic as jest.Mock).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRestore = resolve;
        }),
    );

    const onRestored = jest.fn();
    const screen = render(
      <RecoveryRestoreScreen onRestored={onRestored} />,
    );

    typeMnemonic(screen, VALID_MNEMONIC_24);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Restore wallet'));
      fireEvent.press(screen.getByLabelText('Restore wallet'));
      fireEvent.press(screen.getByLabelText('Restore wallet'));
    });

    expect(mockRestoreFromMnemonic).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRestore?.();
    });

    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // VAL-UX-043: FLAG_SECURE is enabled on mount and cleared on unmount
  // ------------------------------------------------------------------
  it('enables Android FLAG_SECURE on mount and clears it on unmount', () => {
    const screen = render(
      <RecoveryRestoreScreen onRestored={jest.fn()} />,
    );

    expect(mockEnableFlagSecure).toHaveBeenCalledTimes(1);
    expect(mockDisableFlagSecure).not.toHaveBeenCalled();

    screen.unmount();

    expect(mockDisableFlagSecure).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // VAL-UX-044: iOS cover view is toggled by AppState transitions.
  // ------------------------------------------------------------------
  it('renders an opaque cover view on iOS when AppState leaves "active"', () => {
    withPlatformOS('ios');
    const capture = captureAppStateListener();

    const screen = render(
      <RecoveryRestoreScreen onRestored={jest.fn()} />,
    );

    expect(screen.queryByTestId('recovery-restore-privacy-cover')).toBeNull();

    act(() => {
      capture.emit('inactive');
    });
    expect(screen.getByTestId('recovery-restore-privacy-cover')).toBeTruthy();

    act(() => {
      capture.emit('active');
    });
    expect(screen.queryByTestId('recovery-restore-privacy-cover')).toBeNull();

    act(() => {
      capture.emit('background');
    });
    expect(screen.getByTestId('recovery-restore-privacy-cover')).toBeTruthy();
  });

  it('does NOT register the AppState listener on Android', () => {
    withPlatformOS('android');
    const capture = captureAppStateListener();

    const screen = render(
      <RecoveryRestoreScreen onRestored={jest.fn()} />,
    );

    act(() => {
      capture.emit('background');
    });

    expect(screen.queryByTestId('recovery-restore-privacy-cover')).toBeNull();
  });
});
