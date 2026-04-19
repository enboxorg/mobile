import { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';

import { ErrorBoundary } from '@/components/ui/error-boundary';
import { useAutoLock } from '@/hooks/use-auto-lock';
import { useWalletConnectLinking } from '@/hooks/use-wallet-connect-linking';
import { AppNavigator } from '@/navigation/app-navigator';
import { AppProviders } from '@/providers/app-providers';
import { useSessionStore } from '@/features/session/session-store';

function AppContent() {
  const hydrate = useSessionStore((s) => s.hydrate);
  const isHydrated = useSessionStore((s) => s.isHydrated);
  const [ready, setReady] = useState(false);

  useAutoLock();
  useWalletConnectLinking();

  useEffect(() => {
    hydrate().finally(() => setReady(true));
  }, [hydrate]);

  if (!ready || !isHydrated) {
    return <View style={styles.loading} />;
  }

  return <AppNavigator />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppProviders>
        <AppContent />
      </AppProviders>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: '#0B1020' },
});
