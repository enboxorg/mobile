import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useCallback } from 'react';

import { ConnectScreen } from '@/features/connect/screens/connect-screen';
import { WalletConnectRequestScreen } from '@/features/connect/screens/wallet-connect-request-screen';
import { WalletConnectScannerScreen } from '@/features/connect/screens/wallet-connect-scanner-screen';
import { IdentitiesScreen } from '@/features/identities/screens/identities-screen';
import { WelcomeScreen } from '@/features/onboarding/screens/welcome-screen';
import { SearchScreen } from '@/features/search/screens/search-screen';
import { SettingsScreen } from '@/features/settings/screens/settings-screen';
import { useAgentStore } from '@/lib/enbox/agent-store';
import { useWalletConnectStore } from '@/lib/enbox/wallet-connect-store';
import { useSessionStore } from '@/features/session/session-store';
import { createNavigationTheme, useAppTheme } from '@/theme';

type RootStackParamList = {
  Welcome: undefined;
  WalletConnectRequest: undefined;
  WalletConnectScanner: undefined;
  Main: undefined;
};

type TabParamList = {
  Identities: undefined;
  Search: undefined;
  Connect: undefined;
  Settings: undefined;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

function MainTabs() {
  const theme = useAppTheme();
  const lock = useSessionStore((s) => s.lock);
  const reset = useSessionStore((s) => s.reset);
  const teardownAgent = useAgentStore((s) => s.teardown);

  const handleReset = useCallback(async () => {
    teardownAgent();
    await reset();
  }, [teardownAgent, reset]);

  const renderSettings = useCallback(
    () => <SettingsScreen onLock={lock} onReset={handleReset} />,
    [lock, handleReset],
  );

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
        },
      }}
    >
      <Tab.Screen name="Identities" component={IdentitiesScreen} />
      <Tab.Screen name="Search" component={SearchScreen} />
      <Tab.Screen name="Connect" component={ConnectScreen} />
      <Tab.Screen name="Settings" children={renderSettings} />
    </Tab.Navigator>
  );
}

export function AppNavigator() {
  const theme = useAppTheme();
  const hasCompletedOnboarding = useSessionStore(
    (s) => s.hasCompletedOnboarding,
  );
  const completeOnboarding = useSessionStore((s) => s.completeOnboarding);
  const pendingWalletRequest = useWalletConnectStore((s) => s.pending);

  // Biometric-first navigation: the dedicated biometric setup / unlock /
  // unavailable / recovery screens are added by subsequent features in
  // the onboarding-ux milestone. Until those land, the navigator
  // transitions Welcome → Main as soon as `hasCompletedOnboarding` flips
  // so the existing main wallet surface remains reachable.
  const showOnboarding = !hasCompletedOnboarding;
  const showMain = hasCompletedOnboarding;
  const showWalletConnectRequest = showMain && !!pendingWalletRequest;

  return (
    <NavigationContainer theme={createNavigationTheme(theme)}>
      <RootStack.Navigator
        screenOptions={{ headerShown: false, gestureEnabled: false }}
      >
        {showOnboarding && (
          <RootStack.Screen name="Welcome">
            {() => <WelcomeScreen onStart={completeOnboarding} />}
          </RootStack.Screen>
        )}
        {showMain && showWalletConnectRequest && (
          <RootStack.Screen
            name="WalletConnectRequest"
            component={WalletConnectRequestScreen}
          />
        )}
        {showMain && !showWalletConnectRequest && (
          <>
            <RootStack.Screen name="Main" component={MainTabs} />
            <RootStack.Screen
              name="WalletConnectScanner"
              component={WalletConnectScannerScreen}
            />
          </>
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
