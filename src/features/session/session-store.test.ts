/**
 * Tests for the biometric-first session store. Covers the core state
 * surface (hydrate, completeOnboarding, unlockSession, lock,
 * setHasIdentity, setBiometricStatus, reset). Biometric-status hydration
 * matrix is covered separately in
 * `src/features/session/__tests__/session-store.biometric-status.test.ts`.
 */

 
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
    it('atomically sets all four session flags for a restored wallet once persist resolves', async () => {
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

      await useSessionStore.getState().hydrateRestored();

      const state = useSessionStore.getState();
      expect(state.biometricStatus).toBe('ready');
      expect(state.hasCompletedOnboarding).toBe(true);
      expect(state.hasIdentity).toBe(true);
      expect(state.isLocked).toBe(false);
    });

    it('persists the onboarding/identity snapshot through setSecureItem(SESSION_KEY, ...)', async () => {
      useSessionStore.setState({
        hasCompletedOnboarding: false,
        hasIdentity: false,
      });

      await useSessionStore.getState().hydrateRestored();

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

    it('does NOT flip the route-driving flags until setSecureItem has committed (persist-before-flip ordering)', async () => {
      // Seed the pre-restore snapshot that the navigator is currently
      // observing: biometricStatus='invalidated', isLocked=true,
      // hasCompletedOnboarding/hasIdentity=false. AppNavigator routes
      // declaratively from these four flags, so any flip before the
      // SecureStorage commit would trigger a re-render out of
      // RecoveryRestore — a cold kill landing in the gap between the
      // flip and the on-disk commit would rehydrate stale flags on
      // relaunch and misroute the restored wallet.
      useSessionStore.setState({
        isHydrated: true,
        hasCompletedOnboarding: false,
        hasIdentity: false,
        isLocked: true,
        biometricStatus: 'invalidated',
      });

      // Hold setSecureItem on a deferred promise so we can observe
      // the store state across the await boundary.
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
      // resolve yet because the underlying setSecureItem write is
      // still pending on the deferred promise above.
      for (let i = 0; i < 5; i += 1) {
         
        await Promise.resolve();
      }
      expect(resolved).toBe(false);

      // setSecureItem was invoked synchronously inside hydrateRestored
      // (the await chain is on the returned promise, not on the
      // invocation itself) — the write has been ATTEMPTED.
      expect(mockedSetSecureItem).toHaveBeenCalledWith(
        'session:state',
        expect.stringContaining('"hasCompletedOnboarding":true'),
      );

      // Core durability assertion: while the SecureStorage commit is
      // still in flight, the route-driving flags MUST still reflect
      // the pre-call snapshot. A cold kill landing here would leave
      // the navigator exactly where the user was (RecoveryRestore),
      // matching the not-yet-written on-disk state.
      const midFlight = useSessionStore.getState();
      expect(midFlight.biometricStatus).toBe('invalidated');
      expect(midFlight.isLocked).toBe(true);
      expect(midFlight.hasCompletedOnboarding).toBe(false);
      expect(midFlight.hasIdentity).toBe(false);

      // Commit the deferred write; hydrateRestored's awaited promise
      // now continues past the `await persistSessionOrThrow` and
      // flips the four flags in a single setState.
      resolveWrite?.();
      await hydratePromise;
      expect(resolved).toBe(true);

      const afterCommit = useSessionStore.getState();
      expect(afterCommit.biometricStatus).toBe('ready');
      expect(afterCommit.isLocked).toBe(false);
      expect(afterCommit.hasCompletedOnboarding).toBe(true);
      expect(afterCommit.hasIdentity).toBe(true);
    });

    it('rejects with the underlying error and leaves the pre-call snapshot intact when setSecureItem fails', async () => {
      // Regression guard: `persistSession` swallows SecureStorage
      // rejections so fire-and-forget callers (completeOnboarding,
      // setHasIdentity) stay rejection-safe. `hydrateRestored` MUST
      // opt OUT of that swallow so `RecoveryRestoreScreen` can render
      // a retry alert on a silent persistence failure instead of
      // navigating the user to Main with an in-memory session that a
      // cold relaunch would discard.
      //
      // Additionally, with persist-before-flip ordering, the route-
      // driving flags MUST NOT change at all on the rejection path:
      // no partial flip visible to the navigator, nothing for a cold
      // kill to misread on relaunch.
      useSessionStore.setState({
        isHydrated: true,
        hasCompletedOnboarding: false,
        hasIdentity: false,
        isLocked: true,
        biometricStatus: 'invalidated',
      });

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

      // Post-reject: every route-driving flag still matches the
      // pre-call snapshot. No visible partial flip to the navigator.
      const state = useSessionStore.getState();
      expect(state.biometricStatus).toBe('invalidated');
      expect(state.isLocked).toBe(true);
      expect(state.hasCompletedOnboarding).toBe(false);
      expect(state.hasIdentity).toBe(false);
    });

    it('leaves persistSession (non-throwing) intact for fire-and-forget callers', async () => {
      // Guards against a regression where the current implementation for hydrateRestored
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
      //    biometric-unlock gate → Main (not Welcome / BiometricSetup).
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
      expect(state.isPendingFirstBackup).toBe(false);

      const deletedKeys = mockedDeleteSecureItem.mock.calls.map(([k]) => k);
      expect(deletedKeys).toEqual(
        expect.arrayContaining([
          'session:state',
          'enbox:enbox.vault.biometric-state',
        ]),
      );
    });

    it('clears the vault INITIALIZED sentinel so a subsequent hydrate does not see a stale orphan-detection signal', async () => {
      // `hydrate()` uses `enbox:enbox.vault.initialized` as an
      // orphan-detection signal, so reset must clear the same key. That
      // prevents a session-store reset → next hydrate cycle from
      // misrouting a fresh-install user via a stale orphan-promotion signal.
      useSessionStore.getState().completeOnboarding();
      useSessionStore.getState().setBiometricStatus('ready');

      await useSessionStore.getState().reset();

      const deletedKeys = mockedDeleteSecureItem.mock.calls.map(([k]) => k);
      expect(deletedKeys).toEqual(
        expect.arrayContaining([
          'session:state',
          'enbox:enbox.vault.biometric-state',
          'enbox:enbox.vault.initialized',
        ]),
      );
    });

    it('subsequent hydrate after reset does NOT promote orphan when a stale INITIALIZED key WOULD have been left behind (end-to-end regression)', async () => {
      // End-to-end: the order (initialize → reset → hydrate) on a SecureStorage backend
      // that keeps the deleted ``session:state`` and biometric-state
      // keys cleanly cleared but happens to retain the
      // INITIALIZED key would mis-promote the user as an orphan.
      // We simulate the current behaviour: the test mock observes
      // the reset call's delete of all three keys, and the next
      // hydrate (with all three keys absent) routes as fresh-install.
      const persistedKeys = new Map<string, string>();
      mockedGetSecureItem.mockImplementation(async (key) => persistedKeys.get(key) ?? null);
      mockedSetSecureItem.mockImplementation(async (key, value) => {
        persistedKeys.set(key, value);
      });
      mockedDeleteSecureItem.mockImplementation(async (key) => {
        persistedKeys.delete(key);
      });
      // Pre-condition: persisted state simulating an initialized vault.
      persistedKeys.set('session:state', JSON.stringify({
        hasCompletedOnboarding: true,
        hasIdentity: true,
        isPendingFirstBackup: false,
      }));
      persistedKeys.set('enbox:enbox.vault.biometric-state', 'ready');
      persistedKeys.set('enbox:enbox.vault.initialized', 'true');

      // Reset must clear ALL three keys.
      await useSessionStore.getState().reset();
      expect(persistedKeys.has('session:state')).toBe(false);
      expect(persistedKeys.has('enbox:enbox.vault.biometric-state')).toBe(false);
      expect(persistedKeys.has('enbox:enbox.vault.initialized')).toBe(false);

      // hasSecret stays false (no native secret) — even if it were
      // ``true``, the orphan-promotion predicate now needs
      // ``vaultPriorInitialized=true`` which is gone.
      const native = require('@specs/NativeBiometricVault').default as {
        hasSecret: jest.Mock;
      };
      native.hasSecret.mockResolvedValue(false);

      // Next hydrate: must NOT promote orphan, must NOT carry
      // hasIdentity from the stale state.
      await useSessionStore.getState().hydrate();
      const state = useSessionStore.getState();
      expect(state.hasCompletedOnboarding).toBe(false);
      expect(state.hasIdentity).toBe(false);
      expect(state.isPendingFirstBackup).toBe(false);
    });
  });

  // ===================================================================
  // VAL-VAULT-028 — durable `isPendingFirstBackup` flag
  //
  // Guards the critical regression where a relaunch between
  // "native secret provisioned" and "user confirmed recovery phrase"
  // routed past the RecoveryPhrase gate and stranded users with an
  // un-backed-up wallet.
  // ===================================================================

  describe('isPendingFirstBackup — persisted backup-gate flag', () => {
    it('defaults to false on a fresh install', () => {
      expect(useSessionStore.getState().isPendingFirstBackup).toBe(false);
    });

    it('hydrates as false when the persisted payload predates the field', async () => {
      // Older installs wrote only hasCompletedOnboarding + hasIdentity —
      // the missing `isPendingFirstBackup` key must hydrate as `false`,
      // which matches the semantic "this wallet has already passed the
      // backup gate" for all pre-VAL-VAULT-028 installs.
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === 'session:state')
          return JSON.stringify({
            hasCompletedOnboarding: true,
            hasIdentity: true,
          });
        return null;
      });

      await useSessionStore.getState().hydrate();

      expect(useSessionStore.getState().isPendingFirstBackup).toBe(false);
    });

    it('round-trips a persisted `true` through hydrate', async () => {
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === 'session:state')
          return JSON.stringify({
            hasCompletedOnboarding: true,
            hasIdentity: true,
            isPendingFirstBackup: true,
          });
        return null;
      });

      await useSessionStore.getState().hydrate();

      expect(useSessionStore.getState().isPendingFirstBackup).toBe(true);
    });

    it('setPendingFirstBackup(true) persists a session payload that includes the flag', async () => {
      await useSessionStore.getState().setPendingFirstBackup(true);

      expect(useSessionStore.getState().isPendingFirstBackup).toBe(true);
      const lastCall =
        mockedSetSecureItem.mock.calls[
          mockedSetSecureItem.mock.calls.length - 1
        ];
      expect(lastCall[0]).toBe('session:state');
      expect(JSON.parse(lastCall[1] as string)).toMatchObject({
        isPendingFirstBackup: true,
      });
    });

    it('setPendingFirstBackup(false) clears the flag on disk', async () => {
      await useSessionStore.getState().setPendingFirstBackup(true);
      await useSessionStore.getState().setPendingFirstBackup(false);

      expect(useSessionStore.getState().isPendingFirstBackup).toBe(false);
      const lastCall =
        mockedSetSecureItem.mock.calls[
          mockedSetSecureItem.mock.calls.length - 1
        ];
      expect(JSON.parse(lastCall[1] as string)).toMatchObject({
        isPendingFirstBackup: false,
      });
    });

    it('commitSetupInitialized flips both hasIdentity and isPendingFirstBackup in a SINGLE setSecureItem write', async () => {
      // VAL-VAULT-028 atomicity: two separate persists to the same
      // SESSION_KEY could race (the `{hasIdentity: false,
      // isPendingFirstBackup: true}` write could land AFTER the
      // `{hasIdentity: true, isPendingFirstBackup: true}` write,
      // leaving on-disk state half-committed). The atomic helper
      // collapses both flips into one write.
      mockedSetSecureItem.mockClear();

      await useSessionStore.getState().commitSetupInitialized();

      const sessionWrites = mockedSetSecureItem.mock.calls.filter(
        ([key]) => key === 'session:state',
      );
      expect(sessionWrites.length).toBe(1);
      const payload = JSON.parse(sessionWrites[0][1] as string);
      expect(payload).toMatchObject({
        hasIdentity: true,
        isPendingFirstBackup: true,
      });
      expect(useSessionStore.getState().hasIdentity).toBe(true);
      expect(useSessionStore.getState().isPendingFirstBackup).toBe(true);
    });

    it('hydrate promotes an orphaned native secret to {hasIdentity:true, isPendingFirstBackup:true}', async () => {
      // Orphan scenario: native secret is on disk, but the app crashed
      // between `initializeFirstLaunch()` provisioning it and
      // `commitSetupInitialized()` landing its SecureStorage write. On
      // relaunch, hydrate() must detect and recover from this state by
      // promoting the in-memory flags so the navigator routes to
      // RecoveryPhrase (where resumePendingBackup() re-derives the
      // mnemonic from the already-provisioned entropy).
      nativeBiometric.hasSecret.mockResolvedValue(true);
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === 'session:state')
          return JSON.stringify({
            hasCompletedOnboarding: true,
            // hasIdentity is `false` on disk — the post-setup persist
            // never landed before the crash.
            hasIdentity: false,
          });
        return null;
      });

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      expect(state.hasIdentity).toBe(true);
      expect(state.isPendingFirstBackup).toBe(true);
      // The promotion is re-persisted so subsequent launches see a
      // consistent snapshot even if the resume flow is interrupted.
      const sessionWrites = mockedSetSecureItem.mock.calls.filter(
        ([key]) => key === 'session:state',
      );
      expect(sessionWrites.length).toBeGreaterThan(0);
      const lastWrite = JSON.parse(
        sessionWrites[sessionWrites.length - 1][1] as string,
      );
      expect(lastWrite).toMatchObject({
        hasIdentity: true,
        isPendingFirstBackup: true,
      });
    });

    it('hydrate does NOT promote when no prior-init signal exists anywhere (truly stale native secret on a fresh-install timeline)', async () => {
      // Defense in depth: if no signal proves the vault was initialized
      // on this device — neither the session-store ``hasCompletedOnboarding``
      // flag, nor the vault's own ``INITIALIZED='true'`` SecureStorage
      // sentinel, nor a persisted ``biometricState`` — then any native
      // secret on disk is stale (e.g. from a previous install on the
      // same device whose SecureStorage was wiped but whose Keychain
      // / Keystore was not). Promoting an orphan in that case would
      // misroute the user to RecoveryPhrase for a wallet they never
      // owned. deliberately gates promotion on at
      // least one of the three signals.
      nativeBiometric.hasSecret.mockResolvedValue(true);
      mockedGetSecureItem.mockResolvedValue(null);

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      expect(state.hasIdentity).toBe(false);
      expect(state.isPendingFirstBackup).toBe(false);
    });

    // -----------------------------------------------------------------
    // Orphan promotion must not depend on the Welcome
    // ``hasCompletedOnboarding`` write landing before a process kill.
    // The vault's own initialization sentinel is enough to recover the
    // first-backup route.
    //        - ``INITIALIZED_RAW_KEY === 'true'`` (vault wrote it)
    //
    // previous code routed back to Welcome→Setup; ``agent.firstLaunch()``
    // returned ``false`` (LevelDB entry exists), and the user never
    // saw their recovery phrase. current uses the
    // ``INITIALIZED_RAW_KEY`` sentinel as a parallel "vault was
    // provisioned" signal so the orphan promotion fires regardless of
    // whether the Welcome persist landed.
    // -----------------------------------------------------------------
    it('hydrate promotes orphan via vault INITIALIZED sentinel when Welcome persist did not land (hasCompletedOnboarding=false)', async () => {
      nativeBiometric.hasSecret.mockResolvedValue(true);
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === 'session:state') return null;
        // The vault's own ``INITIALIZED_STORAGE_KEY`` written at the
        // end of ``_doInitialize()``.
        if (key === 'enbox:enbox.vault.initialized') return 'true';
        return null;
      });

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      expect(state.hasIdentity).toBe(true);
      expect(state.isPendingFirstBackup).toBe(true);
      // The Welcome flag is also flipped on so the navigator does
      // not re-route the user back to Welcome (which would then drop
      // them on BiometricSetup with ``agent.firstLaunch()=false``).
      expect(state.hasCompletedOnboarding).toBe(true);
      // The promotion is re-persisted.
      const sessionWrites = mockedSetSecureItem.mock.calls.filter(
        ([key]) => key === 'session:state',
      );
      expect(sessionWrites.length).toBeGreaterThan(0);
      const lastWrite = JSON.parse(
        sessionWrites[sessionWrites.length - 1][1] as string,
      );
      expect(lastWrite).toMatchObject({
        hasCompletedOnboarding: true,
        hasIdentity: true,
        isPendingFirstBackup: true,
      });
    });

    it('hydrate promotes orphan via biometricState=ready when Welcome persist did not land (defensive fallback path)', async () => {
      // Fallback when ``INITIALIZED_RAW_KEY`` was somehow cleared but
      // the ``biometricState`` is still ``ready`` (observed during
      // SecureStorage backend swaps in testing). Either signal is
      // sufficient evidence that the vault was provisioned, so the
      // orphan must still fire.
      nativeBiometric.hasSecret.mockResolvedValue(true);
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === 'session:state') return null;
        if (key === 'enbox:enbox.vault.biometric-state') return 'ready';
        return null;
      });

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      expect(state.hasIdentity).toBe(true);
      expect(state.isPendingFirstBackup).toBe(true);
      expect(state.hasCompletedOnboarding).toBe(true);
    });

    it('hydrate promotes orphan via biometricState=invalidated when Welcome persist did not land (defensive fallback path)', async () => {
      // ``invalidated`` is also a valid prior-init signal — the
      // vault was provisioned and subsequently observed an
      // enrollment-change invalidation. The user still
      // needs to reach RecoveryPhrase / RecoveryRestore, so the
      // orphan must still fire.
      nativeBiometric.hasSecret.mockResolvedValue(true);
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === 'session:state') return null;
        if (key === 'enbox:enbox.vault.biometric-state') return 'invalidated';
        return null;
      });

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      expect(state.hasIdentity).toBe(true);
      expect(state.isPendingFirstBackup).toBe(true);
      expect(state.hasCompletedOnboarding).toBe(true);
    });
  });

  // =========================================================================
  // - SESSION_RESET_PENDING ghost-state guard
  // =========================================================================
  //
  // If `SESSION_KEY` deletion fails after other reset work succeeds,
  // on-disk state can become a ghost: wallet state is wiped, retry
  // sentinels are cleared, but SESSION_KEY still claims
  // `hasIdentity=true`. The next cold launch must not route to
  // BiometricUnlock against a wiped vault.
  //
  // The current implementation adds a fourth retry sentinel
  // (`SESSION_RESET_PENDING_RAW_KEY` here, canonically named
  // `SESSION_RESET_PENDING_KEY` on the `agent-store.ts` side). When
  // hydrate() observes the sentinel set, it ignores any persisted
  // SESSION_KEY (treats it as if absent → fresh-install defaults) and
  // attempts the SESSION_KEY + sentinel deletes inline.
  describe('SESSION_RESET_PENDING sentinel ghost-state guard', () => {
    const SESSION_KEY = 'session:state';
    const SESSION_RESET_PENDING_RAW_KEY = 'enbox:enbox.session.reset-pending';
    const VAULT_INITIALIZED_RAW_KEY = 'enbox:enbox.vault.initialized';

    it('ignores stale SESSION_KEY and routes to fresh-install defaults when sentinel is set', async () => {
      // Stale SESSION_KEY says hasIdentity=true; the prior reset()
      // wiped vault/LevelDB/auth but failed to delete SESSION_KEY.
      // The session-reset sentinel is the ONLY remaining marker.
      nativeBiometric.hasSecret.mockResolvedValue(false);
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === SESSION_KEY) {
          return JSON.stringify({
            hasCompletedOnboarding: true,
            hasIdentity: true,
            isPendingFirstBackup: false,
          });
        }
        if (key === SESSION_RESET_PENDING_RAW_KEY) return 'true';
        return null;
      });

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      // CRITICAL: with the sentinel set, we MUST NOT route to
      // BiometricUnlock against a wiped vault.
      expect(state.hasIdentity).toBe(false);
      expect(state.hasCompletedOnboarding).toBe(false);
      expect(state.isPendingFirstBackup).toBe(false);
    });

    it('preserves a valid SESSION_KEY when the sentinel is stale but the vault is still intact', async () => {
      nativeBiometric.hasSecret.mockResolvedValue(true);
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === SESSION_KEY) {
          return JSON.stringify({
            hasCompletedOnboarding: true,
            hasIdentity: true,
            isPendingFirstBackup: false,
          });
        }
        if (key === SESSION_RESET_PENDING_RAW_KEY) return 'true';
        if (key === VAULT_INITIALIZED_RAW_KEY) return 'true';
        return null;
      });

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      expect(state.hasIdentity).toBe(true);
      expect(state.hasCompletedOnboarding).toBe(true);
      expect(mockedDeleteSecureItem).not.toHaveBeenCalledWith(SESSION_KEY);
      expect(mockedDeleteSecureItem).toHaveBeenCalledWith(
        SESSION_RESET_PENDING_RAW_KEY,
      );
    });

    it('retries the SESSION_KEY delete inline when the sentinel is set', async () => {
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === SESSION_RESET_PENDING_RAW_KEY) return 'true';
        return null;
      });

      await useSessionStore.getState().hydrate();

      // SESSION_KEY delete MUST have been attempted because the
      // prior reset() left it on disk — the sentinel-driven retry
      // is what closes the agent-store.reset() crash window.
      expect(mockedDeleteSecureItem).toHaveBeenCalledWith(SESSION_KEY);
    });

    it('clears the SESSION_RESET sentinel only after SESSION_KEY delete succeeds', async () => {
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === SESSION_RESET_PENDING_RAW_KEY) return 'true';
        return null;
      });
      // Both deletes succeed → sentinel may be cleared.
      mockedDeleteSecureItem.mockResolvedValue(undefined);

      await useSessionStore.getState().hydrate();

      expect(mockedDeleteSecureItem).toHaveBeenCalledWith(SESSION_KEY);
      expect(mockedDeleteSecureItem).toHaveBeenCalledWith(
        SESSION_RESET_PENDING_RAW_KEY,
      );
    });

    it('keeps the sentinel set when the inline SESSION_KEY delete fails (next-launch retry preserved)', async () => {
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === SESSION_RESET_PENDING_RAW_KEY) return 'true';
        return null;
      });
      // SESSION_KEY delete rejects, sentinel delete would succeed
      // if it were attempted. The current implementation ORDERING means we must NOT
      // attempt the sentinel delete on this path — otherwise a
      // future cold launch would read the still-stale SESSION_KEY
      // ungated by the sentinel and route to BiometricUnlock.
      mockedDeleteSecureItem.mockImplementation(async (key) => {
        if (key === SESSION_KEY) {
          throw new Error('SecureStorage SESSION_KEY delete failed');
        }
      });

      await useSessionStore.getState().hydrate();

      // Sentinel delete was NOT attempted because SESSION_KEY
      // delete failed first.
      const sentinelDeletes = mockedDeleteSecureItem.mock.calls.filter(
        ([key]) => key === SESSION_RESET_PENDING_RAW_KEY,
      );
      expect(sentinelDeletes.length).toBe(0);

      // Hydrate still completed: in-memory state is fresh-install
      // defaults so the next launch routes correctly even if the
      // sentinel persists across the failed retry.
      const state = useSessionStore.getState();
      expect(state.isHydrated).toBe(true);
      expect(state.hasIdentity).toBe(false);
    });

    it('does NOT consult the sentinel path when the sentinel is absent (control)', async () => {
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === SESSION_KEY) {
          return JSON.stringify({
            hasCompletedOnboarding: true,
            hasIdentity: true,
            isPendingFirstBackup: false,
          });
        }
        return null;
      });

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      // Without the sentinel, hydrate honours the persisted
      // SESSION_KEY exactly as it always has.
      expect(state.hasIdentity).toBe(true);
      expect(state.hasCompletedOnboarding).toBe(true);
      // No SESSION_KEY / sentinel deletes were issued in the
      // sentinel-absent path.
      expect(mockedDeleteSecureItem).not.toHaveBeenCalledWith(SESSION_KEY);
      expect(mockedDeleteSecureItem).not.toHaveBeenCalledWith(
        SESSION_RESET_PENDING_RAW_KEY,
      );
    });

    it('treats a SecureStorage read failure for the sentinel as "sentinel absent" (no false-positive ghost-state)', async () => {
      // Defensive: if the sentinel read itself fails, hydrate
      // must NOT trigger the ghost-state path against a perfectly
      // valid SESSION_KEY. We swallow the read error and proceed
      // with the persisted SESSION_KEY (the same posture as
      // session-store's other defensive reads).
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === SESSION_KEY) {
          return JSON.stringify({
            hasCompletedOnboarding: true,
            hasIdentity: true,
            isPendingFirstBackup: false,
          });
        }
        if (key === SESSION_RESET_PENDING_RAW_KEY) {
          throw new Error('SecureStorage read failed');
        }
        return null;
      });

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      expect(state.hasIdentity).toBe(true);
      expect(state.hasCompletedOnboarding).toBe(true);
    });

    it('reset() clears the SESSION_RESET sentinel for direct callers (symmetric cleanup)', async () => {
      await useSessionStore.getState().reset();
      expect(mockedDeleteSecureItem).toHaveBeenCalledWith(
        SESSION_RESET_PENDING_RAW_KEY,
      );
    });
  });

  // -------------------------------------------------------------------
  // - orphan-secret promotion MUST NOT fire when the
  // SESSION_RESET_PENDING sentinel is set
  // -------------------------------------------------------------------
  //
  // The ghost-state guard ignores SESSION_KEY while the sentinel is set
  // and suppresses orphan promotion unless the vault is proven intact.
  describe('sentinel suppresses orphan-secret promotion unless the vault is proven intact', () => {
    const SESSION_KEY = 'session:state';
    const SESSION_RESET_PENDING_RAW_KEY = 'enbox:enbox.session.reset-pending';
    const VAULT_INITIALIZED_RAW_KEY = 'enbox:enbox.vault.initialized';

    it('treats sentinel set + INITIALIZED=true + hasSecret=true as a stale sentinel and preserves orphan recovery', async () => {
      // This is the false-alarm shape: retry sentinels survived, but
      // the vault is still internally intact. Hydrate must not delete
      // SESSION_KEY or suppress the first-backup orphan recovery path.
      nativeBiometric.hasSecret.mockResolvedValue(true);
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === SESSION_RESET_PENDING_RAW_KEY) return 'true';
        if (key === VAULT_INITIALIZED_RAW_KEY) return 'true';
        // SESSION_KEY itself absent; even if it were stale the
        // sentinel-driven ignore branch would skip it.
        return null;
      });

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      expect(state.hasIdentity).toBe(true);
      expect(state.isPendingFirstBackup).toBe(true);
      expect(state.hasCompletedOnboarding).toBe(true);
    });

    it('refuses orphan promotion when sentinel set + biometricState=ready + hasSecret=true (alternate vaultPriorInitialized signal)', async () => {
      // `vaultPriorInitialized` accepts EITHER `INITIALIZED='true'`
      // OR `biometricState ∈ {ready, invalidated}`. The sentinel
      // guard MUST hold against both signal sources.
      nativeBiometric.hasSecret.mockResolvedValue(true);
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === SESSION_RESET_PENDING_RAW_KEY) return 'true';
        if (key === 'enbox:enbox.vault.biometric-state') return 'ready';
        return null;
      });

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      expect(state.hasIdentity).toBe(false);
      expect(state.isPendingFirstBackup).toBe(false);
    });

    it('refuses orphan promotion when sentinel set + biometricState=invalidated + hasSecret=true', async () => {
      nativeBiometric.hasSecret.mockResolvedValue(true);
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === SESSION_RESET_PENDING_RAW_KEY) return 'true';
        if (key === 'enbox:enbox.vault.biometric-state') return 'invalidated';
        return null;
      });

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      expect(state.hasIdentity).toBe(false);
      expect(state.isPendingFirstBackup).toBe(false);
    });

    it('preserves stale SESSION_KEY when sentinel set + hasSecret=true + INITIALIZED=true because the vault is intact', async () => {
      nativeBiometric.hasSecret.mockResolvedValue(true);
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === SESSION_KEY) {
          return JSON.stringify({
            hasCompletedOnboarding: true,
            hasIdentity: true,
            isPendingFirstBackup: false,
          });
        }
        if (key === SESSION_RESET_PENDING_RAW_KEY) return 'true';
        if (key === VAULT_INITIALIZED_RAW_KEY) return 'true';
        return null;
      });

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      expect(state.hasIdentity).toBe(true);
      expect(state.hasCompletedOnboarding).toBe(true);
      expect(state.isPendingFirstBackup).toBe(false);
      expect(mockedDeleteSecureItem).not.toHaveBeenCalledWith(SESSION_KEY);
    });

    it('CONTROL: orphan promotion still fires when sentinel ABSENT + hasSecret=true + INITIALIZED=true (legacy crash-resilience path preserved)', async () => {
      // Preserve the crash-resilience path: a SIGKILL between
      // `_doInitialize()`'s INITIALIZED='true' write and the SESSION_KEY
      // persistence on the very first launch must still produce
      // `isPendingFirstBackup=true` so the user is routed to
      // RecoveryPhrase to back up the new wallet.
      // The current implementation MUST NOT regress this path when the
      // session-reset sentinel is absent.
      nativeBiometric.hasSecret.mockResolvedValue(true);
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === VAULT_INITIALIZED_RAW_KEY) return 'true';
        // No SESSION_RESET sentinel, no SESSION_KEY.
        return null;
      });

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      // Orphan promotion should fire — user is sent to RecoveryPhrase
      // to back up the in-progress wallet.
      expect(state.hasIdentity).toBe(true);
      expect(state.isPendingFirstBackup).toBe(true);
      expect(state.hasCompletedOnboarding).toBe(true);
    });
  });
});
