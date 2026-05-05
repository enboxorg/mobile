/**
 * RecoveryPhraseScreen × resume-pending-backup UI test (VAL-VAULT-028).
 *
 * Covers the UI half of the pending-first-backup durability fix. The
 * store-side primitives — `isPendingFirstBackup` persistence,
 * `commitSetupInitialized()` atomic write, and `resumePendingBackup()`
 * mnemonic re-derivation — are exercised in their own test files. This
 * suite pins the screen's behavior when the navigator passes
 * `mnemonic=""` (cold relaunch with pending backup) alongside an
 * `onResumeBackup` callback:
 *
 *   1. With `onResumeBackup` set AND `mnemonic===''`, the screen renders
 *      the "Show recovery phrase" CTA (not an empty word grid).
 *   2. Pressing that CTA invokes `onResumeBackup` exactly once.
 *   3. While the promise is pending the CTA label changes to
 *      `Authenticating…` and `disabled` is honored.
 *   4. A rejection from `onResumeBackup` surfaces as an a11y-live error
 *      message (the words themselves must NOT flash onto the screen
 *      even on failure — the screen stays on the CTA).
 *   5. A populated `mnemonic` prop renders the normal word-grid path
 *      regardless of whether `onResumeBackup` is passed (the screen
 *      does NOT regress the happy-path UI when the navigator wires
 *      the resume hook unconditionally).
 */

// Spy on the secure-storage wrapper so any incidental access from the
// screen's lifecycle doesn't hit real SharedPreferences / Keychain.
jest.mock('@/lib/storage/secure-storage', () => ({
  __esModule: true,
  getSecureItem: jest.fn().mockResolvedValue(null),
  setSecureItem: jest.fn().mockResolvedValue(undefined),
  deleteSecureItem: jest.fn().mockResolvedValue(undefined),
}));

// Silence the native FlagSecure shim — it's exercised end-to-end by the
// dedicated `flag-secure-native` suite; in this file we're only pinning
// the resume-flow UX.
jest.mock('@/lib/native/flag-secure', () => ({
  __esModule: true,
  enableFlagSecure: jest.fn(),
  disableFlagSecure: jest.fn(),
  FLAG_SECURE_MODULE_NAME: 'EnboxFlagSecure',
}));

import {
  act,
  fireEvent,
  render,
  waitFor,
} from '@testing-library/react-native';

import { RecoveryPhraseScreen } from '@/features/auth/screens/recovery-phrase-screen';

const RESUME_LABEL = 'Show recovery phrase';
const CONFIRM_LABEL = 'I\u2019ve saved it';

