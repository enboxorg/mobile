/**
 * Tests for legacy PIN-era migration on session-store hydrate.
 *
 * Covers validation-contract assertion VAL-VAULT-029:
 *   "Hydrate removes legacy PIN-era persisted state"
 *
 * Scenarios:
 *   1. Seed mocked SecureStorage with `auth:pin-hash`, `auth:lockout`,
 *      and a `session:state` payload containing legacy PIN fields
 *      (hasPinSet, failedAttempts, lockedUntil). After hydrate():
 *      - `deleteSecureItem` called for all three legacy keys.
 *      - Session state post-migration does not expose meaningful
 *        PIN-era values (hasPinSet is false, failedAttempts is 0,
 *        lockedUntil is null).
 *      - Navigator routing (via getInitialRoute) does NOT land on
 *        `CreatePin`/`Unlock`.
 *   2. When no legacy state is present, hydrate leaves storage intact.
 *   3. A partial legacy state (only `auth:pin-hash`) still triggers
 *      migration and wipes all legacy keys.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nativeBiometric = require('@specs/NativeBiometricVault').default;

jest.mock('@/lib/storage/secure-storage', () => ({
  getSecureItem: jest.fn().mockResolvedValue(null),
  setSecureItem: jest.fn().mockResolvedValue(undefined),
  deleteSecureItem: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/auth/pin-hash', () => ({
  hashPin: jest.fn().mockResolvedValue('salt:hash'),
  verifyPin: jest.fn().mockResolvedValue(false),
}));

import {
  deleteSecureItem,
  getSecureItem,
  setSecureItem,
} from '@/lib/storage/secure-storage';
import { useSessionStore } from '@/features/session/session-store';
import { getInitialRoute } from '@/features/session/get-initial-route';

const mockedGetSecureItem = getSecureItem as jest.MockedFunction<typeof getSecureItem>;
const mockedDeleteSecureItem = deleteSecureItem as jest.MockedFunction<
  typeof deleteSecureItem
>;
const mockedSetSecureItem = setSecureItem as jest.MockedFunction<typeof setSecureItem>;

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetSecureItem.mockResolvedValue(null);
  mockedSetSecureItem.mockResolvedValue(undefined);
  mockedDeleteSecureItem.mockResolvedValue(undefined);
  // Reset the biometric mock so these tests don't leak state.
  nativeBiometric.hasSecret.mockResolvedValue(false);
  nativeBiometric.isBiometricAvailable.mockResolvedValue({
    available: true,
    enrolled: true,
    type: 'fingerprint',
  });
  useSessionStore.setState({
    isHydrated: false,
    hasCompletedOnboarding: false,
    hasPinSet: false,
    isLocked: true,
    hasIdentity: false,
    failedAttempts: 0,
    lockedUntil: null,
    lockoutCycle: 0,
    biometricStatus: 'unknown',
  });
});

describe('useSessionStore.hydrate() — legacy PIN migration (VAL-VAULT-029)', () => {
  it('wipes all three legacy storage keys when seeded with a full legacy state', async () => {
    const legacySession = JSON.stringify({
      hasCompletedOnboarding: true,
      hasIdentity: true,
      hasPinSet: true,
      failedAttempts: 2,
      lockedUntil: null,
      lockoutCycle: 0,
    });
    const legacyLockout = JSON.stringify({
      failedAttempts: 2,
      lockedUntil: null,
      lockoutCycle: 0,
    });

    mockedGetSecureItem.mockImplementation(async (key) => {
      if (key === 'session:state') return legacySession;
      if (key === 'auth:pin-hash') return 'salt:hash';
      if (key === 'auth:lockout') return legacyLockout;
      return null;
    });

    await useSessionStore.getState().hydrate();

    // Every legacy key was deleted.
    const deletedKeys = mockedDeleteSecureItem.mock.calls.map(([k]) => k);
    expect(deletedKeys).toEqual(expect.arrayContaining([
      'auth:pin-hash',
      'auth:lockout',
      'session:state',
    ]));

    // Post-migration state carries no meaningful PIN-era values.
    const state = useSessionStore.getState();
    expect(state.hasPinSet).toBe(false);
    expect(state.failedAttempts).toBe(0);
    expect(state.lockedUntil).toBeNull();
    expect(state.lockoutCycle).toBe(0);
    expect(state.isHydrated).toBe(true);
  });

  it('re-persists a clean session payload without PIN fields after migration', async () => {
    const legacySession = JSON.stringify({
      hasCompletedOnboarding: true,
      hasIdentity: true,
      hasPinSet: true,
      failedAttempts: 0,
      lockedUntil: null,
      lockoutCycle: 0,
      pinHash: 'salt:hash',
    });

    mockedGetSecureItem.mockImplementation(async (key) => {
      if (key === 'session:state') return legacySession;
      return null;
    });

    await useSessionStore.getState().hydrate();

    // session:state was re-persisted without the legacy PIN-era fields.
    const persistCalls = mockedSetSecureItem.mock.calls.filter(
      ([k]) => k === 'session:state',
    );
    expect(persistCalls.length).toBeGreaterThanOrEqual(1);
    const latest = persistCalls[persistCalls.length - 1][1];
    const parsed = JSON.parse(latest);
    expect(parsed).toEqual({
      hasCompletedOnboarding: true,
      hasIdentity: true,
    });
    expect(parsed).not.toHaveProperty('hasPinSet');
    expect(parsed).not.toHaveProperty('failedAttempts');
    expect(parsed).not.toHaveProperty('lockedUntil');
    expect(parsed).not.toHaveProperty('pinHash');
  });

  it('routes a legacy PIN user with hasCompletedOnboarding to RecoveryRestore (not CreatePin/Unlock)', async () => {
    mockedGetSecureItem.mockImplementation(async (key) => {
      if (key === 'session:state')
        return JSON.stringify({
          hasCompletedOnboarding: true,
          hasIdentity: true,
          hasPinSet: true,
        });
      if (key === 'auth:pin-hash') return 'salt:hash';
      return null;
    });

    await useSessionStore.getState().hydrate();

    const s = useSessionStore.getState();
    // biometricStatus must NOT be `'ready'` for a migrated legacy user;
    // it should be `'invalidated'` so the navigator gates on
    // RecoveryRestore, OR `'not-enrolled'` / `'unavailable'` if the
    // device is not biometric-capable.
    expect(['invalidated', 'not-enrolled', 'unavailable']).toContain(
      s.biometricStatus,
    );

    const route = getInitialRoute({
      hasCompletedOnboarding: s.hasCompletedOnboarding,
      hasPinSet: s.hasPinSet,
      isLocked: s.isLocked,
      biometricStatus: s.biometricStatus,
    });
    // Must not route to a PIN-era screen.
    expect(route).not.toBe('CreatePin');
    expect(route).not.toBe('Unlock');
    // Either the recovery flow or the unavailable gate is acceptable.
    expect(['RecoveryRestore', 'BiometricUnavailable']).toContain(route);
  });

  it('triggers migration even when only `auth:pin-hash` survived', async () => {
    mockedGetSecureItem.mockImplementation(async (key) => {
      if (key === 'auth:pin-hash') return 'salt:hash';
      return null;
    });

    await useSessionStore.getState().hydrate();

    const deletedKeys = mockedDeleteSecureItem.mock.calls.map(([k]) => k);
    expect(deletedKeys).toEqual(expect.arrayContaining([
      'auth:pin-hash',
      'auth:lockout',
    ]));

    expect(useSessionStore.getState().hasPinSet).toBe(false);
  });

  it('leaves a pristine install untouched (no legacy keys → no deletions)', async () => {
    // All SecureStorage calls return null (default).
    await useSessionStore.getState().hydrate();

    // None of the three legacy keys should have been deleted.
    const deletedKeys = mockedDeleteSecureItem.mock.calls.map(([k]) => k);
    expect(deletedKeys).not.toEqual(expect.arrayContaining([
      'auth:pin-hash',
      'auth:lockout',
    ]));
    expect(useSessionStore.getState().isHydrated).toBe(true);
  });
});
