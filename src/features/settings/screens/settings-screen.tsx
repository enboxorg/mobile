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

/**
 * Round-11 F2: surface a useful one-liner from any reset / hydrate
 * rejection. Prefers the native error `.code` (Keystore /
 * Keychain / SecureStorage error tokens like `VAULT_ERROR_*`,
 * `SECURE_STORAGE_*`) so the user / support team can correlate to
 * the failure mode in logs. Falls back to `.message` and finally a
 * generic string.
 */
function errorMessageFor(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return err.message ? `${code}: ${err.message}` : code;
    }
    if (err.message) {
      return err.message;
    }
  }
  return 'unknown error';
}

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
    //
    // Round-11 F2: pre-fix this swallowed `useAgentStore.reset()`
    // rejections via `console.warn` and unconditionally ran
    // `hydrate()` afterwards. That defeated the round-9/round-10
    // fail-LOUD reset contract: a real Keystore failure / LevelDB
    // wipe failure / session-store reset failure would surface to
    // `useAgentStore.reset()` as a thrown error, but the user
    // would see the alert close cleanly and the navigator would
    // refresh to `Welcome` as if the reset succeeded — yet the
    // OS-gated secret / on-disk identities / stale session flags
    // would still be alive on disk. The retry sentinels persisted
    // by `agent-store.reset()` would re-fire on the next cold
    // launch, but the user has zero in-session signal that
    // anything went wrong.
    //
    // Fix: capture the rejection, surface it via a follow-up
    // Alert with retry/cancel buttons, and SUPPRESS the
    // post-reset hydrate when reset throws. Hydrating after a
    // partial reset is what creates the unlock-loop trap (the
    // navigator routes to Unlock against a wallet whose
    // SecureStorage flags were partially cleared but whose
    // native secret survived). The retry sentinels guarantee
    // the next agent-init flow re-runs the wipe, so the ONLY
    // safe routing here is "leave the user in Settings with the
    // error visible".
    let resetError: unknown = null;
    try {
      await useAgentStore.getState().reset();
    } catch (err) {
      resetError = err;
      console.warn('[settings] reset wallet failed:', err);
    }

    if (resetError !== null) {
      // Surface the error to the user. The retry sentinels
      // persisted by `agent-store.reset()` mean the next agent
      // init flow will retry the cleanup, but the in-session
      // signal lets the user know to expect a re-prompt or
      // contact support if the failure recurs.
      const message = errorMessageFor(resetError);
      Alert.alert(
        'Reset failed',
        `The wallet reset did not complete: ${message}\n\nYour data is in a partially-cleared state. The app will retry the cleanup the next time you open it. You can also try resetting again now.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Retry',
            onPress: () => {
              performReset().catch(() => {
                // Already handled inside performReset.
              });
            },
          },
        ],
      );
      // CRITICAL: do NOT call hydrate(). Hydrating after a
      // partial reset routes the user against a half-cleared
      // SecureStorage view and traps them in unlock loops. The
      // retry sentinels handle the recovery on the next cold
      // launch; the user stays on Settings with the error
      // visible until they tap Retry or background the app.
      return;
    }

    // sessionStore.reset() leaves biometricStatus as `'unknown'`
    // which would route the navigator to `Loading`. Re-run hydrate
    // so biometric hardware is re-probed and routing returns to
    // `Welcome` (first-launch flow) per VAL-UX-036. Best-effort —
    // any failure is logged but must not throw out of the alert
    // confirmation handler. Reached only on a SUCCESSFUL reset.
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
