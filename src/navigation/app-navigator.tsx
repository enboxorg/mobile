import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useCallback, useEffect, useRef } from 'react';
import { ActivityIndicator, Alert, StyleSheet, View } from 'react-native';

import { BiometricSetupScreen } from '@/features/auth/screens/biometric-setup-screen';
import { BiometricUnavailableScreen } from '@/features/auth/screens/biometric-unavailable-screen';
import { BiometricUnlockScreen } from '@/features/auth/screens/biometric-unlock';
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

  // Manual "Lock wallet" (invoked from Settings) MUST match the
  // auto-lock hook's teardown ordering: flip the session flag AND
  // tear down the agent so `BiometricVault.lock()` zeroes
  // `_secretBytes` / `_rootSeed` / `_contentEncryptionKey` BEFORE the
  // next unlock (VAL-VAULT-020 / VAL-VAULT-021). Without the
  // `teardown()` call the previous agent + vault objects continued
  // holding fully-unlocked key material until GC — a heap snapshot
  // from "Lock wallet → app backgrounded" could still expose the root
  // entropy. The hook's auto-lock on `active → background|inactive`
  // is unchanged; this ensures the manual / settings path reaches
  // the same end state.
  const onManualLock = useCallback(() => {
    lock();
    useAgentStore.getState().teardown();
  }, [lock]);

  // SettingsScreen orchestrates the full reset flow internally —
  // `useAgentStore.getState().reset()` wipes the biometric secret,
  // the on-disk LevelDB, the in-memory agent, and the session store,
  // then triggers a fresh `useSessionStore.hydrate()` so the navigator
  // routes back to `Welcome`. No wrapper needed here (VAL-UX-036).
  const renderSettings = useCallback(
    () => <SettingsScreen onLock={onManualLock} />,
    [onManualLock],
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
  // `isPendingFirstBackup` is the DURABLE half of the backup gate —
  // see `PersistedSessionState.isPendingFirstBackup` for the VAL-VAULT-028
  // rationale. It is committed to SecureStorage the moment
  // `BiometricSetupScreen` lands a native secret and is only cleared
  // once the user confirms the mnemonic. OR-combined with the in-memory
  // `recoveryPhrase !== null` signal so a cold-restart or auto-lock
  // drop BEFORE backup confirmation re-routes to RecoveryPhrase.
  const isPendingFirstBackup = useSessionStore((s) => s.isPendingFirstBackup);
  const completeOnboarding = useSessionStore((s) => s.completeOnboarding);
  const commitSetupInitialized = useSessionStore(
    (s) => s.commitSetupInitialized,
  );
  const setPendingFirstBackup = useSessionStore(
    (s) => s.setPendingFirstBackup,
  );
  const unlockSession = useSessionStore((s) => s.unlockSession);

  // --- Agent store signals -----------------------------------------
  // `recoveryPhrase` is non-null only while a freshly-initialized
  // vault is pending the one-shot backup. Clearing it via
  // `clearRecoveryPhrase` advances the gate matrix past RecoveryPhrase.
  const recoveryPhrase = useAgentStore((s) => s.recoveryPhrase);
  const clearRecoveryPhrase = useAgentStore((s) => s.clearRecoveryPhrase);
  const resumePendingBackup = useAgentStore((s) => s.resumePendingBackup);

  // --- Wallet-connect deep-link signals -----------------------------
  const pendingWalletRequest = useWalletConnectStore((s) => s.pending);
  // Queued-error surface: if a deep link fails while the app is gated
  // (e.g. locked / restoring / unavailable) the store flips to
  // `{ phase: 'error', pending: null }`. Without this effect the
  // navigator would silently drop the failure once the gate clears.
  // We observe the phase / error tuple and, once the user lands on
  // `Main`, surface the message via `Alert.alert`, then clear the
  // store so the same error is not re-alerted after dismiss. See the
  // feature description `fix-walletconnect-queued-error-surfacing`.
  const walletConnectPhase = useWalletConnectStore((s) => s.phase);
  const walletConnectError = useWalletConnectStore((s) => s.error);
  const clearWalletConnect = useWalletConnectStore((s) => s.clear);

  // Gate matrix (VAL-UX-028).
  //
  // `pendingBackup` is the OR of two signals:
  //
  //   - `recoveryPhrase !== null` — the normal happy path: a mnemonic
  //     is sitting in JS memory waiting to be shown.
  //   - `isPendingFirstBackup` — the durable half that SURVIVES
  //     `teardown()` / cold kill / auto-lock. It is set the moment
  //     the native secret is provisioned and cleared only after the
  //     user confirms the backup. Without it, relaunch between
  //     "secret provisioned" and "phrase confirmed" would route
  //     straight to Main and strand the user with an un-backed-up
  //     wallet (VAL-VAULT-028).
  const route = getInitialRoute({
    biometricStatus,
    hasCompletedOnboarding,
    isLocked,
    vaultInitialized: hasIdentity,
    pendingBackup: recoveryPhrase !== null || isPendingFirstBackup,
  });

  // --- Handlers bound to each gate --------------------------------
  const handleSetupInitialized = useCallback(
    (_phrase: string) => {
      // The freshly-generated mnemonic already lives in the agent
      // store (`useAgentStore.recoveryPhrase`). We commit TWO facts
      // in a SINGLE atomic SecureStorage write via
      // `commitSetupInitialized()`:
      //
      //   - `hasIdentity = true` — the vault has been initialized, so
      //     next relaunch skips first-launch setup.
      //   - `isPendingFirstBackup = true` — the user has NOT confirmed
      //     the mnemonic yet. If the app backgrounds / is killed
      //     before confirmation, the navigator uses this durable flag
      //     (OR'd with `recoveryPhrase`) to re-route back to
      //     RecoveryPhrase on relaunch, where `resumePendingBackup()`
      //     can re-derive the mnemonic from the stored entropy
      //     (VAL-VAULT-028).
      //
      // A naive implementation that calls `setHasIdentity(true)` and
      // `setPendingFirstBackup(true)` separately would issue TWO
      // persists to the same `SESSION_KEY` payload and — because the
      // writes are fire-and-forget — could race: the write with
      // `{hasIdentity: false, isPendingFirstBackup: true}` landing
      // AFTER the write with `{hasIdentity: true, isPendingFirstBackup:
      // true}` would leave on-disk state `{hasIdentity: false, ...}`
      // even though the in-memory state is correct. A cold-kill after
      // the in-memory flip but before the losing write would then
      // misroute to BiometricSetup on relaunch. The atomic helper
      // collapses both into one `setSecureItem` call so no such
      // interleave is possible.
      // `void` marks a deliberately-unawaited fire-and-forget promise.
      // eslint-disable-next-line no-void
      void commitSetupInitialized();
    },
    [commitSetupInitialized],
  );

  const handlePhraseConfirmed = useCallback(() => {
    // Drop the one-shot mnemonic from JS memory + flip the session
    // into the unlocked state so the matrix advances to `Main`.
    //
    // Critically, also clear `isPendingFirstBackup` so a later
    // relaunch does NOT re-surface RecoveryPhrase. The persist is
    // fire-and-forget here because the navigator also flips
    // `isPendingFirstBackup` in-memory synchronously — the matrix
    // advances on the next render regardless of whether the on-disk
    // write has landed. On the pathological "kill between confirm
    // and persist" edge case, the user sees RecoveryPhrase again on
    // relaunch, enters `resumePendingBackup()` once more, and
    // re-confirms — annoying but not data-loss (VAL-VAULT-028).
    // `void` marks a deliberately-unawaited fire-and-forget promise.
    // eslint-disable-next-line no-void
    void setPendingFirstBackup(false);
    clearRecoveryPhrase();
    unlockSession();
  }, [clearRecoveryPhrase, setPendingFirstBackup, unlockSession]);

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

  // Queued wallet-connect error surfacing.
  //
  // The store can be in `phase === 'error'` with `pending === null`
  // when an incoming deep link failed before we had anything to
  // render (parse error, remote-fetch error, or a failure that
  // occurred while a biometric gate was in the way). We mustn't
  // silently swallow that — surface it via `Alert.alert` the moment
  // the user is on `Main`, and clear the store on dismiss so we do
  // not re-fire for the same error.
  const alertedErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (walletConnectPhase !== 'error') {
      alertedErrorRef.current = null;
      return;
    }
    if (route !== 'Main' || pendingWalletRequest || !walletConnectError) {
      return;
    }
    const token = walletConnectError;
    if (alertedErrorRef.current === token) return;
    alertedErrorRef.current = token;
    Alert.alert(
      'Connection request failed',
      walletConnectError,
      [{ text: 'Dismiss', onPress: () => clearWalletConnect() }],
      { cancelable: true, onDismiss: () => clearWalletConnect() },
    );
  }, [
    route,
    walletConnectPhase,
    walletConnectError,
    pendingWalletRequest,
    clearWalletConnect,
  ]);

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
                // Resume-pending-backup flow (VAL-VAULT-028). When the
                // in-memory `recoveryPhrase` is null but
                // `isPendingFirstBackup` forced us back here, the screen
                // surfaces a "Show recovery phrase" CTA that calls this
                // handler; the agent store re-seats the vault,
                // re-derives the mnemonic from the stored entropy, and
                // writes it into `recoveryPhrase` so the screen re-
                // renders with the words visible.
                onResumeBackup={
                  recoveryPhrase === null ? resumePendingBackup : undefined
                }
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
