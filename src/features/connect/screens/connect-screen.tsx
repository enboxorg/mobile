import { useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { useAgentStore } from '@/lib/enbox/agent-store';
import { mobileConnect } from '@/lib/enbox/connect';
import { useAppTheme } from '@/theme';

type ConnectState =
  | { step: 'idle' }
  | { step: 'waiting'; walletUri: string }
  | { step: 'pin' }
  | { step: 'connecting' }
  | { step: 'connected' }
  | { step: 'error'; message: string };

const DEFAULT_CONNECT_SERVER = 'https://enbox-dwn.fly.dev/connect';

export function ConnectScreen() {
  const theme = useAppTheme();
  const authManager = useAgentStore((s) => s.authManager);
  const [state, setState] = useState<ConnectState>({ step: 'idle' });
  const [pin, setPin] = useState('');
  const pinResolverRef = useRef<((value: string | undefined) => void) | null>(null);

  async function handleConnect() {
    if (!authManager) {
      setState({ step: 'error', message: 'Agent not initialized. Please restart the app.' });
      return;
    }

    setState({ step: 'connecting' });

    try {
      await mobileConnect({
        authManager,
        displayName: 'Enbox Mobile',
        connectServerUrl: DEFAULT_CONNECT_SERVER,
        permissionRequests: [],
        onWalletUriReady: (uri) => {
          setState({ step: 'waiting', walletUri: uri });
        },
        validatePin: () => {
          setState({ step: 'pin' });
          return new Promise<string | undefined>((resolve) => {
            pinResolverRef.current = resolve;
          });
        },
      });
      setState({ step: 'connected' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connect failed';
      if (message.includes('cancelled')) {
        setState({ step: 'idle' });
      } else {
        setState({ step: 'error', message });
      }
    }
  }

  function handleSubmitPin() {
    if (pinResolverRef.current && pin.length > 0) {
      pinResolverRef.current(pin);
      pinResolverRef.current = null;
      setPin('');
      setState({ step: 'connecting' });
    }
  }

  function handleCancelPin() {
    if (pinResolverRef.current) {
      pinResolverRef.current(undefined);
      pinResolverRef.current = null;
    }
    setPin('');
    setState({ step: 'idle' });
  }

  function handleOpenWalletUri(uri: string) {
    Linking.openURL(uri).catch(() => {
      Alert.alert('Cannot open wallet', 'No app registered to handle this link. Scan the QR code with another device instead.');
    });
  }

  return (
    <Screen>
      <ScreenHeader
        title="Connect"
        subtitle="Authorize apps and services to access your identity."
      />

      {state.step === 'idle' && (
        <AppButton label="Start connection" onPress={handleConnect} />
      )}

      {state.step === 'connecting' && (
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Connecting...</Text>
          <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}>
            Waiting for the relay server.
          </Text>
        </View>
      )}

      {state.step === 'waiting' && (
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Scan with wallet</Text>
          <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}>
            Show this to the wallet app, or open on this device.
          </Text>
          <View style={[styles.uriBox, { backgroundColor: theme.colors.surfaceMuted, borderColor: theme.colors.border }]}>
            <Text style={[styles.uri, { color: theme.colors.text }]} numberOfLines={3} selectable>
              {state.walletUri}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => handleOpenWalletUri(state.walletUri)}
            style={[styles.linkButton, { borderColor: theme.colors.border }]}
          >
            <Text style={[styles.linkButtonText, { color: theme.colors.accent }]}>Open in wallet app</Text>
          </Pressable>
        </View>
      )}

      {state.step === 'pin' && (
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Enter confirmation PIN</Text>
          <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}>
            The wallet shows a PIN. Enter it here to complete the connection.
          </Text>
          <TextInput
            accessibilityLabel="Confirmation PIN"
            autoFocus
            keyboardType="number-pad"
            maxLength={8}
            onChangeText={setPin}
            placeholder="PIN"
            placeholderTextColor={theme.colors.textMuted}
            returnKeyType="done"
            secureTextEntry
            style={[styles.pinInput, { backgroundColor: theme.colors.surfaceMuted, borderColor: theme.colors.border, color: theme.colors.text }]}
            value={pin}
          />
          <View style={styles.buttons}>
            <AppButton label="Cancel" variant="secondary" onPress={handleCancelPin} />
            <AppButton label="Confirm" disabled={pin.length === 0} onPress={handleSubmitPin} />
          </View>
        </View>
      )}

      {state.step === 'connected' && (
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <Text style={[styles.cardTitle, { color: theme.colors.success }]}>Connected</Text>
          <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}>
            Session established. The app now has delegated access to your identity.
          </Text>
          <AppButton label="Done" onPress={() => setState({ step: 'idle' })} />
        </View>
      )}

      {state.step === 'error' && (
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <Text style={[styles.cardTitle, { color: theme.colors.warning }]}>Connection failed</Text>
          <Text accessibilityRole="alert" style={[styles.cardBody, { color: theme.colors.textMuted }]}>{state.message}</Text>
          <AppButton label="Try again" onPress={() => setState({ step: 'idle' })} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 24, borderWidth: 1, padding: 20, gap: 12 },
  cardTitle: { fontSize: 18, fontWeight: '700' },
  cardBody: { fontSize: 15, lineHeight: 22 },
  uriBox: { borderRadius: 12, borderWidth: 1, padding: 12 },
  uri: { fontSize: 12, fontFamily: 'monospace' },
  linkButton: { borderRadius: 16, borderWidth: 1, padding: 14, alignItems: 'center' },
  linkButtonText: { fontSize: 15, fontWeight: '600' },
  pinInput: { borderRadius: 16, borderWidth: 1, fontSize: 24, letterSpacing: 10, paddingHorizontal: 18, paddingVertical: 16, textAlign: 'center' },
  buttons: { flexDirection: 'row', gap: 12 },
});
