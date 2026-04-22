/**
 * Tests for the biometric-first session store. Covers the core state
 * surface (hydrate, completeOnboarding, unlockSession, lock,
 * setHasIdentity, setBiometricStatus, reset). Biometric-status hydration
 * matrix is covered separately in
 * `src/features/session/__tests__/session-store.biometric-status.test.ts`.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nativeBiometric = require('@specs/NativeBiometricVault').default;

jest.mock('@/lib/storage/secure-storage', () => ({
  getSecureItem: jest.fn().mockResolvedValue(null),
  setSecureItem: jest.fn().mockResolvedValue(undefined),
  deleteSecureItem: jest.fn().mockResolvedValue(undefined),
}));

import {
  deleteSecureItem,
  getSecureItem,
  setSecureItem,
} from '@/lib/storage/secure-storage';
import { useSessionStore } from '@/features/session/session-store';

const mockedGetSecureItem = getSecureItem as jest.MockedFunction<
  typeof getSecureItem
>;
const mockedSetSecureItem = setSecureItem as jest.MockedFunction<
  typeof setSecureItem
>;
const mockedDeleteSecureItem = deleteSecureItem as jest.MockedFunction<
  typeof deleteSecureItem
>;

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetSecureItem.mockResolvedValue(null);
  mockedSetSecureItem.mockResolvedValue(undefined);
  mockedDeleteSecureItem.mockResolvedValue(undefined);
  nativeBiometric.hasSecret.mockResolvedValue(false);
  nativeBiometric.isBiometricAvailable.mockResolvedValue({
    available: true,
    enrolled: true,
    type: 'fingerprint',
  });
  useSessionStore.setState({
    isHydrated: false,
    hasCompletedOnboarding: false,
    hasIdentity: false,
    isLocked: true,
    biometricStatus: 'unknown',
  });
});

describe('useSessionStore', () => {
  describe('hydrate', () => {
    it('restores hasCompletedOnboarding/hasIdentity from secure storage', async () => {
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === 'session:state')
          return JSON.stringify({
            hasCompletedOnboarding: true,
            hasIdentity: true,
          });
        return null;
      });

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      expect(state.isHydrated).toBe(true);
      expect(state.hasCompletedOnboarding).toBe(true);
      expect(state.hasIdentity).toBe(true);
    });

    it('handles missing storage gracefully (fresh install)', async () => {
      await useSessionStore.getState().hydrate();
      const state = useSessionStore.getState();
      expect(state.isHydrated).toBe(true);
      expect(state.hasCompletedOnboarding).toBe(false);
      expect(state.hasIdentity).toBe(false);
    });

    it('handles corrupt storage gracefully', async () => {
      mockedGetSecureItem.mockResolvedValue('not-json');
      await useSessionStore.getState().hydrate();
      expect(useSessionStore.getState().isHydrated).toBe(true);
      expect(useSessionStore.getState().hasCompletedOnboarding).toBe(false);
    });
  });

  describe('completeOnboarding', () => {
    it('marks onboarding complete and persists the session payload', () => {
      useSessionStore.getState().completeOnboarding();
      expect(useSessionStore.getState().hasCompletedOnboarding).toBe(true);
      expect(mockedSetSecureItem).toHaveBeenCalledWith(
        'session:state',
        expect.stringContaining('"hasCompletedOnboarding":true'),
      );
    });
  });

  describe('setHasIdentity', () => {
    it('updates state and persists', () => {
      useSessionStore.getState().setHasIdentity(true);
      expect(useSessionStore.getState().hasIdentity).toBe(true);
      expect(mockedSetSecureItem).toHaveBeenCalledWith(
        'session:state',
        expect.stringContaining('"hasIdentity":true'),
      );
    });
  });

  describe('unlockSession / lock', () => {
    it('unlocks and re-locks the session', () => {
      useSessionStore.getState().unlockSession();
      expect(useSessionStore.getState().isLocked).toBe(false);
      useSessionStore.getState().lock();
      expect(useSessionStore.getState().isLocked).toBe(true);
    });
  });

  describe('hydrateRestored', () => {
    it('atomically sets all four session flags for a restored wallet', () => {
      // Simulate the pre-restore snapshot: invalidated biometric state
      // (the only pathway that lands on RecoveryRestoreScreen), locked
      // session, nothing on-disk yet.
      useSessionStore.setState({
        isHydrated: true,
        hasCompletedOnboarding: false,
        hasIdentity: false,
        isLocked: true,
        biometricStatus: 'invalidated',
      });

      useSessionStore.getState().hydrateRestored();

      const state = useSessionStore.getState();
      expect(state.biometricStatus).toBe('ready');
      expect(state.hasCompletedOnboarding).toBe(true);
      expect(state.hasIdentity).toBe(true);
      expect(state.isLocked).toBe(false);
    });

    it('persists the onboarding/identity snapshot through setSecureItem(SESSION_KEY, ...)', () => {
      useSessionStore.setState({
        hasCompletedOnboarding: false,
        hasIdentity: false,
      });

      useSessionStore.getState().hydrateRestored();

      // persistSession() writes the JSON-encoded snapshot to the
      // canonical `session:state` SecureStorage key. Without this write
      // a cold relaunch would rehydrate stale flags and misroute the
      // restored wallet.
      expect(mockedSetSecureItem).toHaveBeenCalledWith(
        'session:state',
        expect.stringContaining('"hasCompletedOnboarding":true'),
      );
      expect(mockedSetSecureItem).toHaveBeenCalledWith(
        'session:state',
        expect.stringContaining('"hasIdentity":true'),
      );
    });

    it('survives kill/relaunch simulation — hydrate() restores the flags written by hydrateRestored()', async () => {
      // 1. Commit a restored session — the helper writes to the mocked
      //    SecureStorage backend via setSecureItem.
      useSessionStore.getState().hydrateRestored();

      // Grab whatever payload got persisted to `session:state` so the
      // relaunch simulation can hand it back to hydrate(). This keeps
      // the assertion honest against the exact shape persistSession
      // chose to write (no hand-rolled fixture).
      const persistCall = mockedSetSecureItem.mock.calls.find(
        ([key]) => key === 'session:state',
      );
      expect(persistCall).toBeDefined();
      const persistedPayload = persistCall![1];

      // 2. Simulate a cold relaunch: a fresh process with default store
      //    state (nothing in memory) and the on-disk payload intact.
      useSessionStore.setState({
        isHydrated: false,
        hasCompletedOnboarding: false,
        hasIdentity: false,
        isLocked: true,
        biometricStatus: 'unknown',
      });
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === 'session:state') return persistedPayload;
        return null;
      });

      // 3. hydrate() re-reads the persisted snapshot and must recover
      //    the hasCompletedOnboarding/hasIdentity flags set by the
      //    restore commit. biometricStatus is recomputed from the
      //    native probe (enrolled+available → 'ready'); isLocked
      //    defaults to true so the navigator routes through
      //    BiometricUnlock → Main (not Welcome / BiometricSetup).
      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      expect(state.isHydrated).toBe(true);
      expect(state.hasCompletedOnboarding).toBe(true);
      expect(state.hasIdentity).toBe(true);
      expect(state.biometricStatus).toBe('ready');
    });
  });

  describe('reset', () => {
    it('clears persisted state and the biometric-state flag', async () => {
      useSessionStore.getState().completeOnboarding();
      useSessionStore.getState().setBiometricStatus('ready');
      await useSessionStore.getState().reset();

      const state = useSessionStore.getState();
      expect(state.hasCompletedOnboarding).toBe(false);
      expect(state.hasIdentity).toBe(false);
      expect(state.isLocked).toBe(true);
      expect(state.biometricStatus).toBe('unknown');

      const deletedKeys = mockedDeleteSecureItem.mock.calls.map(([k]) => k);
      expect(deletedKeys).toEqual(
        expect.arrayContaining([
          'session:state',
          'enbox:enbox.vault.biometric-state',
        ]),
      );
    });
  });
});
