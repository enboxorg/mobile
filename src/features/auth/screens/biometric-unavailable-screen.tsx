import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus, Linking, StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import { useSessionStore } from '@/features/session/session-store';
import { useAppTheme } from '@/theme';

/**
 * Hard gate shown when the device either lacks biometric hardware or has no
 * biometrics enrolled. The user cannot proceed past this screen until they
 * enroll a biometric in the system Settings app — biometric unlock is the
 * only authentication factor this app supports (no legacy knowledge-factor
 * fallback).
 *
 * Round-13 F3: re-run `useSessionStore.hydrate()` whenever the app
 * returns to the foreground from background / inactive. Pre-fix
 * biometric availability was only probed once on App.tsx mount, so a
 * user who enrolled a fingerprint in the system Settings app and
 * tapped back into Enbox stayed stuck on this screen until they
 * cold-started the process. The re-hydrate re-evaluates the
 * `BiometricStatus` against the now-current OS probe, and the
 * navigator transparently advances to the next gate
 * (`BiometricSetup` / `BiometricUnlock`) once `availability.enrolled`
 * flips to `true`. `hydrate` preserves `isLocked` (it never writes
 * that field) so it cannot regress an in-flight unlock.
 */
export function BiometricUnavailableScreen() {
  const theme = useAppTheme();
  const hydrate = useSessionStore((s) => s.hydrate);

  // Track the previous AppState so we only re-hydrate on a
  // `background|inactive → active` edge — mirrors the pattern in
  // `useAutoLock` so a `change` event delivered during the initial
  // mount (when the app is already `'active'`) doesn't fire an
  // immediate, redundant probe.
  const lastAppState = useRef<AppStateStatus>('active');

  useEffect(() => {
    function handleAppStateChange(next: AppStateStatus): void {
      const prev = lastAppState.current;
      lastAppState.current = next;
      // Only re-probe on a real foreground edge — `active → active` /
      // `background → inactive` etc. are no-ops.
      if (next !== 'active') return;
      if (prev !== 'background' && prev !== 'inactive') return;
      // Fire-and-forget: any failure is non-fatal here and the
      // navigator already handles `unknown` / `unavailable` /
      // `not-enrolled` gracefully. The next foreground edge will
      // simply retry on its own.
      hydrate().catch(() => undefined);
    }
    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [hydrate]);

  const handleOpenSettings = () => {
    // Fire-and-forget; we intentionally ignore the returned promise here
    // because the screen has nothing to do while the system Settings app
    // opens. Any rejection is surfaced by the OS, not the app. `void` is
    // the idiomatic way to mark a deliberately-unawaited promise.
    // eslint-disable-next-line no-void
    void Linking.openSettings();
  };

  return (
    <Screen contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text
          accessibilityRole="header"
          style={[styles.title, { color: theme.colors.text }]}
        >
          Biometrics required
        </Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>
          Enbox protects your wallet with your device&apos;s biometric unlock.
          Your device either has no biometric hardware or no biometrics are
          enrolled yet. Open Settings to enroll a fingerprint or face, then
          return to Enbox to continue.
        </Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>
          Once you have set up biometrics in your device settings, reopen the
          app to finish setting up your wallet.
        </Text>
      </View>

      <AppButton
        accessibilityLabel="Open Settings"
        label="Open Settings"
        onPress={handleOpenSettings}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { justifyContent: 'center' },
  hero: { gap: 12, marginBottom: 8 },
  title: { fontSize: 30, lineHeight: 36, fontWeight: '800' },
  body: { fontSize: 16, lineHeight: 24 },
});
