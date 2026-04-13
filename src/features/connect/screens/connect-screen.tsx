import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { useAppTheme } from '@/theme';

export function ConnectScreen() {
  const theme = useAppTheme();

  return (
    <Screen>
      <ScreenHeader
        title="Connect"
        subtitle="Scan a QR code or tap an NFC tag to connect with apps and services."
      />

      <View style={[styles.scanArea, { backgroundColor: theme.colors.surfaceMuted, borderColor: theme.colors.border }]}>
        <Text style={[styles.scanIcon, { color: theme.colors.textMuted }]}>
          {/* Camera view placeholder */}
          [ ]
        </Text>
        <Text style={[styles.scanText, { color: theme.colors.textMuted }]}>
          Camera access is required to scan QR codes.
        </Text>
        <AppButton label="Open scanner" disabled variant="secondary" onPress={() => {}} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scanArea: {
    borderRadius: 24,
    borderWidth: 1,
    padding: 32,
    gap: 16,
    alignItems: 'center',
    minHeight: 240,
    justifyContent: 'center',
  },
  scanIcon: { fontSize: 48 },
  scanText: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
});
