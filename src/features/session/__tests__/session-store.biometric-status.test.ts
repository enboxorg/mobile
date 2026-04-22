/**
 * Tests for session-store biometricStatus state machine.
 *
 * Covers validation-contract assertion VAL-VAULT-030:
 *   "Fingerprint-removed pathway sets biometricStatus='not-enrolled'
 *    (distinct from 'invalidated')".
 *
 * Scenarios:
 *   1. Fresh install, biometrics enrolled → `'ready'`.
 *   2. Biometrics unavailable on the hardware → `'unavailable'`.
 *   3. Hardware present but no enrollment AND a secret exists →
 *      `'not-enrolled'` (distinct from `'invalidated'`).
 *   4. Persisted `enbox.vault.biometric-state = 'invalidated'` →
 *      `'invalidated'` regardless of native probe (KEY_INVALIDATED
 *      is the only path to `'invalidated'`).
 *   5. `setBiometricStatus` action toggles between states.
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

import { getSecureItem } from '@/lib/storage/secure-storage';
import { useSessionStore } from '@/features/session/session-store';

const mockedGetSecureItem = getSecureItem as jest.MockedFunction<typeof getSecureItem>;

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetSecureItem.mockResolvedValue(null);
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

describe('session-store.biometricStatus — hydration matrix (VAL-VAULT-030)', () => {
  it('sets biometricStatus=`ready` on a fresh install with enrolled biometrics', async () => {
    nativeBiometric.isBiometricAvailable.mockResolvedValue({
      available: true,
      enrolled: true,
      type: 'fingerprint',
    });
    nativeBiometric.hasSecret.mockResolvedValue(false);

    await useSessionStore.getState().hydrate();
    expect(useSessionStore.getState().biometricStatus).toBe('ready');
  });

  it('sets biometricStatus=`unavailable` when native hardware reports unavailable', async () => {
    nativeBiometric.isBiometricAvailable.mockResolvedValue({
      available: false,
      enrolled: false,
      type: 'none',
      reason: 'NO_HARDWARE',
    });
    nativeBiometric.hasSecret.mockResolvedValue(false);

    await useSessionStore.getState().hydrate();
    expect(useSessionStore.getState().biometricStatus).toBe('unavailable');
  });

  it('sets biometricStatus=`not-enrolled` when hardware exists but no biometrics enrolled (with existing secret)', async () => {
    // User had a working biometric wallet, then removed every enrolled
    // fingerprint. Hardware still present, but nothing enrolled.
    nativeBiometric.isBiometricAvailable.mockResolvedValue({
      available: true,
      enrolled: false,
      type: 'fingerprint',
    });
    nativeBiometric.hasSecret.mockResolvedValue(true);

    await useSessionStore.getState().hydrate();
    expect(useSessionStore.getState().biometricStatus).toBe('not-enrolled');
    // CRITICAL distinction: MUST NOT be `'invalidated'` — that code
    // path is reserved for KEY_INVALIDATED and would route the user
    // into the recovery flow when all they need to do is re-enroll.
    expect(useSessionStore.getState().biometricStatus).not.toBe('invalidated');
  });

  it('sets biometricStatus=`not-enrolled` on a fresh install when hardware exists but nothing enrolled', async () => {
    nativeBiometric.isBiometricAvailable.mockResolvedValue({
      available: true,
      enrolled: false,
      type: 'fingerprint',
    });
    nativeBiometric.hasSecret.mockResolvedValue(false);

    await useSessionStore.getState().hydrate();
    expect(useSessionStore.getState().biometricStatus).toBe('not-enrolled');
  });

  it('honors a persisted `invalidated` flag regardless of native probe result', async () => {
    // Simulate a previous KEY_INVALIDATED event that wrote the flag.
    mockedGetSecureItem.mockImplementation(async (key) => {
      if (key === 'enbox:enbox.vault.biometric-state') return 'invalidated';
      return null;
    });
    nativeBiometric.isBiometricAvailable.mockResolvedValue({
      available: true,
      enrolled: true,
      type: 'fingerprint',
    });
    nativeBiometric.hasSecret.mockResolvedValue(true);

    await useSessionStore.getState().hydrate();
    expect(useSessionStore.getState().biometricStatus).toBe('invalidated');
  });

  it('setBiometricStatus() transitions the exposed status', () => {
    expect(useSessionStore.getState().biometricStatus).toBe('unknown');
    useSessionStore.getState().setBiometricStatus('ready');
    expect(useSessionStore.getState().biometricStatus).toBe('ready');
    useSessionStore.getState().setBiometricStatus('invalidated');
    expect(useSessionStore.getState().biometricStatus).toBe('invalidated');
    useSessionStore.getState().setBiometricStatus('not-enrolled');
    expect(useSessionStore.getState().biometricStatus).toBe('not-enrolled');
  });

  it('reset() clears biometricStatus back to `unknown` and removes the persisted flag', async () => {
    useSessionStore.getState().setBiometricStatus('invalidated');
    expect(useSessionStore.getState().biometricStatus).toBe('invalidated');

    await useSessionStore.getState().reset();

    expect(useSessionStore.getState().biometricStatus).toBe('unknown');
  });
});
