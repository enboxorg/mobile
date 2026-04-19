import { useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';

import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { useWalletConnectStore } from '@/lib/enbox/wallet-connect-store';
import { useAppTheme } from '@/theme';

export function ConnectScreen() {
  const navigation = useNavigation<any>();
  const theme = useAppTheme();
  const walletConnectError = useWalletConnectStore((s) => s.error);
  const handleIncomingUrl = useWalletConnectStore((s) => s.handleIncomingUrl);
  const clearWalletConnect = useWalletConnectStore((s) => s.clear);
  const [manualUrl, setManualUrl] = useState('');

  async function handlePasteLink() {
    if (!manualUrl.trim()) return;
    try {
      await handleIncomingUrl(manualUrl.trim());
      setManualUrl('');
    } catch {
      // store drives error UI
    }
  }

  return (
    <Screen>
      <ScreenHeader
        title="Connect"
        subtitle="Approve app access with a deep link or QR code."
      />

      <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}> 
        <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Scan QR code</Text>
        <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}> 
          Use your camera to scan an `enbox://connect` QR code from a desktop or another device.
        </Text>
        <AppButton label="Open scanner" onPress={() => navigation.navigate('WalletConnectScanner')} />
      </View>

      <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}> 
        <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Paste connect link</Text>
        <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}> 
          For testing or same-device flows, paste a full `enbox://connect?...` link.
        </Text>
        <TextInput
          accessibilityLabel="Connect link"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          numberOfLines={3}
          onChangeText={setManualUrl}
          placeholder="enbox://connect?request_uri=...&encryption_key=..."
          placeholderTextColor={theme.colors.textMuted}
          style={[styles.input, { backgroundColor: theme.colors.surfaceMuted, borderColor: theme.colors.border, color: theme.colors.text }]}
          value={manualUrl}
        />
        <AppButton label="Process link" disabled={!manualUrl.trim()} onPress={handlePasteLink} />
      </View>

      <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}> 
        <Text style={[styles.cardTitle, { color: theme.colors.text }]}>How it works</Text>
        <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}> 
          1. A requesting app generates an Enbox connect URI.
        </Text>
        <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}> 
          2. This wallet receives it by deep link or QR scan.
        </Text>
        <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}> 
          3. You review permissions, choose an identity, and approve.
        </Text>
        <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}> 
          4. The wallet returns a delegated session and a PIN for the app to confirm.
        </Text>
      </View>

      {walletConnectError ? (
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}> 
          <Text style={[styles.cardTitle, { color: theme.colors.warning }]}>Connection failed</Text>
          <Text accessibilityRole="alert" style={[styles.cardBody, { color: theme.colors.textMuted }]}>{walletConnectError}</Text>
          <AppButton label="Clear error" variant="secondary" onPress={clearWalletConnect} />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 24, borderWidth: 1, padding: 20, gap: 12 },
  cardTitle: { fontSize: 18, fontWeight: '700' },
  cardBody: { fontSize: 15, lineHeight: 22 },
  input: { borderRadius: 14, borderWidth: 1, fontSize: 14, paddingHorizontal: 14, paddingVertical: 12, minHeight: 88, textAlignVertical: 'top' },
});
