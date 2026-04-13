import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { useAppTheme } from '@/theme';

export function SearchScreen() {
  const theme = useAppTheme();
  const [query, setQuery] = useState('');

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.flex}
    >
      <Screen>
        <ScreenHeader
          title="Search"
          subtitle="Look up a decentralized identifier to view a public profile."
        />

        <TextInput
          accessibilityLabel="Search DID"
          accessibilityHint="Enter a decentralized identifier to look up"
          accessibilityRole="search"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="did:dht:..."
          placeholderTextColor={theme.colors.textMuted}
          returnKeyType="search"
          style={[
            styles.input,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
              color: theme.colors.text,
            },
          ]}
          value={query}
        />

        {query.length > 0 && !query.startsWith('did:') ? (
          <Text accessibilityRole="alert" style={[styles.hint, { color: theme.colors.warning }]}>
            DIDs typically start with &quot;did:&quot;
          </Text>
        ) : null}

        {query.length === 0 ? (
          <View style={[styles.emptyState, { borderColor: theme.colors.border }]}>
            <Text style={[styles.emptyTitle, { color: theme.colors.textMuted }]}>
              Enter a DID to search
            </Text>
            <Text style={[styles.emptyBody, { color: theme.colors.textMuted }]}>
              Results will show the public profile associated with the identifier.
            </Text>
          </View>
        ) : null}
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  input: {
    borderRadius: 16,
    borderWidth: 1,
    fontSize: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  hint: { fontSize: 13, lineHeight: 18 },
  emptyState: {
    borderRadius: 24,
    borderWidth: 1,
    borderStyle: 'dashed',
    padding: 24,
    gap: 8,
    alignItems: 'center',
  },
  emptyTitle: { fontSize: 16, fontWeight: '600' },
  emptyBody: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
});
