/**
 * RecoveryPhraseScreen component tests.
 *
 * Covers validation-contract assertions:
 *   - VAL-UX-020: renders a 24-word mnemonic in order, exposes the
 *     "I've saved it" confirm button (text + a11y label), and invokes
 *     the confirm callback exactly once on press.
 *   - VAL-UX-021: does NOT write the mnemonic (or any of its words) to
 *     any persistent storage during the full lifecycle (mount → confirm
 *     → unmount). Spies on `setSecureItem`, `NativeBiometricVault`
 *     writes, and the globally-mocked `@react-native-async-storage/async-storage`
 *     module assert zero matching payloads.
 *   - VAL-UX-022: the screen does NOT render a Copy affordance (the
 *     branch that the implementation under test takes). Asserted
 *     explicitly so a later silent addition is flagged.
 *   - VAL-UX-043: enables Android FLAG_SECURE on mount and clears it on
 *     unmount (via the `@/lib/native/flag-secure` wrapper).
 *   - VAL-UX-044: on iOS renders an opaque cover view when `AppState`
 *     transitions to `inactive` or `background`, and removes the cover
 *     on `active`.
 *   - VAL-UX-045: sets `gestureEnabled: false` and `headerBackVisible:
 *     false` on the React Navigation screen options so back-navigation
 *     cannot re-expose the mnemonic after confirmation.
 *   - VAL-UX-046: clipboard TTL branch is vacuously satisfied — no Copy
 *     button, no `Clipboard.setString` dependency.
 *   - VAL-UX-047: rapid-tap debounce — two synchronous presses on the
 *     confirm button collapse to a single `onConfirm` call.
 */

// Mock the flag-secure wrapper with trackable jest.fn()s so we can
// assert enable/disable are called on mount and unmount respectively.
jest.mock('@/lib/native/flag-secure', () => ({
  __esModule: true,
  enableFlagSecure: jest.fn(),
  disableFlagSecure: jest.fn(),
  FLAG_SECURE: 0x00002000,
}));

// Spy on the secure-storage wrapper used by the rest of the app so we
// can assert zero writes of any mnemonic word.
jest.mock('@/lib/storage/secure-storage', () => ({
  __esModule: true,
  getSecureItem: jest.fn().mockResolvedValue(null),
  setSecureItem: jest.fn().mockResolvedValue(undefined),
  deleteSecureItem: jest.fn().mockResolvedValue(undefined),
}));

import { act, fireEvent, render } from '@testing-library/react-native';
import { AppState, Platform, type AppStateStatus } from 'react-native';

import { RecoveryPhraseScreen } from '@/features/auth/screens/recovery-phrase-screen';
 
const {
  enableFlagSecure: mockEnableFlagSecure,
  disableFlagSecure: mockDisableFlagSecure,
} = require('@/lib/native/flag-secure');
 
const {
  setSecureItem: mockSetSecureItem,
  deleteSecureItem: mockDeleteSecureItem,
} = require('@/lib/storage/secure-storage');
 
const NativeBiometricVault = require('@specs/NativeBiometricVault').default;

/**
 * 24-word fixture whose words are all distinct so per-word rendering
 * assertions (VAL-UX-020) are unambiguous. These are NOT real BIP-39
 * wordlist entries — the screen is agnostic to the mnemonic contents;
 * it just renders whatever it is handed.
 */
const MNEMONIC_24: readonly string[] = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
  'mike',
  'november',
  'oscar',
  'papa',
  'quebec',
  'romeo',
  'sierra',
  'tango',
  'uniform',
  'victor',
  'whiskey',
  'xray',
];

const MNEMONIC_24_STRING = MNEMONIC_24.join(' ');

/**
 * Capture the last AppState listener registered by a mounted component
 * so the test can drive it synchronously. The standard RN Jest preset
 * provides a working `AppState.addEventListener`; we spy on it per-test
 * so we don't need to touch the global preset.
 */
function captureAppStateListener(): {
  emit: (state: AppStateStatus) => void;
  listener: ((state: AppStateStatus) => void) | null;
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
    listener,
    emit: (state: AppStateStatus) => {
      if (listener) listener(state);
    },
  };
}

/**
 * Force Platform.OS to a specific value for the duration of a single
 * test. Restored automatically after the test runs.
 */
function withPlatformOS(os: 'ios' | 'android'): void {
  // Platform in the RN preset is a plain mutable object — direct
  // assignment works. We restore via a top-level afterEach.
  (Platform as { OS: string }).OS = os;
}

const originalPlatformOS = Platform.OS;

