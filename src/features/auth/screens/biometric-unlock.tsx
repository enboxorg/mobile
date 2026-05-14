import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import NativeBiometricVault from '@specs/NativeBiometricVault';
import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import { useSessionStore } from '@/features/session/session-store';
import { useAgentStore } from '@/lib/enbox/agent-store';
import { useAppTheme } from '@/theme';

/**
 * Maximum number of consecutive non-cancel / non-lockout failures we
 * tolerate before escalating the inline error to the lockout copy. The
 * biometric-first contract (VAL-UX-018) forbids any legacy
 * knowledge-factor fallback, so this threshold is strictly an inline UX
 * hint — there is no state machine consequence beyond the message
 * change; the user can still tap the CTA to re-prompt.
 */
export const MAX_FAILED_ATTEMPTS_BEFORE_LOCKOUT = 5;

/**
 * Canonical error-code matrix surfaced by either the raw native
 * `NativeBiometricVault` (which throws with `.code === 'USER_CANCELED' |
 * 'KEY_INVALIDATED' | 'BIOMETRY_LOCKOUT' | …`) OR the JS-layer
 * `BiometricVault.mapNativeErrorToVaultError` (which re-throws with the
 * `VAULT_ERROR_*` aliases). Accepting both matrices keeps this screen
 * testable with a directly-mocked `unlockAgent` (see
 * `__tests__/biometric-unlock.test.tsx`) AND with the real store that
 * re-throws the mapped `VaultError`.
 */
const USER_CANCELED_CODES = new Set<string>([
  'USER_CANCELED',
  'VAULT_ERROR_USER_CANCELED',
]);
const LOCKOUT_CODES = new Set<string>([
  'VAULT_ERROR_BIOMETRY_LOCKOUT',
  // Defensive fallbacks for non-mapped paths (e.g. a test or native
  // layer that throws with the raw code without going through
  // `BiometricVault.mapNativeErrorToVaultError`).
  'BIOMETRY_LOCKOUT',
  'BIOMETRY_LOCKOUT_PERMANENT',
]);
const INVALIDATED_CODES = new Set<string>([
  'KEY_INVALIDATED',
  'KEY_PERMANENTLY_INVALIDATED',
  'BIOMETRY_INVALIDATED',
  'VAULT_ERROR_KEY_INVALIDATED',
]);

type UnlockError =
  | { kind: 'cancelled' }
  | { kind: 'lockout' }
  | { kind: 'generic'; message: string };

export interface BiometricUnlockScreenProps {
  /**
   * Called exactly once after a successful biometric unlock (the vault
   * has re-opened and the agent is live). The navigator typically maps
   * this to `useSessionStore.unlockSession()` + a replace to `Main`.
   */
  onUnlock: () => void;
  /**
   * When `true` (default), the screen fires the biometric prompt once
   * on initial mount. Callers that prefer the user to tap the CTA
   * explicitly can pass `autoPrompt={false}` (used in tests and in the
   * post-cancel retry flow where we don't want to auto-re-prompt).
   */
  autoPrompt?: boolean;
  /**
   * Optional direct navigation hook. When provided and the vault
   * rejects with a key-invalidated code, this is invoked (typically
   * backed by `navigation.replace('RecoveryRestore')`). When absent the
   * screen falls back to flipping `session.biometricStatus` to
   * `'invalidated'` — the navigator matrix then routes to
   * RecoveryRestore on the next render (VAL-UX-028).
   */
  onInvalidated?: () => void;
}

/**
 * Resolve the CTA label for the active biometric type.
 *
 * The label MUST always start with the exact prefix `Unlock with ` so
 * the CI UI driver anchor (`VAL-UX-039`) and the accessibility anchor
 * (`VAL-UX-038`) both hold. Platform / type mapping:
 *
 * - iOS `faceID`   → `Unlock with Face ID`
 * - iOS `touchID`  → `Unlock with Touch ID`
 * - Android `face` → `Unlock with Face Unlock`
 * - Android `fingerprint` (default Android) → `Unlock with fingerprint`
 * - Any other / unknown type on either platform → `Unlock with biometrics`
 */