// A deferred resolver helper — lets tests observe the screen's
// "in-flight" UI (Authenticating…) before the onResumeBackup promise
// settles.
function makeDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('RecoveryPhraseScreen — resume-pending-backup CTA (VAL-VAULT-028)', () => {
  it('renders the "Show recovery phrase" CTA when mnemonic is empty and onResumeBackup is provided', () => {
    const { queryByLabelText } = render(
      <RecoveryPhraseScreen
        mnemonic=""
        onConfirm={jest.fn()}
        onResumeBackup={jest.fn().mockResolvedValue(undefined)}
      />,
    );

    // Resume CTA is visible (a11y label matches the canonical literal).
    expect(queryByLabelText(RESUME_LABEL)).not.toBeNull();

    // The word-grid is NOT rendered (otherwise the tests would be
    // able to locate its a11y container even with zero children — we
    // use that absence as the "CTA branch is active" signal).
    expect(queryByLabelText('Recovery phrase')).toBeNull();

    // The confirmation CTA must NOT be visible either — the user
    // hasn't seen any words yet, so pressing it would route past the
    // backup gate with an empty phrase.
    expect(queryByLabelText(CONFIRM_LABEL)).toBeNull();
  });

  it('calls onResumeBackup exactly once when the CTA is pressed', async () => {
    const onResumeBackup = jest.fn().mockResolvedValue(undefined);

    const { getByLabelText } = render(
      <RecoveryPhraseScreen
        mnemonic=""
        onConfirm={jest.fn()}
        onResumeBackup={onResumeBackup}
      />,
    );

    await act(async () => {
      fireEvent.press(getByLabelText(RESUME_LABEL));
    });

    expect(onResumeBackup).toHaveBeenCalledTimes(1);
  });

  it('shows "Authenticating…" while the resume promise is pending and ignores repeated taps', async () => {
    const deferred = makeDeferred<void>();
    const onResumeBackup = jest.fn().mockImplementation(() => deferred.promise);

    const { getByLabelText, queryByText } = render(
      <RecoveryPhraseScreen
        mnemonic=""
        onConfirm={jest.fn()}
        onResumeBackup={onResumeBackup}
      />,
    );

    // Press: the promise is still pending.
    await act(async () => {
      fireEvent.press(getByLabelText(RESUME_LABEL));
    });

    // The label swaps to the "in-flight" copy. We locate by text
    // because the CTA's accessibilityLabel stays stable ("Show
    // recovery phrase") across the state swap — only the visible
    // label changes.
    expect(queryByText('Authenticating…')).not.toBeNull();

    // Double-press while in-flight: the screen's re-entrancy guard
    // (`if (!onResumeBackup || isResuming) return;`) must drop the
    // second call.
    await act(async () => {
      fireEvent.press(getByLabelText(RESUME_LABEL));
      fireEvent.press(getByLabelText(RESUME_LABEL));
    });
    expect(onResumeBackup).toHaveBeenCalledTimes(1);

    // Resolve the deferred so the test doesn't leak a pending promise
    // past completion.
    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });
  });

  it('surfaces an a11y-live error message when onResumeBackup rejects (and keeps the CTA visible)', async () => {
    const failure = Object.assign(new Error('Biometric prompt cancelled'), {
      code: 'VAULT_ERROR_USER_CANCELED',
    });
    const onResumeBackup = jest.fn().mockRejectedValue(failure);

    const { getByLabelText, findByTestId, queryByLabelText } = render(
      <RecoveryPhraseScreen
        mnemonic=""
        onConfirm={jest.fn()}
        onResumeBackup={onResumeBackup}
      />,
    );

    await act(async () => {
      fireEvent.press(getByLabelText(RESUME_LABEL));
    });

    const errorNode = await findByTestId('recovery-phrase-resume-error');
    expect(errorNode).toBeTruthy();
    // The rejection's message is surfaced verbatim so the user can
    // distinguish user-cancel from key-invalidated without the screen
    // having to enumerate every code.
    expect(errorNode.props.children).toBe('Biometric prompt cancelled');
    // The error container is an a11y live region so VoiceOver /
    // TalkBack announce the failure without the user having to
    // navigate to it.
    expect(errorNode.props.accessibilityLiveRegion).toBe('polite');

    // CRUCIAL: the word grid must NOT have materialized. Even on
    // failure the screen stays on the CTA branch; a regression that
    // rendered the grid with an empty string would be a silent leak
    // vector in future refactors.
    expect(queryByLabelText('Recovery phrase')).toBeNull();

    // CTA is still visible so the user can retry.
    expect(getByLabelText(RESUME_LABEL)).toBeTruthy();
  });

  it('clears the error message on a subsequent press (retry UX)', async () => {
    const failure = new Error('first attempt failed');
    const onResumeBackup = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);

    const { getByLabelText, findByTestId, queryByTestId } = render(
      <RecoveryPhraseScreen
        mnemonic=""
        onConfirm={jest.fn()}
        onResumeBackup={onResumeBackup}
      />,
    );

    await act(async () => {
      fireEvent.press(getByLabelText(RESUME_LABEL));
    });
    await findByTestId('recovery-phrase-resume-error');

    // Second press starts a fresh attempt — the error is cleared at
    // the very beginning of handleResume() (setResumeError(null)).
    await act(async () => {
      fireEvent.press(getByLabelText(RESUME_LABEL));
    });

    await waitFor(() => {
      expect(queryByTestId('recovery-phrase-resume-error')).toBeNull();
    });

    expect(onResumeBackup).toHaveBeenCalledTimes(2);
  });

  it('renders the word grid (NOT the resume CTA) when mnemonic is populated even if onResumeBackup is also passed', () => {
    const mnemonic = Array.from({ length: 24 }, (_, i) => `w${i + 1}`).join(
      ' ',
    );

    const { queryByLabelText, getByLabelText } = render(
      <RecoveryPhraseScreen
        mnemonic={mnemonic}
        onConfirm={jest.fn()}
        onResumeBackup={jest.fn().mockResolvedValue(undefined)}
      />,
    );

    // Word grid is rendered with all 24 words.
    const grid = getByLabelText('Recovery phrase');
    expect(grid).toBeTruthy();

    // Resume CTA is NOT rendered — the grid branch is the active one.
    expect(queryByLabelText(RESUME_LABEL)).toBeNull();

    // Confirm CTA IS rendered so the user can press "I've saved it".
    expect(queryByLabelText(CONFIRM_LABEL)).not.toBeNull();
  });

  it('renders an empty grid (legacy behaviour) when mnemonic is empty AND onResumeBackup is NOT provided', () => {
    // This guards the opt-in nature of the resume flow: legacy call
    // sites that pass an empty mnemonic without wiring resume should
    // see the pre-VAL-VAULT-028 rendering (empty grid, no CTA). This
    // keeps existing unit tests that don't know about the resume path
    // from breaking.
    const { queryByLabelText } = render(
      <RecoveryPhraseScreen mnemonic="" onConfirm={jest.fn()} />,
    );

    expect(queryByLabelText(RESUME_LABEL)).toBeNull();
    // Confirm CTA is still wired (legacy behaviour) — the screen
    // doesn't block confirmation purely on an empty mnemonic.
    expect(queryByLabelText(CONFIRM_LABEL)).not.toBeNull();
  });
});
