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
import {
  openCameraPermissionSettings,
  requestCameraPermission,
} from '@/lib/native/camera-permission';
import { useAppTheme } from '@/theme';

type PermissionPhase = 'probing' | 'granted' | 'denied';

/**
 * Three-state permission machine:
 *   - `probing`: the permission probe is running. Displays a loader.
 *   - `granted`: the user has allowed camera access. Mounts `<Camera>`.
 *   - `denied`: the user has refused camera access. Surfaces a friendly
 *     message; when the OS has locked further prompts out we add an
 *     "Open Settings" CTA so the user has a recovery path.
 *
 * The probe runs unconditionally on mount via
 * `requestCameraPermission()` and DOES NOT depend on the `<Camera>`
 * component being mounted first — a prior implementation gated the
 * probe on `cameraRef.current`, which could never resolve because the
 * `<Camera>` was only rendered after permission was granted.
 */
export function WalletConnectScannerScreen() {
  const navigation = useNavigation<any>();
  const theme = useAppTheme();
  const cameraRef = useRef<CameraApi | null>(null);
  const handledRef = useRef(false);

  const handleIncomingUrl = useWalletConnectStore((s) => s.handleIncomingUrl);

  const [phase, setPhase] = useState<PermissionPhase>('probing');
  const [blocked, setBlocked] = useState(false);
  const [scannerError, setScannerError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    requestCameraPermission()
      .then((result) => {
        if (cancelled) return;
        setBlocked(result.blocked);
        setPhase(result.granted ? 'granted' : 'denied');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setScannerError(
          err instanceof Error ? err.message : 'Camera permission failed',
        );
        setBlocked(false);
        setPhase('denied');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleReadCode(event: {
    nativeEvent: { codeStringValue: string };
  }) {
    if (handledRef.current) return;

    const value = event.nativeEvent.codeStringValue?.trim();
    if (!value) return;

    handledRef.current = true;
    try {
      await handleIncomingUrl(value);
      navigation.goBack();
    } catch (err) {
      handledRef.current = false;
      Alert.alert(
        'Invalid QR code',
        err instanceof Error ? err.message : 'Could not process QR code',
      );
    }
  }

  if (phase === 'probing') {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.colors.background }]}
      >
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.accent} />
          <Text style={[styles.message, { color: theme.colors.textMuted }]}>
            Requesting camera access…
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (phase === 'denied') {
    const denialCopy =
      scannerError ??
      (blocked
        ? 'Camera access is turned off for Enbox. Open Settings to re-enable it and try again.'
        : 'Enable camera access to scan an Enbox connect QR code.');

    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.colors.background }]}
      >
        <View style={styles.centered}>
          <Text style={[styles.title, { color: theme.colors.warning }]}>
            Camera unavailable
          </Text>
          <Text style={[styles.message, { color: theme.colors.textMuted }]}>
            {denialCopy}
          </Text>
          {blocked ? (
            <AppButton
              accessibilityLabel="Open Settings"
              label="Open Settings"
              onPress={() => {
                void openCameraPermissionSettings();
              }}
            />
          ) : null}
          <AppButton
            label="Close scanner"
            variant="secondary"
            onPress={() => navigation.goBack()}
          />
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
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 12,
  },
  title: { fontSize: 22, fontWeight: '700' },
  message: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  cameraWrap: { flex: 1, backgroundColor: '#000000' },
  camera: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFill, justifyContent: 'space-between' },
  topBar: {
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'android' ? 18 : 8,
    paddingBottom: 18,
    gap: 6,
  },
  overlayTitle: { color: '#ffffff', fontSize: 24, fontWeight: '700' },
  overlayBody: { color: '#e5e7eb', fontSize: 14, lineHeight: 20 },
  bottomBar: { padding: 20 },
});
