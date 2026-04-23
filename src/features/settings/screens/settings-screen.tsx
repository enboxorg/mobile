import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { useSessionStore } from '@/features/session/session-store';
import { useAgentStore } from '@/lib/enbox/agent-store';
import { useAppTheme, type AppTheme } from '@/theme';

// Sourced from package.json so the About row always mirrors the shipped
// app's declared version (VAL-UX-053). Importing the field directly keeps
// tests honest — they read the same constant — without pulling in any
// runtime-only dependency.
 
const APP_VERSION: string = require('../../../../package.json').version;

// External-link targets surfaced in the About section. Hardcoded so the
// URLs are reviewable in source and stable across builds (VAL-UX-053
// requires `Linking.openURL` to be invoked with the exact URL on press).
const PRIVACY_POLICY_URL = 'https://enbox.org/privacy';
const TERMS_OF_SERVICE_URL = 'https://enbox.org/terms';

export interface SettingsScreenProps {
  onLock: () => void;
}

export function SettingsScreen({ onLock }: SettingsScreenProps) {
  const theme = useAppTheme();
  const agent = useAgentStore((s) => s.agent);
  const identityCount = useAgentStore((s) => s.identities.length);
  const agentError = useAgentStore((s) => s.error);

  const agentDid = agent?.agentDid?.uri;

  async function performReset(): Promise<void> {
    // Delegates to agentStore.reset which, in documented order,
    // calls NativeBiometricVault.deleteSecret + wipes the on-disk
    // ENBOX_AGENT LevelDB + tears down the in-memory agent store +
    // resets the session store. This is the same primitive surfaced
    // by the recovery-restore flow, kept as a single orchestration
    // point so Settings cannot drift from it (VAL-UX-036).
    try {
      await useAgentStore.getState().reset();
    } catch (err) {
      console.warn('[settings] reset wallet failed (continuing):', err);
    }
    // sessionStore.reset() leaves biometricStatus as `'unknown'`
    // which would route the navigator to `Loading`. Re-run hydrate
    // so biometric hardware is re-probed and routing returns to
    // `Welcome` (first-launch flow) per VAL-UX-036. Best-effort —
    // any failure is logged but must not throw out of the alert
    // confirmation handler.
    try {
      await useSessionStore.getState().hydrate();
    } catch (err) {
      console.warn('[settings] post-reset hydrate failed:', err);
    }
  }

  function handleReset() {
    Alert.alert(
      'Reset wallet',
      'This will erase your biometric-protected wallet, the biometric secret stored on this device, and all identities. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            performReset().catch(() => {
              // performReset already logs its own failures; swallow
              // here so the alert-button handler stays synchronous.
            });
          },
        },
      ],
    );
  }

  return (
    <Screen>
      <ScreenHeader title="Settings" />

      {agentDid && (
        <View style={[styles.section, { borderColor: theme.colors.border }]}>
          <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>
            Agent
          </Text>
          <View style={styles.infoRow}>
            <Text style={[styles.infoLabel, { color: theme.colors.textMuted }]}>Agent DID</Text>
            <Text style={[styles.infoValue, { color: theme.colors.text }]} numberOfLines={1} selectable>
              {agentDid}
            </Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={[styles.infoLabel, { color: theme.colors.textMuted }]}>Identities</Text>
            <Text style={[styles.infoValue, { color: theme.colors.text }]}>{identityCount}</Text>
          </View>
        </View>
      )}

      {agentError ? (
        <View style={[styles.section, { borderColor: theme.colors.border }]}> 
          <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>Agent error</Text>
          <View style={styles.infoRow}>
            <Text style={[styles.infoValue, { color: theme.colors.warning }]} selectable>
              {agentError}
            </Text>
          </View>
        </View>
      ) : null}

      <View style={[styles.section, { borderColor: theme.colors.border }]}>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>
          Security
        </Text>
        <SettingsRow label="Lock wallet" onPress={onLock} theme={theme} />
        <SettingsRow label="Biometric unlock" disabled onPress={() => {}} theme={theme} />
      </View>

      <View style={[styles.section, { borderColor: theme.colors.border }]}>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>
          Data
        </Text>
        <SettingsRow label="Export backup" disabled onPress={() => {}} theme={theme} />
        <SettingsRow label="Import backup" disabled onPress={() => {}} theme={theme} />
      </View>

      <View style={[styles.section, { borderColor: theme.colors.border }]}>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>
          About
        </Text>
        <View style={styles.infoRow}>
          <Text style={[styles.infoLabel, { color: theme.colors.textMuted }]}>App version</Text>
          <Text
            accessibilityLabel={`App version ${APP_VERSION}`}
            style={[styles.infoValue, { color: theme.colors.text }]}
            selectable
          >
            {APP_VERSION}
          </Text>
        </View>
        <SettingsRow
          label="Privacy policy"
          onPress={() => {
            // `void` marks a deliberately-unawaited fire-and-forget promise.
            // eslint-disable-next-line no-void
            void Linking.openURL(PRIVACY_POLICY_URL);
          }}
          theme={theme}
        />
        <SettingsRow
          label="Terms of service"
          onPress={() => {
            // `void` marks a deliberately-unawaited fire-and-forget promise.
            // eslint-disable-next-line no-void
            void Linking.openURL(TERMS_OF_SERVICE_URL);
          }}
          theme={theme}
        />
      </View>

      <View style={[styles.section, { borderColor: theme.colors.border }]}>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>
          Danger zone
        </Text>
        <SettingsRow label="Reset wallet" destructive onPress={handleReset} theme={theme} />
      </View>
    </Screen>
  );
}

interface SettingsRowProps {
  label: string;
  onPress: () => void;
  theme: AppTheme;
  disabled?: boolean;
  destructive?: boolean;
}

function SettingsRow({ label, onPress, theme, disabled, destructive }: SettingsRowProps) {
  const textColor = destructive
    ? theme.colors.warning
    : disabled
      ? theme.colors.textMuted
      : theme.colors.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.colors.surfaceMuted : 'transparent' },
      ]}
    >
      <Text style={[styles.rowLabel, { color: textColor }]}>{label}</Text>
      {!disabled && <Text style={[styles.rowChevron, { color: theme.colors.textMuted }]}>&rsaquo;</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  infoRow: { paddingHorizontal: 16, paddingVertical: 10, gap: 2 },
  infoLabel: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  infoValue: { fontSize: 13, fontFamily: 'monospace' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14 },
  rowLabel: { fontSize: 16 },
  rowChevron: { fontSize: 22 },
});