function deriveUnlockLabel(type?: string | null): string {
  if (Platform.OS === 'ios') {
    if (type === 'faceID') return 'Unlock with Face ID';
    if (type === 'touchID') return 'Unlock with Touch ID';
    return 'Unlock with biometrics';
  }
  // Android (and anything else — RN on web / tvOS just lands here too).
  if (type === 'face') return 'Unlock with Face Unlock';
  if (type === 'fingerprint' || type == null || type === 'none') {
    return 'Unlock with fingerprint';
  }
  return 'Unlock with biometrics';
}

/**
 * Biometric unlock screen.
 *
 * Flow:
 *   1. On mount the screen probes `NativeBiometricVault.isBiometricAvailable()`
 *      to refine the CTA label for the active biometric type. The
 *      starting label is already `"Unlock with …"` so the VAL-UX-015
 *      anchor holds even before the probe resolves.
 *   2. If `autoPrompt !== false` (default true) the screen fires the
 *      biometric prompt via `useAgentStore.unlockAgent()` exactly once.
 *   3. On success we invoke `onUnlock` once and reset the failed-attempt
 *      counter.
 *   4. On `USER_CANCELED` we stay mounted with an inline retry alert and
 *      leave the CTA pressable — no navigation, no dialog, no fallback.
 *   5. On `BIOMETRY_LOCKOUT(_PERMANENT)` (or after N consecutive
 *      AUTH_FAILED / generic errors) we render a clear lockout message
 *      referencing device biometrics. We NEVER offer a legacy
 *      knowledge-factor / skip affordance.
 *   6. On `KEY_INVALIDATED` we either call `onInvalidated` (when the
 *      caller wired the navigator to `.replace('RecoveryRestore')`) or
 *      flip `session.biometricStatus` to `'invalidated'` so the
 *      navigator matrix routes us to RecoveryRestore on the next
 *      render.
 */
