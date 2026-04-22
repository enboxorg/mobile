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
