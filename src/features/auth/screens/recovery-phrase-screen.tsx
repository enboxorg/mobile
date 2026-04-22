import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  type AppStateStatus,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import {
  disableFlagSecure,
  enableFlagSecure,
} from '@/lib/native/flag-secure';
import { useAppTheme } from '@/theme';

/**
 * Confirmation CTA label. Must match VAL-UX-020 / VAL-UX-039 anchor:
 * the literal string `I've saved it` (with a curly apostrophe `\u2019`).
 * The same string is used as the accessibilityLabel so screen readers
 * and the CI UI driver both locate the control by the identical anchor.
 */
const CONFIRM_LABEL = 'I\u2019ve saved it';

export interface RecoveryPhraseScreenProps {
  /**
   * The BIP-39 mnemonic to display. Per VAL-VAULT-026 the wallet always
   * produces a 24-word phrase, but the screen itself stays length-agnostic
   * (anything from 12 to 24 words) so the restore-path screen can reuse
   * it safely in the future. The caller passes the phrase as a single
   * string; the screen splits on whitespace.
   *
   * The mnemonic MUST NEVER be persisted to storage. The screen does not
   * mirror the prop into any store, file, or clipboard — see VAL-UX-021.
   */
  mnemonic: string;
  /**
   * Invoked exactly once when the user confirms they have backed up the
   * phrase ("I've saved it"). The caller typically routes to `Main`.
   */
  onConfirm: () => void;
  /**
   * Optional React Navigation prop. When provided, the screen installs
   * `gestureEnabled: false` and `headerBackVisible: false` so the user
   * cannot swipe/press-back to re-expose the mnemonic after confirming
   * (VAL-UX-045). If absent (e.g. in isolated unit tests) the screen
   * still behaves correctly — back-navigation is governed by the host
   * navigator's stack configuration.
   */
  navigation?: {
    setOptions?: (options: Record<string, unknown>) => void;
  };
}

/**
 * RecoveryPhraseScreen — shown once after first-launch biometric setup
 * to display the wallet's BIP-39 mnemonic so the user can write it down.
 *
 * Key responsibilities (validation-contract assertions in parens):
 *   1. Render every word exactly once, preserving order (VAL-UX-020).
 *   2. Expose an "I've saved it" confirm button with matching a11y
 *      label; pressing it fires `onConfirm` exactly once and routes the
 *      caller to Main (VAL-UX-020, VAL-UX-039).
 *   3. Enable Android FLAG_SECURE on mount; clear on unmount
 *      (VAL-UX-043) — blocks screenshots + Recents thumbnail exposure.
 *   4. On iOS, when `AppState` transitions to `inactive` / `background`
 *      render an opaque cover view so the mnemonic is not captured in
 *      the app-switcher snapshot (VAL-UX-044).
 *   5. Disable back-navigation via React Navigation options so the
 *      phrase can't be re-exposed after confirmation (VAL-UX-045).
 *   6. Never write the mnemonic (or any of its words) to any storage;
 *      does not expose a Copy affordance by default so the clipboard
 *      TTL branch of VAL-UX-022 / VAL-UX-046 is vacuously satisfied.
 */
export function RecoveryPhraseScreen({
  mnemonic,
  onConfirm,
  navigation,
}: RecoveryPhraseScreenProps) {
  const theme = useAppTheme();

  // Ref-guarded one-shot so double-taps (VAL-UX-047 style) on the
  // confirm button collapse to a single `onConfirm()` invocation. The
  // ref is deliberately used in place of state because multiple
  // synchronous presses land before React flushes a state update.
  const confirmedRef = useRef(false);

  // Tracks whether the app is currently in a foregrounded state. On
  // iOS, when this flips to `false` we render the opaque cover view so
  // the mnemonic cannot be captured in the app-switcher snapshot. We
  // intentionally default to `false` (cover hidden) because the screen
  // only mounts while the app is active.
  const [isCovered, setIsCovered] = useState(false);

  // Words rendered positionally. Memoized so re-renders don't re-split
  // the string. We do NOT store the split array in any persistent
  // location — it lives only in the React render tree until unmount.
  const words = useMemo(
    () => mnemonic.trim().split(/\s+/).filter(Boolean),
    [mnemonic],
  );

  // ---------------------------------------------------------------
  // Android FLAG_SECURE lifecycle (VAL-UX-043)
  //
  // We always call the platform-gated wrapper; the wrapper itself
  // no-ops on non-Android platforms so this hook stays linear.
  // ---------------------------------------------------------------
  useEffect(() => {
    enableFlagSecure();
    return () => {
      disableFlagSecure();
    };
  }, []);

  // ---------------------------------------------------------------
  // iOS app-switcher obscuring (VAL-UX-044)
  //
  // Only attach the listener on iOS so Android (already protected by
  // FLAG_SECURE) doesn't render a redundant cover view. The listener
  // is removed on unmount to avoid leaking into other screens.
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
  // Disable back-navigation (VAL-UX-045)
  //
  // React Navigation options must be configured so the stack-level
  // gesture and header-back chrome cannot re-expose the mnemonic.
  // ---------------------------------------------------------------
  useEffect(() => {
    navigation?.setOptions?.({
      gestureEnabled: false,
      headerBackVisible: false,
      // Fallback for platforms where `headerBackVisible` isn't honored
      // (older RN-navigation versions). Rendering null removes the
      // header chevron entirely.
      headerLeft: () => null,
    });
  }, [navigation]);

  const handleConfirm = useCallback(() => {
    if (confirmedRef.current) return;
    confirmedRef.current = true;
    onConfirm();
  }, [onConfirm]);

  return (
    <Screen contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text
          accessibilityRole="header"
          style={[styles.title, { color: theme.colors.text }]}
        >
          Back up your recovery phrase
        </Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>
          Write these {words.length} words down in order and keep them
          somewhere only you can reach. This phrase is the only way to
          restore your wallet if you lose access to biometrics on this
          device.
        </Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>
          Never share it. Never store it in a password manager, cloud
          backup, photo, or screenshot.
        </Text>
      </View>

      <View
        accessibilityLabel="Recovery phrase"
        style={[
          styles.wordGrid,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
          },
        ]}
        testID="recovery-phrase-word-grid"
      >
        {words.map((word, index) => (
          <View
            key={`${index}-${word}`}
            style={[styles.wordCell, { borderColor: theme.colors.border }]}
            testID={`recovery-phrase-word-${index + 1}`}
          >
            <Text
              style={[
                styles.wordIndex,
                { color: theme.colors.textMuted },
              ]}
            >
              {index + 1}.
            </Text>
            <Text style={[styles.wordText, { color: theme.colors.text }]}>
              {word}
            </Text>
          </View>
        ))}
      </View>

      <AppButton
        accessibilityLabel={CONFIRM_LABEL}
        label={CONFIRM_LABEL}
        onPress={handleConfirm}
      />

      {isCovered && (
        <View
          accessibilityLabel="App switcher privacy cover"
          pointerEvents="none"
          style={[
            styles.privacyCover,
            { backgroundColor: theme.colors.background },
          ]}
          testID="recovery-phrase-privacy-cover"
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
  wordGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    gap: 8,
    marginBottom: 16,
  },
  wordCell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 12,
    minWidth: '30%',
  },
  wordIndex: { fontSize: 13, fontWeight: '600', minWidth: 22 },
  wordText: { fontSize: 15, fontWeight: '600' },
  privacyCover: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 1,
  },
});
