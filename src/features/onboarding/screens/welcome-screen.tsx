import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import { useAppTheme } from '@/theme';

export interface WelcomeScreenProps {
  onStart: () => void;
}

export function WelcomeScreen({ onStart }: WelcomeScreenProps) {
  const theme = useAppTheme();

  return (
    <Screen contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={[styles.kicker, { color: theme.colors.accent }]}>Enbox</Text>
        <Text style={[styles.title, { color: theme.colors.text }]}>
          Your identities, your devices, your control.
        </Text>
        <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
          Enbox is a mobile wallet for managing decentralized identities, permissions, and connections. Your keys never leave your device.
        </Text>
      </View>

      <View style={[styles.featureList, { borderColor: theme.colors.border }]}>
        <Feature
          icon="01"
          title="Secure by default"
          description="Your wallet is protected by a PIN and stored in your device's secure enclave."
          theme={theme}
        />
        <Feature
          icon="02"
          title="Own your identity"
          description="Create and manage decentralized identities that you control, not a platform."
          theme={theme}
        />
        <Feature
          icon="03"
          title="Connect anywhere"
          description="Scan QR codes, share profiles, and authorize apps directly from your phone."
          theme={theme}
        />
      </View>

      <AppButton label="Get started" onPress={onStart} />
    </Screen>
  );
}

interface FeatureProps {
  icon: string;
  title: string;
  description: string;
  theme: ReturnType<typeof useAppTheme>;
}

function Feature({ icon, title, description, theme }: FeatureProps) {
  return (
    <View style={styles.feature}>
      <View style={[styles.featureIcon, { backgroundColor: theme.colors.surfaceMuted }]}>
        <Text style={[styles.featureIconText, { color: theme.colors.accent }]}>{icon}</Text>
      </View>
      <View style={styles.featureText}>
        <Text style={[styles.featureTitle, { color: theme.colors.text }]}>{title}</Text>
        <Text style={[styles.featureDesc, { color: theme.colors.textMuted }]}>{description}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { justifyContent: 'center' },
  hero: { gap: 12, marginBottom: 8 },
  kicker: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  title: { fontSize: 32, lineHeight: 38, fontWeight: '800' },
  subtitle: { fontSize: 16, lineHeight: 24 },
  featureList: {
    borderRadius: 24,
    borderWidth: 1,
    overflow: 'hidden',
  },
  feature: {
    flexDirection: 'row',
    padding: 16,
    gap: 14,
    alignItems: 'flex-start',
  },
  featureIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureIconText: { fontSize: 14, fontWeight: '800' },
  featureText: { flex: 1, gap: 2 },
  featureTitle: { fontSize: 15, fontWeight: '700' },
  featureDesc: { fontSize: 14, lineHeight: 20 },
});
