import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useCallback } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { BiometricSetupScreen } from '@/features/auth/screens/biometric-setup-screen';
import { BiometricUnavailableScreen } from '@/features/auth/screens/biometric-unavailable-screen';
import { BiometricUnlockScreen } from '@/features/auth/screens/biometric-unlock-screen';
import { RecoveryPhraseScreen } from '@/features/auth/screens/recovery-phrase-screen';
import { RecoveryRestoreScreen } from '@/features/auth/screens/recovery-restore-screen';
import { ConnectScreen } from '@/features/connect/screens/connect-screen';
import { WalletConnectRequestScreen } from '@/features/connect/screens/wallet-connect-request-screen';
import { WalletConnectScannerScreen } from '@/features/connect/screens/wallet-connect-scanner-screen';
import { IdentitiesScreen } from '@/features/identities/screens/identities-screen';
import { WelcomeScreen } from '@/features/onboarding/screens/welcome-screen';
import { SearchScreen } from '@/features/search/screens/search-screen';
import { getInitialRoute } from '@/features/session/get-initial-route';
import { useSessionStore } from '@/features/session/session-store';
import { SettingsScreen } from '@/features/settings/screens/settings-screen';
import { useAgentStore } from '@/lib/enbox/agent-store';
import { useWalletConnectStore } from '@/lib/enbox/wallet-connect-store';
import { createNavigationTheme, useAppTheme } from '@/theme';

/**
 * Canonical root stack param list. The biometric-first refactor
 * removes all PIN-era routes — `CreatePin` and `Unlock` are NOT
 * present here, and no code path in the navigator imports them.
 * (VAL-UX-029)
 */
type RootStackParamList = {
  Loading: undefined;
  Welcome: undefined;
  BiometricUnavailable: undefined;
  BiometricSetup: undefined;
  RecoveryPhrase: undefined;
  BiometricUnlock: undefined;
  RecoveryRestore: undefined;
  Main: undefined;
  WalletConnectRequest: undefined;
  WalletConnectScanner: undefined;
};

