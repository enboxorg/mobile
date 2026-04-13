import { useCallback, useState } from 'react';
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
  const refreshIdentities = useAgentStore((s) => s.refreshIdentities);
  const agent = useAgentStore((s) => s.agent);
  const isInitializing = useAgentStore((s) => s.isInitializing);

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

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

  if (isInitializing || !agent) {
    return (
      <Screen contentContainerStyle={styles.centered}>
        <ActivityIndicator size="large" color={theme.colors.accent} />
        <Text style={[styles.loadingText, { color: theme.colors.textMuted }]}>
          Starting agent...
        </Text>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader title="Identities" />

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

      {identities.length > 0 && (
        <>
          <FlatList
            data={identities}
            keyExtractor={(item) => item.metadata.uri}
            scrollEnabled={false}
            renderItem={({ item }) => <IdentityRow identity={item} theme={theme} />}
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

function IdentityRow({ identity, theme }: { identity: any; theme: AppTheme }) {
  const didUri = identity.metadata?.uri ?? identity.did?.uri ?? 'Unknown DID';
  const displayName = identity.metadata?.name ?? 'Unnamed';

  return (
    <Pressable style={styles.row} accessibilityRole="button">
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
  empty: { borderRadius: 24, borderWidth: 1, borderStyle: 'dashed', padding: 24, gap: 12, alignItems: 'center' },
  emptyTitle: { fontSize: 18, fontWeight: '700' },
  emptyBody: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  card: { borderRadius: 24, borderWidth: 1, padding: 20, gap: 12 },
  cardTitle: { fontSize: 18, fontWeight: '700' },
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
