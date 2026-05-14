import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
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
import { useAppTheme, type AppTheme } from '@/theme';

export function IdentitiesScreen() {
  const theme = useAppTheme();
  const identities = useAgentStore((s) => s.identities);
  const createIdentity = useAgentStore((s) => s.createIdentity);
  const updateIdentityName = useAgentStore((s) => s.updateIdentityName);
  const deleteIdentity = useAgentStore((s) => s.deleteIdentity);
  const refreshIdentities = useAgentStore((s) => s.refreshIdentities);
  const agent = useAgentStore((s) => s.agent);
  const isInitializing = useAgentStore((s) => s.isInitializing);
  const agentError = useAgentStore((s) => s.error);
  const clearAgentError = useAgentStore((s) => s.clearError);

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedDid, setSelectedDid] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);

  const selectedIdentity = identities.find((identity) => {
    const did = identity.metadata?.uri ?? identity.did?.uri;
    return did === selectedDid;
  });

  const handleCreate = useCallback(async () => {
    if (!name.trim() || creating) return;

    setCreating(true);
    try {
      await createIdentity(name.trim());
      setName('');
      setShowCreate(false);
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to create identity');
    } finally {
      setCreating(false);
    }
  }, [name, creating, createIdentity]);

  const handleSelect = useCallback((identity: any) => {
    const did = identity.metadata?.uri ?? identity.did?.uri;
    if (!did) return;
    setSelectedDid(did);
    setEditName(identity.metadata?.name ?? '');
  }, []);

  const handleSaveName = useCallback(async () => {
    if (!selectedDid || !editName.trim() || saving) return;
    setSaving(true);
    try {
      await updateIdentityName(selectedDid, editName.trim());
    } catch (err) {
      Alert.alert('Update failed', err instanceof Error ? err.message : 'Could not update identity');
    } finally {
      setSaving(false);
    }
  }, [editName, saving, selectedDid, updateIdentityName]);

  const handleDelete = useCallback(() => {
    if (!selectedDid) return;
    Alert.alert(
      'Delete identity',
      'This removes the identity and its local key material from this wallet. Make sure you have an identity backup before continuing.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteIdentity(selectedDid)
              .then(() => {
                setSelectedDid(null);
                setEditName('');
              })
              .catch((err) => {
                Alert.alert(
                  'Delete failed',
                  err instanceof Error ? err.message : 'Could not delete identity',
                );
              });
          },
        },
      ],
    );
  }, [deleteIdentity, selectedDid]);

  useEffect(() => {
    if (agent) {
      refreshIdentities().catch(() => {});
    }
  }, [agent, refreshIdentities]);

  if (!agent && isInitializing) {
    return (
      <Screen contentContainerStyle={styles.centered}>
        <ActivityIndicator size="large" color={theme.colors.accent} />
        <Text style={[styles.loadingText, { color: theme.colors.textMuted }]}>
          Starting agent...
        </Text>
      </Screen>
    );
  }

  if (!agent) {
    return (
      <Screen contentContainerStyle={styles.centered}>
        <View style={[styles.errorCard, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <Text style={[styles.errorTitle, { color: theme.colors.warning }]}>Agent unavailable</Text>
          <Text style={[styles.errorBody, { color: theme.colors.textMuted }]}>
            {agentError ?? 'The wallet agent is not available in this session.'}
          </Text>
          <AppButton label="Dismiss" variant="secondary" onPress={clearAgentError} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader title="Identities" />

      {agentError ? (
        <View style={[styles.inlineError, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <Text style={[styles.inlineErrorTitle, { color: theme.colors.warning }]}>Agent warning</Text>
          <Text style={[styles.inlineErrorBody, { color: theme.colors.textMuted }]} numberOfLines={4}>
            {agentError}
          </Text>
          <AppButton label="Clear warning" variant="secondary" onPress={clearAgentError} />
        </View>
      ) : null}

      {identities.length === 0 && !showCreate && (
        <View style={[styles.empty, { borderColor: theme.colors.border }]}>
          <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>No identities yet</Text>
          <Text style={[styles.emptyBody, { color: theme.colors.textMuted }]}>
            Create your first decentralized identity to start managing profiles, permissions, and connections.
          </Text>
          <AppButton label="Create identity" onPress={() => setShowCreate(true)} />
        </View>
      )}

      {showCreate && (
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <Text style={[styles.cardTitle, { color: theme.colors.text }]}>New identity</Text>
          <TextInput
            accessibilityLabel="Identity name"
            autoFocus
            onChangeText={setName}
            placeholder="Display name"
            placeholderTextColor={theme.colors.textMuted}
            returnKeyType="done"
            onSubmitEditing={handleCreate}
            style={[styles.input, { backgroundColor: theme.colors.surfaceMuted, borderColor: theme.colors.border, color: theme.colors.text }]}
            value={name}
          />
          <View style={styles.buttons}>
            <AppButton
              label="Cancel"
              variant="secondary"
              onPress={() => { setShowCreate(false); setName(''); }}
            />
            <AppButton
              label="Create"
              loading={creating}
              disabled={!name.trim()}
              onPress={handleCreate}
            />
          </View>
        </View>
      )}

      {selectedIdentity ? (
        <View
          style={[
            styles.card,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
          ]}
        >
          <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Identity details</Text>
          <TextInput
            accessibilityLabel="Edit identity name"
            onChangeText={setEditName}
            placeholder="Display name"
            placeholderTextColor={theme.colors.textMuted}
            style={[styles.input, { backgroundColor: theme.colors.surfaceMuted, borderColor: theme.colors.border, color: theme.colors.text }]}
            value={editName}
          />
          <Text style={[styles.detailLabel, { color: theme.colors.textMuted }]}>DID</Text>
          <Text style={[styles.detailValue, { color: theme.colors.text }]} selectable>
            {selectedIdentity.metadata?.uri ?? selectedIdentity.did?.uri}
          </Text>
          {selectedIdentity.metadata?.tenant ? (
            <>
              <Text style={[styles.detailLabel, { color: theme.colors.textMuted }]}>Tenant</Text>
              <Text style={[styles.detailValue, { color: theme.colors.text }]} selectable>
                {selectedIdentity.metadata.tenant}
              </Text>
            </>
          ) : null}
          {selectedIdentity.metadata?.connectedDid ? (
            <>
              <Text style={[styles.detailLabel, { color: theme.colors.textMuted }]}>Connected DID</Text>
              <Text style={[styles.detailValue, { color: theme.colors.text }]} selectable>
                {selectedIdentity.metadata.connectedDid}
              </Text>
            </>
          ) : null}
          <View style={styles.buttons}>
            <AppButton
              label="Close"
              variant="secondary"
              onPress={() => setSelectedDid(null)}
            />
            <AppButton
              label="Save"
              loading={saving}
              disabled={!editName.trim()}
              onPress={handleSaveName}
            />
          </View>
          <AppButton
            label="Delete identity"
            variant="secondary"
            onPress={handleDelete}
          />
        </View>
      ) : null}

      {identities.length > 0 && (
        <>
          <FlatList
            data={identities}
            keyExtractor={(item) => item.metadata?.uri ?? item.did?.uri}
            scrollEnabled={false}
            renderItem={({ item }) => (
              <IdentityRow identity={item} theme={theme} onPress={() => handleSelect(item)} />
            )}
            ItemSeparatorComponent={Separator}
            style={[styles.list, { borderColor: theme.colors.border }]}
          />
          {!showCreate && (
            <AppButton label="Create another identity" variant="secondary" onPress={() => setShowCreate(true)} />
          )}
          <AppButton label="Refresh" variant="secondary" onPress={refreshIdentities} />
        </>
      )}
    </Screen>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

function IdentityRow({
  identity,
  theme,
  onPress,
}: {
  identity: any;
  theme: AppTheme;
  onPress: () => void;
}) {
  const didUri = identity.metadata?.uri ?? identity.did?.uri ?? 'Unknown DID';
  const displayName = identity.metadata?.name ?? 'Unnamed';

  return (
    <Pressable style={styles.row} accessibilityRole="button" onPress={onPress}>
      <View style={[styles.avatar, { backgroundColor: theme.colors.surfaceMuted }]}>
        <Text style={[styles.avatarText, { color: theme.colors.accent }]}>
          {displayName.charAt(0).toUpperCase()}
        </Text>
      </View>
      <View style={styles.rowContent}>
        <Text style={[styles.rowName, { color: theme.colors.text }]} numberOfLines={1}>{displayName}</Text>
        <Text style={[styles.rowDid, { color: theme.colors.textMuted }]} numberOfLines={1}>{didUri}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  centered: { flexGrow: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 12, fontSize: 15 },
  errorCard: { borderRadius: 24, borderWidth: 1, padding: 20, gap: 12, width: '100%' },
  errorTitle: { fontSize: 18, fontWeight: '700' },
  errorBody: { fontSize: 14, lineHeight: 20 },
  inlineError: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 8 },
  inlineErrorTitle: { fontSize: 16, fontWeight: '700' },
  inlineErrorBody: { fontSize: 13, lineHeight: 18 },
  empty: { borderRadius: 24, borderWidth: 1, borderStyle: 'dashed', padding: 24, gap: 12, alignItems: 'center' },
  emptyTitle: { fontSize: 18, fontWeight: '700' },
  emptyBody: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  card: { borderRadius: 24, borderWidth: 1, padding: 20, gap: 12 },
  cardTitle: { fontSize: 18, fontWeight: '700' },
  detailLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  detailValue: { fontSize: 12, fontFamily: 'monospace', lineHeight: 18 },
  input: { borderRadius: 16, borderWidth: 1, fontSize: 16, paddingHorizontal: 16, paddingVertical: 14 },
  buttons: { flexDirection: 'row', gap: 12 },
  list: { borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  separator: { height: 1 },
  row: { flexDirection: 'row', padding: 16, gap: 12, alignItems: 'center' },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 18, fontWeight: '700' },
  rowContent: { flex: 1 },
  rowName: { fontSize: 16, fontWeight: '600' },
  rowDid: { fontSize: 12, fontFamily: 'monospace', marginTop: 2 },
});
