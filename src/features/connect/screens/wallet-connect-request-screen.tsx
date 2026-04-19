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
          {pending.request.permissionRequests.map((request, requestIndex) => (
            <View key={`${request.protocolDefinition.protocol}-${requestIndex}`} style={styles.permissionGroup}>
              <Text style={[styles.protocol, { color: theme.colors.text }]}>{request.protocolDefinition.protocol}</Text>
              {request.permissionScopes.map((scope: any, scopeIndex) => (
                <Text key={scopeIndex} style={[styles.scope, { color: theme.colors.textMuted }]}>
                  {scope.interface}.{scope.method}
                  {'protocolPath' in scope && scope.protocolPath ? ` on ${scope.protocolPath}` : ''}
                  {'contextId' in scope && scope.contextId ? ` (${scope.contextId})` : ''}
                </Text>
              ))}
            </View>
          ))}
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
  permissionGroup: { gap: 4, marginBottom: 10 },
  protocol: { fontSize: 14, fontWeight: '600' },
  scope: { fontSize: 13, lineHeight: 18 },
  identityCreate: { gap: 10 },
  input: { borderRadius: 14, borderWidth: 1, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12 },
  identityList: { gap: 10 },
  actions: { flexDirection: 'row', gap: 12 },
  pin: { fontSize: 40, fontWeight: '800', letterSpacing: 8, textAlign: 'center' },
});
