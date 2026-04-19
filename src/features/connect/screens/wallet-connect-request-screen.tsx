import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { useAgentStore } from '@/lib/enbox/agent-store';
import { useWalletConnectStore } from '@/lib/enbox/wallet-connect-store';
import { useAppTheme } from '@/theme';

type ScopeSummary = {
  label: string;
  risk: 'low' | 'medium' | 'high';
};

type ProtocolSummary = {
  protocol: string;
  risk: ScopeSummary['risk'];
  permissions: ScopeSummary[];
  encryptedTypes: string[];
};

function summarizeScope(scope: any): ScopeSummary {
  const target = 'protocolPath' in scope && scope.protocolPath ? ` for ${scope.protocolPath}` : '';

  if (scope.interface === 'Protocols' && scope.method === 'Configure') {
    return { label: `Install or update the protocol${target}`, risk: 'high' };
  }
  if (scope.interface === 'Protocols' && scope.method === 'Query') {
    return { label: `Read protocol configuration${target}`, risk: 'low' };
  }
  if (scope.interface === 'Records' && scope.method === 'Write') {
    return { label: `Write records${target}`, risk: 'high' };
  }
  if (scope.interface === 'Records' && scope.method === 'Delete') {
    return { label: `Delete records${target}`, risk: 'high' };
  }
  if (scope.interface === 'Records' && scope.method === 'Read') {
    return { label: `Read records${target}`, risk: 'low' };
  }
  if (scope.interface === 'Records' && scope.method === 'Query') {
    return { label: `Query records${target}`, risk: 'medium' };
  }
  if (scope.interface === 'Records' && scope.method === 'Subscribe') {
    return { label: `Subscribe to record changes${target}`, risk: 'medium' };
  }
  if (scope.interface === 'Messages' && scope.method === 'Read') {
    return { label: `Read and sync delegated messages${target}`, risk: 'medium' };
  }

  return { label: `${scope.interface}.${scope.method}${target}`, risk: 'medium' };
}

function summarizeProtocol(request: any): ProtocolSummary {
  const summaries: ScopeSummary[] = request.permissionScopes.map(summarizeScope);
  const risk = summaries.some((s) => s.risk === 'high')
    ? 'high'
    : summaries.some((s) => s.risk === 'medium')
      ? 'medium'
      : 'low';

  return {
    protocol: request.protocolDefinition.protocol,
    risk,
    permissions: summaries,
    encryptedTypes: Object.entries(request.protocolDefinition.types ?? {})
      .filter(([, typeDef]) => (typeDef as any)?.encryptionRequired)
      .map(([path]) => path),
  };
}

