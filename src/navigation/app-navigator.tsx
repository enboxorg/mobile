import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useCallback } from 'react';

import { CreatePinScreen } from '@/features/auth/screens/create-pin-screen';
import { UnlockScreen } from '@/features/auth/screens/unlock-screen';
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
  CreatePin: undefined;
  Unlock: undefined;
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
  const hasCompletedOnboarding = useSessionStore((s) => s.hasCompletedOnboarding);
  const hasPinSet = useSessionStore((s) => s.hasPinSet);
  const isLocked = useSessionStore((s) => s.isLocked);
  const completeOnboarding = useSessionStore((s) => s.completeOnboarding);
  const createPin = useSessionStore((s) => s.createPin);
  const unlock = useSessionStore((s) => s.unlock);
  const unlockSession = useSessionStore((s) => s.unlockSession);
  const lock = useSessionStore((s) => s.lock);
  const teardownAgent = useAgentStore((s) => s.teardown);
  const initializeFirstLaunch = useAgentStore((s) => s.initializeFirstLaunch);
  const unlockAgent = useAgentStore((s) => s.unlockAgent);
  const pendingWalletRequest = useWalletConnectStore((s) => s.pending);

  const showOnboarding = !hasCompletedOnboarding || !hasPinSet;
  const showUnlock = hasCompletedOnboarding && hasPinSet && isLocked;
  const showMain = hasCompletedOnboarding && hasPinSet && !isLocked;
  const showWalletConnectRequest = showMain && !!pendingWalletRequest;

  return (
    <NavigationContainer theme={createNavigationTheme(theme)}>
      <RootStack.Navigator screenOptions={{ headerShown: false, gestureEnabled: false }}>
        {showOnboarding && (
          <>
            {!hasCompletedOnboarding && (
              <RootStack.Screen name="Welcome">
                {() => <WelcomeScreen onStart={completeOnboarding} />}
              </RootStack.Screen>
            )}
            <RootStack.Screen name="CreatePin">
              {() => (
                <CreatePinScreen
                  onComplete={async (pin) => {
                    await createPin(pin);
                    await initializeFirstLaunch(pin);
                    unlockSession();
                  }}
                />
              )}
            </RootStack.Screen>
          </>
        )}
        {showUnlock && (
          <RootStack.Screen name="Unlock">
            {() => (
                <UnlockScreen
                  onUnlock={async (pin) => {
                    // 1. Verify the PIN hash
                    const valid = await unlock(pin);
                    if (!valid) return false;
                    // 2. Unlock the agent vault with the PIN as password
                    try {
                      await unlockAgent(pin);
                      unlockSession();
                      return true;
                    } catch {
                      // Vault unlock failed — re-lock the session
                      lock();
                      teardownAgent();
                      throw new Error('Wallet vault could not be opened with this PIN.');
                    }
                  }}
                />
              )}
            </RootStack.Screen>
        )}
        {showMain && showWalletConnectRequest && (
          <RootStack.Screen name="WalletConnectRequest" component={WalletConnectRequestScreen} />
        )}
        {showMain && !showWalletConnectRequest && (
          <>
            <RootStack.Screen name="Main" component={MainTabs} />
            <RootStack.Screen name="WalletConnectScanner" component={WalletConnectScannerScreen} />
          </>
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
