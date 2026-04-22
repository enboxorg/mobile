import { useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import { useSessionStore } from '@/features/session/session-store';
import { useAgentStore } from '@/lib/enbox/agent-store';
import { useAppTheme } from '@/theme';

/**
 * Canonical error-code matrix for the native biometric vault. The raw
 * codes (USER_CANCELED, BIOMETRY_NOT_ENROLLED, BIOMETRY_LOCKOUT,
 * BIOMETRY_LOCKOUT_PERMANENT, etc.) flow straight through when a test or
 * native call throws with `.code`; the `VAULT_ERROR_*` aliases cover the
 * JS-layer mapping performed by `BiometricVault.mapNativeErrorToVaultError`
 * so this screen works both with a directly-mocked
 * `initializeFirstLaunch` (unit tests) and with the real store that
 * re-throws the mapped `VaultError`.
 */
const USER_CANCELED_CODES = new Set([
  'USER_CANCELED',
  'VAULT_ERROR_USER_CANCELED',
]);
const NOT_ENROLLED_CODES = new Set([
  'BIOMETRY_NOT_ENROLLED',
  'BIOMETRICS_NOT_ENROLLED',
  'BIOMETRY_UNAVAILABLE',
  'BIOMETRICS_UNAVAILABLE',
  'VAULT_ERROR_BIOMETRICS_UNAVAILABLE',
]);
const LOCKOUT_CODES = new Set([
  'BIOMETRY_LOCKOUT',
  'BIOMETRY_LOCKOUT_PERMANENT',
]);

type SetupError =
  | { kind: 'cancelled' }
  | { kind: 'lockout' }
  | { kind: 'generic'; message: string };

export interface BiometricSetupScreenProps {
  /**
   * Fired exactly once with the recovery phrase returned by
   * `agent-store.initializeFirstLaunch()` after the biometric vault has
   * been sealed. Consumers route to RecoveryPhrase from here.
   */
  onInitialized: (recoveryPhrase: string) => void;
}

/**
 * First-launch biometric setup screen.
 *
 * Flow:
 *   1. User taps "Enable biometric unlock".
 *   2. We invoke `useAgentStore.initializeFirstLaunch()`. The underlying
 *      BiometricVault prompts the OS for biometrics and seals a fresh
 *      root secret behind Keychain / Keystore.
 *   3. On success, we hand the returned mnemonic back via `onInitialized`
 *      so the caller can route forward to RecoveryPhrase.
 *   4. On USER_CANCELED we stay mounted with an inline retry affordance.
 *   5. On BIOMETRY_NOT_ENROLLED we flip `session.biometricStatus` to
 *      `'not-enrolled'`; the navigator matrix (see
 *      `features/session/get-initial-route.ts`) then routes us to the
 *      BiometricUnavailable hard gate.
 *   6. On BIOMETRY_LOCKOUT / LOCKOUT_PERMANENT we surface a clear lockout
 *      message WITHOUT offering a PIN / passcode / skip fallback.
 */
export function BiometricSetupScreen({
  onInitialized,
}: BiometricSetupScreenProps) {
  const theme = useAppTheme();
  const initializeFirstLaunch = useAgentStore(
    (s) => s.initializeFirstLaunch,
  );
  const setBiometricStatus = useSessionStore((s) => s.setBiometricStatus);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorState, setErrorState] = useState<SetupError | null>(null);
  // Ref-backed in-flight guard so rapid synchronous taps — which all
  // occur before React has flushed the `setIsSubmitting(true)` state
  // update — still collapse to a single `initializeFirstLaunch()` call.
  const inFlightRef = useRef(false);

  const handlePress = useCallback(async () => {
    // Rapid-tap debounce: while a setup attempt is in-flight we must NOT
    // re-enter the initializer (that would re-trigger the biometric
    // prompt twice and potentially orphan the freshly-sealed secret).
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    setIsSubmitting(true);
    setErrorState(null);
    try {
      const recoveryPhrase = await initializeFirstLaunch();
      onInitialized(recoveryPhrase);
    } catch (err) {
      const rawCode = (err as { code?: unknown } | null)?.code;
      const code = typeof rawCode === 'string' ? rawCode : '';

      if (USER_CANCELED_CODES.has(code)) {
        setErrorState({ kind: 'cancelled' });
      } else if (NOT_ENROLLED_CODES.has(code)) {
        // Update the session store — the navigator matrix will pick up
        // the transition and hard-gate to BiometricUnavailable. We also
        // clear any prior inline error so we don't render a stale alert
        // for the split-second before the navigator unmounts us.
        setErrorState(null);
        setBiometricStatus('not-enrolled');
      } else if (LOCKOUT_CODES.has(code)) {
        setErrorState({ kind: 'lockout' });
      } else {
        const message =
          err instanceof Error && err.message
            ? err.message
            : 'Biometric setup failed. Please try again.';
        setErrorState({ kind: 'generic', message });
      }
    } finally {
      inFlightRef.current = false;
      setIsSubmitting(false);
    }
  }, [initializeFirstLaunch, onInitialized, setBiometricStatus]);

  return (
    <Screen contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text
          accessibilityRole="header"
          style={[styles.title, { color: theme.colors.text }]}
        >
          Set up biometric unlock
        </Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>
          Enbox uses your device&apos;s biometrics — Face ID, Touch ID, or
          fingerprint — to guard your new wallet. Only you can unlock.
        </Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>
          Tap the button below to authenticate once and seal a new
          biometric-protected key for this wallet.
        </Text>
      </View>

      {errorState?.kind === 'cancelled' && (
        <Text
          accessibilityRole="alert"
          style={[styles.error, { color: theme.colors.textMuted }]}
        >
          Biometric setup was cancelled. Try again when you&apos;re ready.
        </Text>
      )}
      {errorState?.kind === 'lockout' && (
        <Text
          accessibilityRole="alert"
          style={[styles.error, { color: theme.colors.textMuted }]}
        >
          Your device has temporarily locked biometrics after too many
          failed attempts. Unlock your device, then try again.
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
        accessibilityLabel="Enable biometric unlock"
        label="Enable biometric unlock"
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
