import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Camera, CameraType, type CameraApi } from 'react-native-camera-kit';

import { AppButton } from '@/components/ui/app-button';
import { useWalletConnectStore } from '@/lib/enbox/wallet-connect-store';
import { useAppTheme } from '@/theme';

export function WalletConnectScannerScreen() {
  const navigation = useNavigation<any>();
  const theme = useAppTheme();
  const cameraRef = useRef<CameraApi | null>(null);
  const handledRef = useRef(false);

  const handleIncomingUrl = useWalletConnectStore((s) => s.handleIncomingUrl);

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scannerError, setScannerError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function requestPermission() {
      try {
        // Wait a tick so the Camera ref is mounted.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const api = cameraRef.current;
        if (!api || cancelled) return;

        const granted = await api.checkDeviceCameraAuthorizationStatus()
          || await api.requestDeviceCameraAuthorization();

        if (!cancelled) {
          setHasPermission(granted);
        }
      } catch (err) {
        if (!cancelled) {
          setScannerError(err instanceof Error ? err.message : 'Camera permission failed');
          setHasPermission(false);
        }
      }
    }

    requestPermission().catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleReadCode(event: { nativeEvent: { codeStringValue: string } }) {
    if (handledRef.current) return;

    const value = event.nativeEvent.codeStringValue?.trim();
    if (!value) return;

    handledRef.current = true;
    try {
      await handleIncomingUrl(value);
      navigation.goBack();
    } catch (err) {
      handledRef.current = false;
      Alert.alert('Invalid QR code', err instanceof Error ? err.message : 'Could not process QR code');
    }
  }

  if (hasPermission === null) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}> 
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.accent} />
          <Text style={[styles.message, { color: theme.colors.textMuted }]}>Requesting camera access…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!hasPermission) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}> 
        <View style={styles.centered}>
          <Text style={[styles.title, { color: theme.colors.warning }]}>Camera unavailable</Text>
          <Text style={[styles.message, { color: theme.colors.textMuted }]}> 
            {scannerError ?? 'Enable camera access to scan an Enbox connect QR code.'}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right', 'bottom']}>
      <View style={styles.cameraWrap}>
        <Camera
          ref={cameraRef}
          style={styles.camera}
          cameraType={CameraType.Back}
          scanBarcode
          allowedBarcodeTypes={['qr']}
          scanThrottleDelay={1200}
          showFrame
          laserColor={theme.colors.accent}
          frameColor="#ffffff"
          ratioOverlayColor="rgba(0,0,0,0.45)"
          onReadCode={handleReadCode}
          onError={(event) => {
            setScannerError(event.nativeEvent.errorMessage);
          }}
        />
        <View style={styles.overlay} pointerEvents="box-none">
          <View style={[styles.topBar, { backgroundColor: 'rgba(0,0,0,0.4)' }]}> 
            <Text style={styles.overlayTitle}>Scan app QR</Text>
            <Text style={styles.overlayBody}>Point your camera at an `enbox://connect` QR code.</Text>
          </View>
          <View style={styles.bottomBar}>
            <AppButton label="Close scanner" variant="secondary" onPress={() => navigation.goBack()} />
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 12 },
  title: { fontSize: 22, fontWeight: '700' },
  message: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  cameraWrap: { flex: 1, backgroundColor: '#000000' },
  camera: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFill, justifyContent: 'space-between' },
  topBar: { paddingHorizontal: 20, paddingTop: Platform.OS === 'android' ? 18 : 8, paddingBottom: 18, gap: 6 },
  overlayTitle: { color: '#ffffff', fontSize: 24, fontWeight: '700' },
  overlayBody: { color: '#e5e7eb', fontSize: 14, lineHeight: 20 },
  bottomBar: { padding: 20 },
});
