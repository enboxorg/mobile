import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Enbox } from '@enbox/api';
import { ProfileDefinition } from '@enbox/protocols';

import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { useAppTheme } from '@/theme';

interface ResolveResult {
  didUri: string;
  profile: {
    displayName: string;
    tagline?: string;
    bio?: string;
  } | null;
  error?: string;
}

let anonymousEnbox: ReturnType<typeof Enbox.anonymous> | undefined;

function getAnonymousEnbox() {
  if (!anonymousEnbox) anonymousEnbox = Enbox.anonymous();
  return anonymousEnbox;
}

async function fetchPublicProfile(did: string): Promise<ResolveResult['profile']> {
  const { dwn } = getAnonymousEnbox();
  const { records } = await dwn.records.query({
    from: did,
    filter: {
      protocol: ProfileDefinition.protocol,
      protocolPath: 'profile',
    },
  });

  if (records.length === 0) {
    return { displayName: '' };
  }

  const data = await records[0].data.json() as Record<string, string | undefined>;
  return {
    displayName: data.displayName ?? '',
    tagline: data.tagline,
    bio: data.bio,
  };
}

export function SearchScreen() {
  const theme = useAppTheme();
  const [query, setQuery] = useState('');
  const [resolving, setResolving] = useState(false);
  const [result, setResult] = useState<ResolveResult | null>(null);

  const handleResolve = useCallback(async () => {
    if (!query.trim() || resolving) return;

    setResolving(true);
    setResult(null);

    try {
      const did = query.trim();
      const profile = await fetchPublicProfile(did);
      setResult({ didUri: did, profile });
    } catch (err) {
      setResult({
        didUri: query.trim(),
        profile: null,
        error: err instanceof Error ? err.message : 'Resolution failed',
      });
    } finally {
      setResolving(false);
    }
  }, [query, resolving]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.flex}
    >
      <Screen>
        <ScreenHeader
          title="Search"
          subtitle="Look up a decentralized identifier to view its public profile."
        />

        <View style={styles.searchRow}>
          <TextInput
            accessibilityLabel="Search DID"
            accessibilityHint="Enter a decentralized identifier to look up"
            accessibilityRole="search"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setQuery}
            onSubmitEditing={handleResolve}
            placeholder="did:dht:..."
            placeholderTextColor={theme.colors.textMuted}
            returnKeyType="search"
            style={[styles.input, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border, color: theme.colors.text }]}
            value={query}
          />
          <AppButton
            label="Resolve"
            disabled={!query.trim().startsWith('did:') || resolving}
            onPress={handleResolve}
          />
        </View>

        {resolving && (
          <View style={styles.centered}>
            <ActivityIndicator size="small" color={theme.colors.accent} />
            <Text style={[styles.resolvingText, { color: theme.colors.textMuted }]}>Resolving...</Text>
          </View>
        )}

        {result?.error && (
          <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
            <Text style={[styles.cardTitle, { color: theme.colors.warning }]}>Resolution failed</Text>
            <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}>{result.error}</Text>
          </View>
        )}

        {result?.profile && (
          <View
            style={[
              styles.card,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
            ]}
          >
            <Text style={[styles.cardTitle, { color: theme.colors.success }]}>Public profile</Text>
            <Text style={[styles.didUri, { color: theme.colors.accent }]} selectable>{result.didUri}</Text>

            <Text style={[styles.profileName, { color: theme.colors.text }]}>
              {result.profile.displayName || 'Unnamed identity'}
            </Text>
            {result.profile.tagline ? (
              <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}>
                {result.profile.tagline}
              </Text>
            ) : null}
            {result.profile.bio ? (
              <Text style={[styles.cardBody, { color: theme.colors.textMuted }]}>
                {result.profile.bio}
              </Text>
            ) : null}
          </View>
        )}

        {!result && !resolving && query.length === 0 && (
          <View style={[styles.emptyState, { borderColor: theme.colors.border }]}>
            <Text style={[styles.emptyTitle, { color: theme.colors.textMuted }]}>Enter a DID to search</Text>
            <Text style={[styles.emptyBody, { color: theme.colors.textMuted }]}>
              Results will show public profile data published to the DID&apos;s DWN.
            </Text>
          </View>
        )}
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  searchRow: { gap: 10 },
  input: { borderRadius: 16, borderWidth: 1, fontSize: 16, paddingHorizontal: 16, paddingVertical: 14 },
  centered: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', paddingVertical: 16 },
  resolvingText: { fontSize: 14 },
  card: { borderRadius: 24, borderWidth: 1, padding: 20, gap: 10 },
  cardTitle: { fontSize: 18, fontWeight: '700' },
  cardBody: { fontSize: 15, lineHeight: 22 },
  profileName: { fontSize: 20, fontWeight: '700' },
  didUri: { fontSize: 13, fontFamily: 'monospace' },
  section: { gap: 6, marginTop: 4 },
  sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  serviceRow: { gap: 2 },
  serviceType: { fontSize: 14, fontWeight: '600' },
  serviceEndpoint: { fontSize: 12, fontFamily: 'monospace' },
  vmId: { fontSize: 12, fontFamily: 'monospace' },
  emptyState: { borderRadius: 24, borderWidth: 1, borderStyle: 'dashed', padding: 24, gap: 8, alignItems: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '600' },
  emptyBody: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
});