export function BiometricUnlockScreen({
  onUnlock,
  autoPrompt = true,
  onInvalidated,
}: BiometricUnlockScreenProps) {
  const theme = useAppTheme();
  const unlockAgent = useAgentStore((s) => s.unlockAgent);
  const setBiometricStatus = useSessionStore((s) => s.setBiometricStatus);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorState, setErrorState] = useState<UnlockError | null>(null);
  const [label, setLabel] = useState(() => deriveUnlockLabel(null));
  // Ref-backed in-flight guard so rapid synchronous taps — which all
  // occur before React has flushed the `setIsSubmitting(true)` state —
  // still collapse to a single `unlockAgent()` call.
  const inFlightRef = useRef(false);
  // Tracks consecutive non-cancel / non-lockout failures so we can
  // escalate the UX copy to the lockout message after
  // MAX_FAILED_ATTEMPTS_BEFORE_LOCKOUT attempts. Ref-backed because we
  // synchronously read+compare the running count inside the async
  // handler before the paired `setState` has been flushed.
  const failedAttemptsRef = useRef(0);
  // One-shot latch so autoPrompt doesn't re-fire across re-renders.
  const autoPromptFiredRef = useRef(false);

  // Probe the native biometric type so we can refine the CTA label.
  // The starting label is already "Unlock with …" so VAL-UX-015 passes
  // immediately; the probe just upgrades "biometrics" → the specific
  // modality when available.
  useEffect(() => {
    let cancelled = false;
    NativeBiometricVault.isBiometricAvailable()
      .then((result) => {
        if (cancelled) return;
        if (result && typeof result.type === 'string') {
          setLabel(deriveUnlockLabel(result.type));
        }
      })
      .catch(() => {
        // Probe failures are non-fatal — we keep the starting label.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePress = useCallback(async () => {
    // Rapid-tap debounce: while an unlock attempt is in-flight we must
    // NOT re-enter — the biometric prompt is already visible and a
    // second `unlockAgent()` would race with it.
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    setIsSubmitting(true);
    setErrorState(null);
    try {
      await unlockAgent();
      // Reset transient failure counter and let the caller route away.
      failedAttemptsRef.current = 0;
      onUnlock();
    } catch (err) {
      const rawCode = (err as { code?: unknown } | null)?.code;
      const code = typeof rawCode === 'string' ? rawCode : '';

      if (USER_CANCELED_CODES.has(code)) {
        setErrorState({ kind: 'cancelled' });
      } else if (INVALIDATED_CODES.has(code)) {
        // Clear any inline alert so we don't render a stale error for
        // the split-second before the navigator unmounts us.
        setErrorState(null);
        if (onInvalidated) {
          onInvalidated();
        } else {
          setBiometricStatus('invalidated');
        }
      } else if (LOCKOUT_CODES.has(code)) {
        setErrorState({ kind: 'lockout' });
      } else {
        // Generic AUTH_FAILED / unknown — escalate to lockout copy once
        // we've observed the threshold so the user isn't left staring
        // at an infinite retry loop (VAL-UX-018). The CTA remains
        // pressable; this is purely a UX copy change.
        const nextFailed = failedAttemptsRef.current + 1;
        failedAttemptsRef.current = nextFailed;
        if (nextFailed >= MAX_FAILED_ATTEMPTS_BEFORE_LOCKOUT) {
          setErrorState({ kind: 'lockout' });
        } else {
          const message =
            err instanceof Error && err.message
              ? err.message
              : 'Unlock failed. Please try again.';
          setErrorState({ kind: 'generic', message });
        }
      }
    } finally {
      inFlightRef.current = false;
      setIsSubmitting(false);
    }
  }, [unlockAgent, onUnlock, onInvalidated, setBiometricStatus]);

  // Auto-prompt once on mount when enabled. We fire-and-forget; the
  // result path inside `handlePress` handles all outcomes.
  useEffect(() => {
    if (!autoPrompt) return;
    if (autoPromptFiredRef.current) return;
    autoPromptFiredRef.current = true;
    // `void` marks a deliberately-unawaited fire-and-forget promise.
    // eslint-disable-next-line no-void
    void handlePress();
  }, [autoPrompt, handlePress]);

  return (
    <Screen contentContainerStyle={styles.content}>
      <View style={styles.hero} testID="biometric-unlock-screen">
        <Text
          accessibilityRole="header"
          style={[styles.title, { color: theme.colors.text }]}
        >
          Unlock Enbox
        </Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>
          Use your device biometrics to unlock your wallet.
        </Text>
      </View>

      {errorState?.kind === 'cancelled' && (
        <Text
          accessibilityRole="alert"
          style={[styles.error, { color: theme.colors.textMuted }]}
        >
          Biometric unlock was cancelled. Tap the button below to try
          again when you&apos;re ready.
        </Text>
      )}
      {errorState?.kind === 'lockout' && (
        <Text
          accessibilityRole="alert"
          style={[styles.error, { color: theme.colors.textMuted }]}
        >
          Biometrics are temporarily locked out on this device after too
          many failed attempts. Unlock your device, then try again.
        </Text>
      )}
      {errorState?.kind === 'generic' && (
        <Text
          accessibilityRole="alert"
          style={[styles.error, { color: theme.colors.textMuted }]}
        >
          {errorState.message}
        </Text>
      )}

      <AppButton
        accessibilityLabel={label}
        label={label}
        loading={isSubmitting}
        onPress={handlePress}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { justifyContent: 'center' },
  hero: { gap: 12, marginBottom: 8 },
  title: { fontSize: 30, lineHeight: 36, fontWeight: '800' },
  body: { fontSize: 16, lineHeight: 24 },
  error: { fontSize: 14, lineHeight: 20 },
});
