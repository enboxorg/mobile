import { Linking, StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import { useAppTheme } from '@/theme';

/**
 * Hard gate shown when the device either lacks biometric hardware or has no
 * biometrics enrolled. The user cannot proceed past this screen until they
 * enroll a biometric in the system Settings app — biometric unlock is the
 * only authentication factor this app supports (no legacy knowledge-factor
 * fallback).
 */
export function BiometricUnavailableScreen() {
  const theme = useAppTheme();

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
