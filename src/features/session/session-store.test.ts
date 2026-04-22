import { useSessionStore } from '@/features/session/session-store';
import { isValidPinFormat } from '@/lib/auth/pin-format';
import {
  getSecureItem,
  setSecureItem,
  deleteSecureItem,
} from '@/lib/storage/secure-storage';
import { hashPin, verifyPin } from '@/lib/auth/pin-hash';

jest.mock('@/lib/storage/secure-storage', () => ({
  getSecureItem: jest.fn().mockResolvedValue(null),
  setSecureItem: jest.fn().mockResolvedValue(undefined),
  deleteSecureItem: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/auth/pin-hash', () => ({
  hashPin: jest.fn().mockResolvedValue('salt:hash'),
  verifyPin: jest.fn().mockResolvedValue(false),
}));

const mockedGetSecureItem = getSecureItem as jest.MockedFunction<typeof getSecureItem>;
const mockedSetSecureItem = setSecureItem as jest.MockedFunction<typeof setSecureItem>;
const mockedDeleteSecureItem = deleteSecureItem as jest.MockedFunction<typeof deleteSecureItem>;
const mockedHashPin = hashPin as jest.MockedFunction<typeof hashPin>;
const mockedVerifyPin = verifyPin as jest.MockedFunction<typeof verifyPin>;

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetSecureItem.mockResolvedValue(null);
  mockedSetSecureItem.mockResolvedValue(undefined);
  mockedDeleteSecureItem.mockResolvedValue(undefined);
  mockedHashPin.mockResolvedValue('salt:hash');
  mockedVerifyPin.mockResolvedValue(false);
  useSessionStore.setState({
    isHydrated: false,
    hasCompletedOnboarding: false,
    hasPinSet: false,
    isLocked: true,
    hasIdentity: false,
    failedAttempts: 0,
    lockedUntil: null,
    lockoutCycle: 0,
  });
});

describe('isValidPinFormat', () => {
  it('accepts a 4-digit numeric string', () => {
    expect(isValidPinFormat('1234')).toBe(true);
    expect(isValidPinFormat('0000')).toBe(true);
  });

  it('rejects non-numeric or wrong-length strings', () => {
    expect(isValidPinFormat('12')).toBe(false);
    expect(isValidPinFormat('12345')).toBe(false);
    expect(isValidPinFormat('abcd')).toBe(false);
    expect(isValidPinFormat('')).toBe(false);
  });
});

describe('useSessionStore', () => {
  describe('hydrate', () => {
    it('restores hasCompletedOnboarding/hasIdentity from secure storage (post-migration PIN fields are reset)', async () => {
      // In the biometric-first era, the presence of `auth:pin-hash`
      // triggers a migration wipe — hasPinSet MUST NOT be restored.
      // The biometric-era `session:state` payload (without legacy PIN
      // fields) is still honoured for onboarding/identity flags.
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === 'session:state') return JSON.stringify({ hasCompletedOnboarding: true, hasIdentity: true });
        if (key === 'auth:pin-hash') return 'salt:hash';
        if (key === 'auth:lockout') return null;
        return null;
      });

      await useSessionStore.getState().hydrate();

      const state = useSessionStore.getState();
      expect(state.isHydrated).toBe(true);
      expect(state.hasCompletedOnboarding).toBe(true);
      expect(state.hasIdentity).toBe(true);
      // Legacy PIN migration wipes hasPinSet; see VAL-VAULT-029.
      expect(state.hasPinSet).toBe(false);
    });

    it('handles missing storage gracefully', async () => {
      await useSessionStore.getState().hydrate();
      const state = useSessionStore.getState();
      expect(state.isHydrated).toBe(true);
      expect(state.hasCompletedOnboarding).toBe(false);
      expect(state.hasPinSet).toBe(false);
    });

    it('handles corrupt storage gracefully', async () => {
      mockedGetSecureItem.mockResolvedValue('not-json');
      await useSessionStore.getState().hydrate();
      expect(useSessionStore.getState().isHydrated).toBe(true);
    });

    it('wipes legacy lockout state on hydrate (VAL-VAULT-029 migration)', async () => {
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === 'auth:lockout') return JSON.stringify({ failedAttempts: 3, lockedUntil: Date.now() - 1000, lockoutCycle: 1 });
        return null;
      });

      await useSessionStore.getState().hydrate();
      // Presence of `auth:lockout` triggers legacy PIN-era migration;
      // every lockout counter resets to its default.
      expect(useSessionStore.getState().failedAttempts).toBe(0);
      expect(useSessionStore.getState().lockedUntil).toBeNull();
      expect(useSessionStore.getState().lockoutCycle).toBe(0);
      // And the legacy key itself is removed from storage.
      expect(mockedDeleteSecureItem).toHaveBeenCalledWith('auth:lockout');
    });
  });

  describe('createPin', () => {
    it('hashes and stores the PIN while keeping the session locked until vault init completes', async () => {
      mockedHashPin.mockResolvedValue('newsalt:newhash');
      await useSessionStore.getState().createPin('5678');

      expect(mockedHashPin).toHaveBeenCalledWith('5678');
      expect(mockedSetSecureItem).toHaveBeenCalledWith('auth:pin-hash', 'newsalt:newhash');
      expect(useSessionStore.getState().hasPinSet).toBe(true);
      expect(useSessionStore.getState().isLocked).toBe(true);
    });

    it('rejects invalid PIN format', async () => {
      await expect(useSessionStore.getState().createPin('ab')).rejects.toThrow('Invalid PIN format');
    });
  });

  describe('unlock', () => {
    it('unlocks with a correct PIN', async () => {
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === 'auth:pin-hash') return 'salt:hash';
        return null;
      });
      mockedVerifyPin.mockResolvedValue(true);

      const result = await useSessionStore.getState().unlock('1234');
      expect(result).toBe(true);
      expect(useSessionStore.getState().isLocked).toBe(true);
    });

    it('rejects a wrong PIN and increments failed attempts', async () => {
      mockedGetSecureItem.mockImplementation(async (key) => {
        if (key === 'auth:pin-hash') return 'salt:hash';
        return null;
      });

      const result = await useSessionStore.getState().unlock('0000');
      expect(result).toBe(false);
      expect(useSessionStore.getState().failedAttempts).toBe(1);
    });

    it('rejects invalid PIN format without hitting storage', async () => {
      const result = await useSessionStore.getState().unlock('ab');
      expect(result).toBe(false);
      expect(mockedGetSecureItem).not.toHaveBeenCalled();
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

  describe('unlockSession', () => {
    it('marks the session unlocked after the vault is ready', () => {
      useSessionStore.getState().unlockSession();
      expect(useSessionStore.getState().isLocked).toBe(false);
    });
  });

  describe('reset', () => {
    it('clears all persisted state', async () => {
      useSessionStore.getState().completeOnboarding();
      await useSessionStore.getState().reset();

      const state = useSessionStore.getState();
      expect(state.hasCompletedOnboarding).toBe(false);
      expect(state.hasPinSet).toBe(false);
      expect(state.isLocked).toBe(true);
      expect(state.lockoutCycle).toBe(0);
      expect(mockedDeleteSecureItem).toHaveBeenCalledWith('auth:pin-hash');
      expect(mockedDeleteSecureItem).toHaveBeenCalledWith('auth:lockout');
    });
  });
});
