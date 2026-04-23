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

    it('awaits setSecureItem before resolving (cold-kill durability race fix)', async () => {
      // Hold setSecureItem on a deferred promise so we can observe
      // whether hydrateRestored resolves before the SecureStorage
      // write commits. Prior to the fix, the helper fired the
      // persistSession call without awaiting, so a cold kill landing
      // in the window between the in-memory setState and the
      // on-disk commit could rehydrate stale flags on relaunch.
      let resolveWrite: (() => void) | undefined;
      const deferredWrite = new Promise<void>((resolve) => {
        resolveWrite = () => resolve();
      });
      mockedSetSecureItem.mockImplementationOnce(() => deferredWrite);

      let resolved = false;
      const hydratePromise = useSessionStore
        .getState()
        .hydrateRestored()
        .then(() => {
          resolved = true;
        });

      // Flush microtasks a handful of times. hydrateRestored MUST NOT
      // resolve yet because the underlying setSecureItem write is still
      // pending on the deferred promise above.
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      expect(resolved).toBe(false);

      // setSecureItem was invoked synchronously inside hydrateRestored
      // (the await chain is on the returned promise, not on the
      // invocation itself).
      expect(mockedSetSecureItem).toHaveBeenCalledWith(
        'session:state',
        expect.stringContaining('"hasCompletedOnboarding":true'),
      );

      // Commit the deferred write; hydrateRestored's awaited promise
      // should now resolve.
      resolveWrite?.();
      await hydratePromise;
      expect(resolved).toBe(true);
    });

    it('rejects with the underlying error when setSecureItem fails (persistence-failure propagation)', async () => {
      // Regression guard: `persistSession` swallows SecureStorage
      // rejections so fire-and-forget callers (completeOnboarding,
      // setHasIdentity) stay rejection-safe. `hydrateRestored` MUST
      // opt OUT of that swallow so `RecoveryRestoreScreen` can render
      // a retry alert on a silent persistence failure instead of
      // navigating the user to Main with an in-memory session that a
      // cold relaunch would discard.
      const persistError = new Error('secure storage unavailable');
      mockedSetSecureItem.mockImplementationOnce(() =>
        Promise.reject(persistError),
      );

      await expect(
        useSessionStore.getState().hydrateRestored(),
      ).rejects.toBe(persistError);

      // setSecureItem was invoked with the SESSION_KEY payload — the
      // rejection path MUST still have attempted the write.
      expect(mockedSetSecureItem).toHaveBeenCalledWith(
        'session:state',
        expect.stringContaining('"hasCompletedOnboarding":true'),
      );
    });

    it('leaves persistSession (non-throwing) intact for fire-and-forget callers', async () => {
      // Guards against a regression where the fix for hydrateRestored
      // accidentally propagates SecureStorage failures through
      // `completeOnboarding` / `setHasIdentity` as well. Those
      // callers do NOT await the persist call — propagating the
      // rejection would surface as an UnhandledPromiseRejection and
      // crash dev builds / fail tests.
      const warnSpy = jest
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      try {
        mockedSetSecureItem.mockImplementationOnce(() =>
          Promise.reject(new Error('secure storage unavailable')),
        );

        expect(() =>
          useSessionStore.getState().completeOnboarding(),
        ).not.toThrow();

        // Let the rejected persist promise settle without causing an
        // unhandled rejection.
        await Promise.resolve();
        await Promise.resolve();

        mockedSetSecureItem.mockImplementationOnce(() =>
          Promise.reject(new Error('secure storage unavailable')),
        );
        expect(() =>
          useSessionStore.getState().setHasIdentity(true),
        ).not.toThrow();

        await Promise.resolve();
        await Promise.resolve();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('survives kill/relaunch simulation — hydrate() restores the flags written by hydrateRestored()', async () => {
      // 1. Commit a restored session — the helper writes to the mocked
      //    SecureStorage backend via setSecureItem. Await so the
      //    SecureStorage commit completes before we simulate relaunch.
      await useSessionStore.getState().hydrateRestored();

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