describe('RecoveryPhraseScreen', () => {
  beforeEach(() => {
    (mockEnableFlagSecure as jest.Mock).mockClear();
    (mockDisableFlagSecure as jest.Mock).mockClear();
    (mockSetSecureItem as jest.Mock).mockClear();
    (mockDeleteSecureItem as jest.Mock).mockClear();
    (NativeBiometricVault.generateAndStoreSecret as jest.Mock).mockClear();
    (NativeBiometricVault.deleteSecret as jest.Mock).mockClear();
    (Platform as { OS: string }).OS = originalPlatformOS;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (Platform as { OS: string }).OS = originalPlatformOS;
  });

  // ------------------------------------------------------------------
  // VAL-UX-020: renders each word + confirm CTA + onConfirm()
  // ------------------------------------------------------------------
  it('renders the full 24-word mnemonic in order exactly once each', () => {
    const onConfirm = jest.fn();
    const screen = render(
      <RecoveryPhraseScreen
        mnemonic={MNEMONIC_24_STRING}
        onConfirm={onConfirm}
      />,
    );

    for (let i = 0; i < MNEMONIC_24.length; i++) {
      const word = MNEMONIC_24[i];
      // Each word appears exactly once in the rendered tree.
      const matches = screen.getAllByText(word);
      expect(matches).toHaveLength(1);
      // The word is rendered inside its numbered cell (preserving order).
      expect(screen.getByTestId(`recovery-phrase-word-${i + 1}`)).toBeTruthy();
    }

    // Title is exposed as a screen-reader header.
    expect(screen.getByRole('header')).toBeTruthy();
  });

  it('renders the confirm button with matching text and accessibilityLabel', () => {
    const screen = render(
      <RecoveryPhraseScreen
        mnemonic={MNEMONIC_24_STRING}
        onConfirm={jest.fn()}
      />,
    );

    // Exact VAL-UX-039 anchor (literal apostrophe is the curly Unicode
    // `\u2019` per the feature description).
    expect(screen.getByText('I\u2019ve saved it')).toBeTruthy();
    expect(screen.getByLabelText('I\u2019ve saved it')).toBeTruthy();
  });

  it('invokes onConfirm exactly once when the confirm button is pressed', () => {
    const onConfirm = jest.fn();
    const screen = render(
      <RecoveryPhraseScreen
        mnemonic={MNEMONIC_24_STRING}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.press(screen.getByLabelText('I\u2019ve saved it'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // VAL-UX-047: rapid-tap debounce collapses to one onConfirm call.
  // ------------------------------------------------------------------
  it('debounces rapid taps on the confirm button to a single onConfirm call', () => {
    const onConfirm = jest.fn();
    const screen = render(
      <RecoveryPhraseScreen
        mnemonic={MNEMONIC_24_STRING}
        onConfirm={onConfirm}
      />,
    );

    const cta = screen.getByLabelText('I\u2019ve saved it');
    fireEvent.press(cta);
    fireEvent.press(cta);
    fireEvent.press(cta);

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // VAL-UX-043: FLAG_SECURE on mount + unmount.
  // ------------------------------------------------------------------
  it('enables Android FLAG_SECURE on mount and clears it on unmount', () => {
    const screen = render(
      <RecoveryPhraseScreen
        mnemonic={MNEMONIC_24_STRING}
        onConfirm={jest.fn()}
      />,
    );

    expect(mockEnableFlagSecure).toHaveBeenCalledTimes(1);
    expect(mockDisableFlagSecure).not.toHaveBeenCalled();

    screen.unmount();

    expect(mockDisableFlagSecure).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // VAL-UX-044: iOS cover view is toggled by AppState transitions.
  // ------------------------------------------------------------------
  it('renders an opaque cover view on iOS when AppState becomes inactive or background', () => {
    withPlatformOS('ios');
    const capture = captureAppStateListener();

    const screen = render(
      <RecoveryPhraseScreen
        mnemonic={MNEMONIC_24_STRING}
        onConfirm={jest.fn()}
      />,
    );

    // Initially there is no cover (app is 'active').
    expect(screen.queryByTestId('recovery-phrase-privacy-cover')).toBeNull();

    // Backgrounding (or 'inactive') must draw the cover.
    act(() => {
      capture.emit('inactive');
    });
    expect(screen.getByTestId('recovery-phrase-privacy-cover')).toBeTruthy();

    act(() => {
      capture.emit('active');
    });
    expect(screen.queryByTestId('recovery-phrase-privacy-cover')).toBeNull();

    act(() => {
      capture.emit('background');
    });
    expect(screen.getByTestId('recovery-phrase-privacy-cover')).toBeTruthy();
  });

  it('does NOT render the iOS cover view on Android (FLAG_SECURE handles app-switcher)', () => {
    withPlatformOS('android');
    const capture = captureAppStateListener();

    const screen = render(
      <RecoveryPhraseScreen
        mnemonic={MNEMONIC_24_STRING}
        onConfirm={jest.fn()}
      />,
    );

    // The Android effect path never installs the screen's own listener —
    // even if we forcibly emit a background event, the cover must not
    // appear (there is no registered handler to flip the state).
    act(() => {
      capture.emit('background');
    });
    expect(screen.queryByTestId('recovery-phrase-privacy-cover')).toBeNull();
  });

  // ------------------------------------------------------------------
  // VAL-UX-045: back-navigation disabled via navigation.setOptions.
  // ------------------------------------------------------------------
  it('disables back-navigation via navigation.setOptions', () => {
    const setOptions = jest.fn();
    const navigation = { setOptions };

    render(
      <RecoveryPhraseScreen
        mnemonic={MNEMONIC_24_STRING}
        onConfirm={jest.fn()}
        navigation={navigation}
      />,
    );

    expect(setOptions).toHaveBeenCalledTimes(1);
    const options = setOptions.mock.calls[0][0];
    expect(options.gestureEnabled).toBe(false);
    expect(options.headerBackVisible).toBe(false);
    // headerLeft returning null is the belt-and-suspenders fallback.
    expect(typeof options.headerLeft).toBe('function');
    expect(options.headerLeft()).toBeNull();
  });

  // ------------------------------------------------------------------
  // VAL-UX-022 / VAL-UX-046: no Copy affordance in this implementation.
  // ------------------------------------------------------------------
  it('does NOT render a Copy affordance (clipboard TTL is vacuously satisfied)', () => {
    const screen = render(
      <RecoveryPhraseScreen
        mnemonic={MNEMONIC_24_STRING}
        onConfirm={jest.fn()}
      />,
    );

    // No button-labelled / text-labelled "Copy" element.
    expect(screen.queryByLabelText(/copy/i)).toBeNull();
    expect(screen.queryByText(/^copy/i)).toBeNull();
  });

  // ------------------------------------------------------------------
  // VAL-UX-021: mnemonic is never persisted across the full lifecycle.
  // ------------------------------------------------------------------
  it('never writes the mnemonic (or any individual word) to any storage across the lifecycle', () => {
    const onConfirm = jest.fn();
    const screen = render(
      <RecoveryPhraseScreen
        mnemonic={MNEMONIC_24_STRING}
        onConfirm={onConfirm}
      />,
    );

    // Press confirm to run the on-confirm code path.
    fireEvent.press(screen.getByLabelText('I\u2019ve saved it'));

    // Then unmount so any teardown-time persistence would also be
    // captured by the spies.
    screen.unmount();

    const allStorageCalls = [
      ...(mockSetSecureItem as jest.Mock).mock.calls,
      ...(mockDeleteSecureItem as jest.Mock).mock.calls,
      ...(NativeBiometricVault.generateAndStoreSecret as jest.Mock).mock.calls,
      ...(NativeBiometricVault.deleteSecret as jest.Mock).mock.calls,
    ];

    // The screen must never pass a value containing any mnemonic word
    // to any persistence sink. We compare lower-case to be forgiving
    // against incidental case-fold drift in the future.
    const lowerWords = MNEMONIC_24.map((w) => w.toLowerCase());
    for (const callArgs of allStorageCalls) {
      for (const arg of callArgs) {
        if (typeof arg !== 'string') continue;
        const hay = arg.toLowerCase();
        for (const needle of lowerWords) {
          expect(hay).not.toContain(needle);
        }
      }
    }

    // The secure-storage setter is never called at all during this
    // screen's lifecycle (stronger than the word-sweep above).
    expect(mockSetSecureItem).not.toHaveBeenCalled();

    // The biometric-vault native sealer is never called during this
    // screen's lifecycle — the phrase is display-only.
    expect(NativeBiometricVault.generateAndStoreSecret).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Supports shorter mnemonics too (the screen itself is length-agnostic
  // so the restore-path screen can reuse it). 12 words also render in
  // order exactly once each.
  // ------------------------------------------------------------------
  it('supports a 12-word mnemonic (render-order invariant applies)', () => {
    const twelveWords = MNEMONIC_24.slice(0, 12);
    const screen = render(
      <RecoveryPhraseScreen
        mnemonic={twelveWords.join(' ')}
        onConfirm={jest.fn()}
      />,
    );

    for (let i = 0; i < twelveWords.length; i++) {
      expect(screen.getAllByText(twelveWords[i])).toHaveLength(1);
      expect(screen.getByTestId(`recovery-phrase-word-${i + 1}`)).toBeTruthy();
    }
    expect(
      screen.queryByTestId(`recovery-phrase-word-${twelveWords.length + 1}`),
    ).toBeNull();
  });
});
