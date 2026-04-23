import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  type AppStateStatus,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { validateMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english';

import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import { useSessionStore } from '@/features/session/session-store';
import { useAgentStore } from '@/lib/enbox/agent-store';
import {
  disableFlagSecure,
  enableFlagSecure,
} from '@/lib/native/flag-secure';
import { useAppTheme } from '@/theme';

/**
 * Stable CTA anchor (VAL-UX-038 / VAL-UX-039). Reused as both the visible
 * label and the `accessibilityLabel` so screen-readers, Jest assertions,
 * and the CI UI driver all locate the control with the same string.
 */
const CTA_LABEL = 'Restore wallet';

/** a11y label for the multi-line mnemonic TextInput — used by tests. */
const INPUT_LABEL = 'Recovery phrase input';

/** Accepted mnemonic lengths per BIP-39 (12 or 24 words for this wallet). */
const ACCEPTED_WORD_COUNTS = new Set([12, 24]);

/**
 * Copy used on the `VAL-UX-025` invalid-mnemonic alert. The copy MUST
 * contain at least one of `recovery` / `phrase` / `invalid` /
 * `incorrect` / `word` so the validation-contract text-matcher accepts
 * it.
 */
const INVALID_MNEMONIC_MESSAGE =
  "That recovery phrase doesn't look right. Double-check each word and try again.";

/**
 * Copy shown when `useSessionStore.hydrateRestored()` rejects (i.e. the
 * native `restoreFromMnemonic` seal succeeded but the downstream
 * SecureStorage write for the onboarding/identity snapshot failed).
 * The seal itself worked — re-typing the mnemonic and re-running the
 * flow gives the underlying SecureStorage stack another chance to
 * commit, so the copy explicitly invites the user to retry rather than
 * suggesting the phrase was wrong.
 */
const SESSION_PERSIST_FAILURE_MESSAGE =
  'Restore succeeded but the session could not be saved. Please try again.';

/**
 * Normalize a mnemonic typed into the multi-line input. The contract is
 * stable across the app (see VAL-UX-023 evidence):
 *
 *   1. Lower-case every letter — BIP-39 is case-insensitive but the
 *      wordlist is lower-case so any cased input must be folded.
 *   2. Trim leading / trailing whitespace so stray newlines at the end
 *      of the paste do not break validation.
 *   3. Collapse every run of whitespace (spaces, tabs, newlines) to a
 *      single ASCII space so the stored mnemonic matches the canonical
 *      `word word word ...` form.
 */
export function normalizeMnemonicInput(raw: string): string {
  return raw.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

export interface RecoveryRestoreScreenProps {
  /**
   * Called exactly once after a successful vault restore. The navigator
   * typically maps this to `navigation.reset({ routes: [{ name: 'Main' }] })`
   * or `navigation.replace('Main')` — the screen itself does not touch
   * React Navigation (tests mount it in isolation).
   */
  onRestored: () => void;

  /**
   * Optional React Navigation prop. When provided, the screen installs
   * `gestureEnabled: false` and `headerBackVisible: false` so the user
   * cannot swipe/press-back to bypass the restore flow. Absence is safe
   * — the host navigator's stack configuration governs back-navigation
   * by default.
   */
  navigation?: {
    setOptions?: (options: Record<string, unknown>) => void;
  };
}

/**
 * RecoveryRestoreScreen — shown when the biometric-sealed native secret
 * has been invalidated (enrollment change) or when the user explicitly
 * chooses to restore from a recovery phrase.
 *
 * Responsibilities (validation-contract assertions in parens):
 *   1. Render a multi-line mnemonic input + a "Restore wallet" CTA
 *      (VAL-UX-023). The CTA is disabled until the typed input
 *      normalizes to 12 or 24 non-empty words.
 *   2. On submit, normalize the input (trim / lower-case / collapse
 *      whitespace) and validate against BIP-39 (checksum + wordlist).
 *      On failure render a role="alert" inline error and DO NOT call
 *      the restore action (VAL-UX-025).
 *   3. On valid input call `useAgentStore.restoreFromMnemonic(normalized)`
 *      which internally re-seals the biometric vault with the restored
 *      entropy and re-initializes the agent (VAL-UX-024 / VAL-UX-026).
 *   4. On success flip `session.biometricStatus` to `'ready'`, hydrate
 *      `hasCompletedOnboarding` + `hasIdentity`, and hand control back
 *      to the navigator via `onRestored` exactly once (VAL-UX-024).
 *   5. On restore failure surface an inline role="alert" error, keep
 *      the input populated for retry, and do NOT navigate away.
 *   6. Android: enable FLAG_SECURE on mount / clear on unmount
 *      (VAL-UX-043).
 *   7. iOS: render an opaque privacy cover when `AppState` transitions
 *      to `inactive` / `background` so the mnemonic never ends up in
 *      the app-switcher snapshot (VAL-UX-044).
 */
export function RecoveryRestoreScreen({
  onRestored,
  navigation,
}: RecoveryRestoreScreenProps) {
  const theme = useAppTheme();
  const restoreFromMnemonic = useAgentStore(
    (s) => (s as { restoreFromMnemonic?: (m: string) => Promise<void> })
      .restoreFromMnemonic,
  );

  const [phrase, setPhrase] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCovered, setIsCovered] = useState(false);

  // Ref-backed in-flight guard so rapid synchronous taps — which all
  // land before React has flushed the `setIsSubmitting(true)` state
  // update — still collapse to a single `restoreFromMnemonic()` call.
  const inFlightRef = useRef(false);
  // Ref-backed one-shot so a rapid double-tap on the CTA after a
  // success cannot invoke `onRestored` twice.
  const restoredRef = useRef(false);

  const normalized = useMemo(() => normalizeMnemonicInput(phrase), [phrase]);
  const wordCount = useMemo(
    () => (normalized.length === 0 ? 0 : normalized.split(' ').length),
    [normalized],
  );
  const isShapeValid = ACCEPTED_WORD_COUNTS.has(wordCount);

  // ---------------------------------------------------------------
  // Android FLAG_SECURE lifecycle (VAL-UX-043).
  // ---------------------------------------------------------------
  useEffect(() => {
    enableFlagSecure();
    return () => {
      disableFlagSecure();
    };
  }, []);

  // ---------------------------------------------------------------
  // iOS privacy cover (VAL-UX-044). Only attach the listener on iOS
  // so Android — already protected by FLAG_SECURE — doesn't render a
  // redundant cover view.
  // ---------------------------------------------------------------
  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    const handle = (state: AppStateStatus) => {
      setIsCovered(state === 'inactive' || state === 'background');
    };
    const subscription = AppState.addEventListener('change', handle);
    return () => {
      subscription.remove();
    };
  }, []);

  // ---------------------------------------------------------------
  // Disable back-navigation gestures so a mid-restore swipe cannot
  // drop the user back onto the invalidated unlock screen.
  // ---------------------------------------------------------------
  useEffect(() => {
    navigation?.setOptions?.({
      gestureEnabled: false,
      headerBackVisible: false,
      headerLeft: () => null,
    });
  }, [navigation]);

  const handleSubmit = useCallback(async () => {
    if (inFlightRef.current) return;

    // Shape validation gates the CTA but we defensively re-check here
    // so programmatic presses can't bypass it.
    if (!isShapeValid) return;

    // BIP-39 checksum + wordlist validation. Runs entirely in-process
    // before we touch the agent store so an invalid phrase NEVER
    // reaches the native seal path (VAL-UX-025).
    if (!validateMnemonic(normalized, englishWordlist)) {
      setErrorMessage(INVALID_MNEMONIC_MESSAGE);
      return;
    }

    if (typeof restoreFromMnemonic !== 'function') {
      // Defensive fallback — the agent-store must expose the restore
      // action by the time this screen is reachable in production. A
      // missing action is treated as an inline error rather than a
      // hard crash so the user can at least retry.
      setErrorMessage(
        'Restore is not available right now. Close the app and try again.',
      );
      return;
    }

    inFlightRef.current = true;
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await restoreFromMnemonic(normalized);
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Something went wrong while restoring. Please try again.';
      setErrorMessage(message);
      inFlightRef.current = false;
      setIsSubmitting(false);
      return;
    }

    try {
      // On success commit the restored session snapshot through the
      // session-store's dedicated helper. `hydrateRestored()`:
      //   1. Atomically sets biometricStatus='ready',
      //      hasCompletedOnboarding=true, hasIdentity=true, and
      //      isLocked=false in one `setState` call so subsequent
      //      navigator selectors observe a consistent snapshot.
      //   2. Awaits the SecureStorage write for the onboarding /
      //      identity half via the store's internal
      //      `persistSessionOrThrow()` pipe. We MUST `await` this
      //      call before handing control back to the navigator — a
      //      cold kill in the gap between setState and the
      //      SecureStorage commit would otherwise rehydrate stale
      //      flags and misroute the restored wallet back to
      //      Welcome / BiometricSetup (VAL-UX-024).
      //
      // If `hydrateRestored()` REJECTS (SecureStorage write failed),
      // we MUST NOT call `onRestored()`; instead render an inline
      // retry alert so the user can resubmit. Navigating on a silent
      // persistence failure would land the user on Main with an
      // in-memory session that a cold relaunch would discard.
      await useSessionStore.getState().hydrateRestored();

      if (!restoredRef.current) {
        restoredRef.current = true;
        onRestored();
      }
    } catch {
      setErrorMessage(SESSION_PERSIST_FAILURE_MESSAGE);
    } finally {
      inFlightRef.current = false;
      setIsSubmitting(false);
    }
  }, [isShapeValid, normalized, onRestored, restoreFromMnemonic]);

  const handleChange = useCallback((next: string) => {
    setPhrase(next);
    // Clear any prior inline error so the alert doesn't linger while
    // the user is editing. The button stays disabled until the input
    // re-validates so we don't need to distinguish "edited after
    // error" from "edited from scratch".
    setErrorMessage(null);
  }, []);

  return (
    <Screen contentContainerStyle={styles.content}>
      <View style={styles.hero} testID="recovery-restore-screen">
        <Text
          accessibilityRole="header"
          style={[styles.title, { color: theme.colors.text }]}
        >
          Restore your wallet
        </Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>
          Enter the 12- or 24-word recovery phrase you saved when you
          first set up Enbox. We&apos;ll re-seal your wallet under this
          device&apos;s biometrics and bring you back to your wallet.
        </Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>
          Separate each word with a space. Words are lower-case and your
          phrase will never be sent off the device.
        </Text>
      </View>

      <TextInput
        accessibilityLabel={INPUT_LABEL}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!isSubmitting}
        keyboardType="default"
        multiline
        onChangeText={handleChange}
        placeholder="word word word..."
        placeholderTextColor={theme.colors.textMuted}
        secureTextEntry={false}
        spellCheck={false}
        style={[
          styles.input,
          {
            color: theme.colors.text,
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
          },
        ]}
        testID="recovery-restore-phrase-input"
        textContentType="none"
        value={phrase}
      />

      <Text
        accessibilityLabel="Recovery phrase word count"
        style={[styles.counter, { color: theme.colors.textMuted }]}
      >
        {wordCount} {wordCount === 1 ? 'word' : 'words'}
      </Text>

      {errorMessage && (
        <Text
          accessibilityRole="alert"
          style={[styles.error, { color: theme.colors.textMuted }]}
          testID="recovery-restore-error"
        >
          {errorMessage}
        </Text>
      )}

      <AppButton
        accessibilityLabel={CTA_LABEL}
        disabled={!isShapeValid}
        label={CTA_LABEL}
        loading={isSubmitting}
        onPress={handleSubmit}
      />

      {isCovered && (
        <View
          accessibilityLabel="App switcher privacy cover"
          pointerEvents="none"
          style={[
            styles.privacyCover,
            { backgroundColor: theme.colors.background },
          ]}
          testID="recovery-restore-privacy-cover"
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { justifyContent: 'flex-start' },
  hero: { gap: 12, marginBottom: 16 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '800' },
  body: { fontSize: 16, lineHeight: 24 },
  input: {
    minHeight: 140,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    lineHeight: 22,
  },
  counter: {
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'right',
  },
  error: { fontSize: 14, lineHeight: 20 },
  privacyCover: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 1,
  },
});
