import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { useAgentStore } from '@/lib/enbox/agent-store';
import { useAppTheme, type AppTheme } from '@/theme';

export interface SettingsScreenProps {
  onLock: () => void;
  onReset?: () => Promise<void>;
}

export function SettingsScreen({ onLock, onReset }: SettingsScreenProps) {
  const theme = useAppTheme();
  const agent = useAgentStore((s) => s.agent);
  const identityCount = useAgentStore((s) => s.identities.length);
  const agentError = useAgentStore((s) => s.error);

  const agentDid = agent?.agentDid?.uri;

  function handleReset() {
    Alert.alert(
      'Reset wallet',
      'This will erase all data including your identities and PIN. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: () => onReset?.() },
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
        <SettingsRow label="Change PIN" disabled onPress={() => {}} theme={theme} />
        <SettingsRow label="Biometric unlock" disabled onPress={() => {}} theme={theme} />
      </View>

      <View style={[styles.section, { borderColor: theme.colors.border }]}>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>
          Data
        </Text>
        <SettingsRow label="Export backup" disabled onPress={() => {}} theme={theme} />
        <SettingsRow label="Import backup" disabled onPress={() => {}} theme={theme} />
      </View>

      {onReset && (
        <View style={[styles.section, { borderColor: theme.colors.border }]}>
          <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>
            Danger zone
          </Text>
          <SettingsRow label="Reset wallet" destructive onPress={handleReset} theme={theme} />
        </View>
      )}
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