export function WalletConnectRequestScreen() {
  const theme = useAppTheme();
  const agent = useAgentStore((s) => s.agent);
  const identities = useAgentStore((s) => s.identities);
  const createIdentity = useAgentStore((s) => s.createIdentity);

  const phase = useWalletConnectStore((s) => s.phase);
  const pending = useWalletConnectStore((s) => s.pending);
  const generatedPin = useWalletConnectStore((s) => s.generatedPin);
  const error = useWalletConnectStore((s) => s.error);
  const approve = useWalletConnectStore((s) => s.approve);
  const deny = useWalletConnectStore((s) => s.deny);
  const clear = useWalletConnectStore((s) => s.clear);

  const [selectedDid, setSelectedDid] = useState('');
  const [creatingIdentity, setCreatingIdentity] = useState(false);
  const [identityName, setIdentityName] = useState('');

  useEffect(() => {
    if (!selectedDid && identities.length > 0) {
      setSelectedDid(identities[0].metadata.uri);
    }
  }, [identities, selectedDid]);

  const appName = pending?.request.appName ?? 'Unknown app';
  const callbackOrigin = useMemo(() => {
    try {
      return pending ? new URL(pending.request.callbackUrl).origin : '';
    } catch {
      return '';
    }
  }, [pending]);

  const protocolSummaries = useMemo(() => {
    if (!pending) return [];
    return pending.request.permissionRequests.map(summarizeProtocol);
  }, [pending]);

  async function handleApprove() {
    if (!agent || !selectedDid) return;
    try {
      await approve(selectedDid, agent);
    } catch (err) {
      Alert.alert('Authorization failed', err instanceof Error ? err.message : 'Could not authorize app');
    }
  }

  async function handleCreateIdentity() {
    if (!identityName.trim() || creatingIdentity) return;
    setCreatingIdentity(true);
    try {
      const identity = await createIdentity(identityName.trim());
      setSelectedDid(identity.metadata.uri);
      setIdentityName('');
    } catch (err) {
      Alert.alert('Identity creation failed', err instanceof Error ? err.message : 'Could not create identity');
    } finally {
      setCreatingIdentity(false);
    }
  }

  if (phase === 'loading') {
    return (
      <Screen contentContainerStyle={styles.centered}>
        <Text style={[styles.title, { color: theme.colors.text }]}>Loading request…</Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>Fetching and validating the app’s connect request.</Text>
      </Screen>
    );
  }

  if (phase === 'error') {
    return (
      <Screen contentContainerStyle={styles.centered}>
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}> 
          <Text style={[styles.title, { color: theme.colors.warning }]}>Connection error</Text>
          <Text style={[styles.body, { color: theme.colors.textMuted }]}>{error ?? 'Unknown error'}</Text>
          <AppButton label="Dismiss" onPress={clear} />
        </View>
      </Screen>
    );
  }

  if (phase === 'pin' && generatedPin) {
    return (
      <Screen contentContainerStyle={styles.centered}>
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}> 
          <Text style={[styles.title, { color: theme.colors.success }]}>Authorized</Text>
          <Text style={[styles.body, { color: theme.colors.textMuted }]}>Return to the requesting app and enter this PIN to complete the connection.</Text>
          <Text style={[styles.pin, { color: theme.colors.text }]}>{generatedPin}</Text>
          <AppButton label="Done" onPress={clear} />
        </View>
      </Screen>
    );
  }

  if (phase === 'authorizing') {
    return (
      <Screen contentContainerStyle={styles.centered}>
        <Text style={[styles.title, { color: theme.colors.text }]}>Authorizing…</Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>Installing protocols and creating delegated grants.</Text>
      </Screen>
    );
  }

  if (!pending) {
    return null;
  }

  return (
    <Screen>
      <ScreenHeader
        title="Connection request"
        subtitle={`${appName} wants access to one of your identities.`}
      />

      <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}> 
        <Text style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>App</Text>
        <Text style={[styles.appName, { color: theme.colors.text }]}>{appName}</Text>
        {callbackOrigin ? <Text style={[styles.origin, { color: theme.colors.textMuted }]}>{callbackOrigin}</Text> : null}
      </View>

      <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}> 
        <Text style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>Requested permissions</Text>
        <ScrollView style={styles.permissions}>
          {protocolSummaries.map((summary, requestIndex) => (
            <View key={`${summary.protocol}-${requestIndex}`} style={[styles.permissionGroup, { borderColor: theme.colors.border }]}> 
              <View style={styles.permissionHeader}>
                <Text style={[styles.protocol, { color: theme.colors.text }]}>{summary.protocol}</Text>
                <View style={[
                  styles.riskBadge,
                  {
                    backgroundColor:
                      summary.risk === 'high'
                        ? theme.colors.warning
                        : summary.risk === 'medium'
                          ? theme.colors.surfaceMuted
                          : theme.colors.surfaceMuted,
                  },
                ]}>
                  <Text style={[
                    styles.riskBadgeText,
                    { color: summary.risk === 'high' ? theme.colors.accentText : theme.colors.text },
                  ]}>
                    {summary.risk.toUpperCase()}
                  </Text>
                </View>
              </View>

              {summary.permissions.map((permission: ScopeSummary, scopeIndex: number) => (
                <Text key={scopeIndex} style={[styles.scope, { color: theme.colors.textMuted }]}>
                  • {permission.label}
                </Text>
              ))}

              {summary.encryptedTypes.length > 0 ? (
                <View style={styles.encryptedBox}>
                  <Text style={[styles.encryptedTitle, { color: theme.colors.textMuted }]}>Encrypted types</Text>
                  {summary.encryptedTypes.map((path) => (
                    <Text key={path} style={[styles.encryptedType, { color: theme.colors.textMuted }]}>
                      {path}
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>
          ))}

          <View style={[styles.warningBox, { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceMuted }]}> 
            <Text style={[styles.warningTitle, { color: theme.colors.text }]}>What approval does</Text>
            <Text style={[styles.warningBody, { color: theme.colors.textMuted }]}> 
              Approval creates a delegated DID for the app with only the permissions listed above. You can revoke the session later by disconnecting the app.
            </Text>
            <Text style={[styles.warningBody, { color: theme.colors.textMuted }]}> 
              High-risk permissions include protocol installation, record writes, and record deletion.
            </Text>
          </View>
        </ScrollView>
      </View>

      <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}> 
        <Text style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>Identity</Text>
        {identities.length === 0 ? (
          <View style={styles.identityCreate}>
            <Text style={[styles.body, { color: theme.colors.textMuted }]}>You need an identity before you can authorize this app.</Text>
            <TextInput
              accessibilityLabel="Identity name"
              placeholder="Identity name"
              placeholderTextColor={theme.colors.textMuted}
              value={identityName}
              onChangeText={setIdentityName}
              style={[styles.input, { backgroundColor: theme.colors.surfaceMuted, borderColor: theme.colors.border, color: theme.colors.text }]}
            />
            <AppButton label="Create identity" loading={creatingIdentity} disabled={!identityName.trim()} onPress={handleCreateIdentity} />
          </View>
        ) : (
          <View style={styles.identityList}>
            {identities.map((identity) => {
              const did = identity.metadata.uri;
              const selected = selectedDid === did;
              return (
                <AppButton
                  key={did}
                  label={selected ? `${identity.metadata.name} (Selected)` : identity.metadata.name}
                  variant={selected ? 'primary' : 'secondary'}
                  onPress={() => setSelectedDid(did)}
                />
              );
            })}
          </View>
        )}
      </View>

      <View style={styles.actions}>
        <AppButton label="Deny" variant="secondary" onPress={() => { deny().catch(() => {}); }} />
        <AppButton label="Approve" disabled={!agent || !selectedDid} onPress={handleApprove} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  centered: { flexGrow: 1, justifyContent: 'center' },
  card: { borderRadius: 20, borderWidth: 1, padding: 16, gap: 8 },
  title: { fontSize: 24, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 22 },
  sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  appName: { fontSize: 18, fontWeight: '700' },
  origin: { fontSize: 12, fontFamily: 'monospace' },
  permissions: { maxHeight: 220 },
  permissionGroup: { gap: 6, marginBottom: 12, borderWidth: 1, borderRadius: 14, padding: 12 },
  permissionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  protocol: { fontSize: 14, fontWeight: '600' },
  scope: { fontSize: 13, lineHeight: 18 },
  riskBadge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  riskBadgeText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  encryptedBox: { gap: 4, marginTop: 4 },
  encryptedTitle: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  encryptedType: { fontSize: 12, fontFamily: 'monospace' },
  warningBox: { borderRadius: 14, borderWidth: 1, padding: 12, gap: 6, marginTop: 8 },
  warningTitle: { fontSize: 13, fontWeight: '700' },
  warningBody: { fontSize: 12, lineHeight: 18 },
  identityCreate: { gap: 10 },
  input: { borderRadius: 14, borderWidth: 1, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12 },
  identityList: { gap: 10 },
  actions: { flexDirection: 'row', gap: 12 },
  pin: { fontSize: 40, fontWeight: '800', letterSpacing: 8, textAlign: 'center' },
});
