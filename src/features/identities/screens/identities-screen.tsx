import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { useAppTheme } from '@/theme';

export function IdentitiesScreen() {
  const theme = useAppTheme();

  return (
    <Screen>
      <ScreenHeader title="Identities" />

      <View style={[styles.empty, { borderColor: theme.colors.border }]}>
        <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>No identities yet</Text>
        <Text style={[styles.emptyBody, { color: theme.colors.textMuted }]}>
          Create your first decentralized identity to start managing profiles, permissions, and connections.
        </Text>
        <AppButton label="Create identity" disabled onPress={() => {}} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  empty: {
    borderRadius: 24,
    borderWidth: 1,
    borderStyle: 'dashed',
    padding: 24,
    gap: 12,
    alignItems: 'center',
  },
  emptyTitle: { fontSize: 18, fontWeight: '700' },
  emptyBody: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
});
