import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useCallback } from 'react';

import { CreatePinScreen } from '@/features/auth/screens/create-pin-screen';
import { UnlockScreen } from '@/features/auth/screens/unlock-screen';
import { ConnectScreen } from '@/features/connect/screens/connect-screen';
import { IdentitiesScreen } from '@/features/identities/screens/identities-screen';
import { WelcomeScreen } from '@/features/onboarding/screens/welcome-screen';
import { SearchScreen } from '@/features/search/screens/search-screen';
import { SettingsScreen } from '@/features/settings/screens/settings-screen';
import { useSessionStore } from '@/features/session/session-store';
import { createNavigationTheme, useAppTheme } from '@/theme';

type RootStackParamList = {
  Welcome: undefined;
  CreatePin: undefined;
  Unlock: undefined;
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

  const renderSettings = useCallback(
    () => (
      <SettingsScreen
        onLock={lock}
        onReset={async () => {
          await reset();
        }}
      />
    ),
    [lock, reset],
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

  // Conditional screen rendering: React Navigation recommended pattern.
  // When state changes (e.g. lock() called), screens are swapped and
  // the navigator resets automatically — no imperative navigation needed.
  const showOnboarding = !hasCompletedOnboarding || !hasPinSet;
  const showUnlock = hasCompletedOnboarding && hasPinSet && isLocked;
  const showMain = hasCompletedOnboarding && hasPinSet && !isLocked;

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
                  return await unlock(pin);
                }}
              />
            )}
          </RootStack.Screen>
        )}
        {showMain && (
          <RootStack.Screen name="Main" component={MainTabs} />
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
