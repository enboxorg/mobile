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

    it('Round-8 F5: ALSO clears the vault INITIALIZED sentinel (enbox.vault.initialized) so a subsequent hydrate does not see a stale orphan-detection signal', async () => {
      // Round-7 F2 added ``enbox:enbox.vault.initialized`` as an
      // orphan-detection signal in ``hydrate()``. Round-8 F5
      // surfaces the matching cleanup gap: the pre-fix ``reset()``
      // only deleted ``session:state`` and the biometric-state key,
      // leaving ``enbox.vault.initialized='true'`` resident on disk.
      // The post-fix code symmetrically clears the same key
      // ``hydrate()`` reads, so a session-store reset → next
      // hydrate cycle cannot misroute a fresh-install user via
      // a stale orphan-promotion signal.
      useSessionStore.getState().completeOnboarding();
      useSessionStore.getState().setBiometricStatus('ready');

      await useSessionStore.getState().reset();

      const deletedKeys = mockedDeleteSecureItem.mock.calls.map(([k]) => k);
      expect(deletedKeys).toEqual(
        expect.arrayContaining([
          'session:state',
          'enbox:enbox.vault.biometric-state',
          // The new key. Without this, Round-7 F2's hydrate orphan
          // detection could trigger on a stale signal after a
          // direct session reset.
          'enbox:enbox.vault.initialized',
        ]),
      );
    });

    it('Round-8 F5: subsequent hydrate after reset does NOT promote orphan when a stale INITIALIZED key WOULD have been left behind (end-to-end regression)', async () => {
      // Round-7 F2 + Round-8 F5 end-to-end: pre-Round-8, the order
      // (initialize → reset → hydrate) on a SecureStorage backend
      // that keeps the deleted ``session:state`` and biometric-state
      // keys cleanly cleared but happens to retain the
      // INITIALIZED key would mis-promote the user as an orphan.
      // We simulate the post-fix behaviour: the test mock observes
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
      // Pre-condition: persisted state simulating a previously-
      // initialized vault.
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
      // Defense in depth: if NO signal proves the vault was previously
      // initialized — neither the session-store ``hasCompletedOnboarding``
      // flag, nor the vault's own ``INITIALIZED='true'`` SecureStorage
      // sentinel, nor a persisted ``biometricState`` — then any native
      // secret on disk is stale (e.g. from a previous install on the
      // same device whose SecureStorage was wiped but whose Keychain
      // / Keystore was not). Promoting an orphan in that case would
      // misroute the user to RecoveryPhrase for a wallet they never
      // owned. Round-7 Finding 2 deliberately gates promotion on at
      // least one of the three signals.
      nativeBiometric.hasSecret.mockResolvedValue(true);
      mockedGetSecureItem.mockResolvedValue(null);

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      expect(state.hasIdentity).toBe(false);
      expect(state.isPendingFirstBackup).toBe(false);
    });

    // -----------------------------------------------------------------
    // Round-7 Finding 2: orphan promotion must NOT depend on the
    // Welcome ``hasCompletedOnboarding`` write landing first.
    //
    // Pre-fix timeline that the regression captures:
    //   1. User clicks Continue on Welcome.
    //      ``completeOnboarding()`` flips the in-memory flag and queues
    //      a fire-and-forget ``persistSession``. The persist may not
    //      have committed yet.
    //   2. User immediately reaches BiometricSetup which calls
    //      ``initializeFirstLaunch()``. The vault's
    //      ``_doInitialize()`` runs to completion: the native secret
    //      is stored AND the vault's own
    //      ``INITIALIZED_STORAGE_KEY='true'`` sentinel is written
    //      synchronously inside the same call.
    //   3. Process kill BEFORE the Welcome ``persistSession`` from
    //      step 1 lands AND before
    //      ``commitSetupInitialized()`` runs.
    //   4. Relaunch observes:
    //        - ``rawSession === null`` (Welcome write never committed)
    //        - ``hasSecret === true`` (vault's ``_doInitialize`` did
    //          succeed)
    //        - ``INITIALIZED_RAW_KEY === 'true'`` (vault wrote it)
    //
    // Pre-fix code routed back to Welcome→Setup; ``agent.firstLaunch()``
    // returned ``false`` (LevelDB entry exists), and the user never
    // saw their recovery phrase. Post-fix uses the
    // ``INITIALIZED_RAW_KEY`` sentinel as a parallel "vault was
    // provisioned" signal so the orphan promotion fires regardless of
    // whether the Welcome persist landed.
    // -----------------------------------------------------------------
    it('Round-7 F2: hydrate promotes orphan via vault INITIALIZED sentinel when Welcome persist did not land (hasCompletedOnboarding=false)', async () => {
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

    it('Round-7 F2: hydrate promotes orphan via biometricState=ready when Welcome persist did not land (defensive fallback path)', async () => {
      // Fallback when ``INITIALIZED_RAW_KEY`` was somehow cleared but
      // the ``biometricState`` is still ``ready`` (observed during
      // SecureStorage backend swaps in testing). Either signal is
      // sufficient evidence that the vault was previously
      // provisioned, so the orphan must still fire.
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

    it('Round-7 F2: hydrate promotes orphan via biometricState=invalidated when Welcome persist did not land (defensive fallback path)', async () => {
      // ``invalidated`` is also a valid prior-init signal — the
      // vault has previously been provisioned AND has subsequently
      // observed an enrollment-change invalidation. The user still
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
});