type TabParamList = {
  Identities: undefined;
  Search: undefined;
  Connect: undefined;
  Settings: undefined;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

/**
 * Render-only placeholder shown while `useSessionStore.hydrate()` is
 * still in flight. Keeping the tree rendered (rather than returning
 * `null`) keeps React Navigation from unmounting its container on
 * every hydrate cycle.
 */
function LoadingScreen() {
  const theme = useAppTheme();
  return (
    <View
      accessibilityLabel="Loading"
      style={[
        styles.loading,
        { backgroundColor: theme.colors.background },
      ]}
      testID="app-navigator-loading"
    >
      <ActivityIndicator color={theme.colors.accent} size="large" />
    </View>
  );
}

function MainTabs() {
  const theme = useAppTheme();
  const lock = useSessionStore((s) => s.lock);

  // SettingsScreen orchestrates the full reset flow internally —
  // `useAgentStore.getState().reset()` wipes the biometric secret,
  // the on-disk LevelDB, the in-memory agent, and the session store,
  // then triggers a fresh `useSessionStore.hydrate()` so the navigator
  // routes back to `Welcome`. No wrapper needed here (VAL-UX-036).
  const renderSettings = useCallback(
    () => <SettingsScreen onLock={lock} />,
    [lock],
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

  // --- Session store signals ---------------------------------------
  const hasCompletedOnboarding = useSessionStore(
    (s) => s.hasCompletedOnboarding,
  );
  const hasIdentity = useSessionStore((s) => s.hasIdentity);
  const isLocked = useSessionStore((s) => s.isLocked);
  const biometricStatus = useSessionStore((s) => s.biometricStatus);
  const completeOnboarding = useSessionStore((s) => s.completeOnboarding);
  const setHasIdentity = useSessionStore((s) => s.setHasIdentity);
  const unlockSession = useSessionStore((s) => s.unlockSession);

  // --- Agent store signals -----------------------------------------
  // `recoveryPhrase` is non-null only while a freshly-initialized
  // vault is pending the one-shot backup. Clearing it via
  // `clearRecoveryPhrase` advances the gate matrix past RecoveryPhrase.
  const recoveryPhrase = useAgentStore((s) => s.recoveryPhrase);
  const clearRecoveryPhrase = useAgentStore((s) => s.clearRecoveryPhrase);

  // --- Wallet-connect deep-link signals -----------------------------
  const pendingWalletRequest = useWalletConnectStore((s) => s.pending);

  // Gate matrix (VAL-UX-028).
  const route = getInitialRoute({
    biometricStatus,
    hasCompletedOnboarding,
    isLocked,
    vaultInitialized: hasIdentity,
    pendingBackup: recoveryPhrase !== null,
  });

  // --- Handlers bound to each gate --------------------------------
  const handleSetupInitialized = useCallback(
    (_phrase: string) => {
      // The freshly-generated mnemonic already lives in the agent
      // store (`useAgentStore.recoveryPhrase`). We only need to
      // persist that the vault has been initialized so the matrix
      // can advance — on next relaunch we'll route straight to
      // `BiometricUnlock` instead of re-running first-launch setup.
      setHasIdentity(true);
    },
    [setHasIdentity],
  );

  const handlePhraseConfirmed = useCallback(() => {
    // Drop the one-shot mnemonic from JS memory + flip the session
    // into the unlocked state so the matrix advances to `Main`.
    clearRecoveryPhrase();
    unlockSession();
  }, [clearRecoveryPhrase, unlockSession]);

  const handleUnlocked = useCallback(() => {
    unlockSession();
  }, [unlockSession]);

  const handleRestored = useCallback(() => {
    // `RecoveryRestoreScreen` already atomically hydrates session
    // state (`biometricStatus: 'ready'`, `hasCompletedOnboarding:
    // true`, `hasIdentity: true`, `isLocked: false`) on success —
    // nothing further to do here. Kept as an explicit no-op so
    // future navigator-level side effects (e.g. analytics, focus
    // Main on success) have a stable attach point.
  }, []);

  // Deep-link surfacing is gated by the navigation matrix:
  // `WalletConnectRequest` only renders once the user has cleared
  // every biometric gate and is on `Main` (VAL-UX-050).
  const showWalletConnectRequest =
    route === 'Main' && !!pendingWalletRequest;

  return (
    <NavigationContainer theme={createNavigationTheme(theme)}>
      <RootStack.Navigator
        screenOptions={{ headerShown: false, gestureEnabled: false }}
      >
        {route === 'Loading' && (
          <RootStack.Screen name="Loading" component={LoadingScreen} />
        )}

        {route === 'BiometricUnavailable' && (
          <RootStack.Screen
            name="BiometricUnavailable"
            component={BiometricUnavailableScreen}
          />
        )}

        {route === 'RecoveryRestore' && (
          <RootStack.Screen name="RecoveryRestore">
            {({ navigation }) => (
              <RecoveryRestoreScreen
                navigation={navigation}
                onRestored={handleRestored}
              />
            )}
          </RootStack.Screen>
        )}

        {route === 'Welcome' && (
          <RootStack.Screen name="Welcome">
            {() => <WelcomeScreen onStart={completeOnboarding} />}
          </RootStack.Screen>
        )}

        {route === 'BiometricSetup' && (
          <RootStack.Screen name="BiometricSetup">
            {() => (
              <BiometricSetupScreen
                onInitialized={handleSetupInitialized}
              />
            )}
          </RootStack.Screen>
        )}

        {route === 'RecoveryPhrase' && (
          <RootStack.Screen name="RecoveryPhrase">
            {({ navigation }) => (
              <RecoveryPhraseScreen
                mnemonic={recoveryPhrase ?? ''}
                navigation={navigation}
                onConfirm={handlePhraseConfirmed}
              />
            )}
          </RootStack.Screen>
        )}

        {route === 'BiometricUnlock' && (
          <RootStack.Screen name="BiometricUnlock">
            {() => <BiometricUnlockScreen onUnlock={handleUnlocked} />}
          </RootStack.Screen>
        )}

        {route === 'Main' && showWalletConnectRequest && (
          <RootStack.Screen
            name="WalletConnectRequest"
            component={WalletConnectRequestScreen}
          />
        )}

        {route === 'Main' && !showWalletConnectRequest && (
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

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
