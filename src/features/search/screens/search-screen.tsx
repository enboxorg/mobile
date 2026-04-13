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

import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { useAgentStore } from '@/lib/enbox/agent-store';
import { useAppTheme } from '@/theme';

interface ResolveResult {
  didUri: string;
  document: any;
  error?: string;
}

export function SearchScreen() {
  const theme = useAppTheme();
  const agent = useAgentStore((s) => s.agent);
  const [query, setQuery] = useState('');
  const [resolving, setResolving] = useState(false);
  const [result, setResult] = useState<ResolveResult | null>(null);

  const handleResolve = useCallback(async () => {
    if (!query.trim() || !agent || resolving) return;

    setResolving(true);
    setResult(null);

    try {
      const resolution = await agent.did.resolve(query.trim());

      if (resolution.didResolutionMetadata.error) {
        setResult({
          didUri: query.trim(),
          document: null,
          error: resolution.didResolutionMetadata.errorMessage
            ?? resolution.didResolutionMetadata.error,
        });
      } else {
        setResult({
          didUri: query.trim(),
          document: resolution.didDocument,
        });
      }
    } catch (err) {
      setResult({
        didUri: query.trim(),
        document: null,
        error: err instanceof Error ? err.message : 'Resolution failed',
      });
    } finally {
      setResolving(false);
    }
  }, [query, agent, resolving]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.flex}
    >
      <Screen>
        <ScreenHeader
          title="Search"
          subtitle="Look up a decentralized identifier to view its public document."
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

        {result?.document && (
          <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
            <Text style={[styles.cardTitle, { color: theme.colors.success }]}>Resolved</Text>
            <Text style={[styles.didUri, { color: theme.colors.accent }]} selectable>{result.didUri}</Text>

            {result.document.service?.length > 0 && (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>Services</Text>
                {result.document.service.map((svc: any, i: number) => (
                  <View key={i} style={styles.serviceRow}>
                    <Text style={[styles.serviceType, { color: theme.colors.text }]}>{svc.type}</Text>
                    <Text style={[styles.serviceEndpoint, { color: theme.colors.textMuted }]} numberOfLines={1}>
                      {Array.isArray(svc.serviceEndpoint) ? svc.serviceEndpoint[0] : svc.serviceEndpoint}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {result.document.verificationMethod?.length > 0 && (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: theme.colors.textMuted }]}>
                  Verification methods ({result.document.verificationMethod.length})
                </Text>
                {result.document.verificationMethod.map((vm: any, i: number) => (
                  <Text key={i} style={[styles.vmId, { color: theme.colors.text }]} numberOfLines={1}>
                    {vm.id} ({vm.type})
                  </Text>
                ))}
              </View>
            )}
          </View>
        )}

        {!result && !resolving && query.length === 0 && (
          <View style={[styles.emptyState, { borderColor: theme.colors.border }]}>
            <Text style={[styles.emptyTitle, { color: theme.colors.textMuted }]}>Enter a DID to search</Text>
            <Text style={[styles.emptyBody, { color: theme.colors.textMuted }]}>
              Results will show the public DID document including services and verification methods.
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
