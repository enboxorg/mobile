/**
 * RecoveryPhraseScreen × native FlagSecure integration test.
 *
 * Distinct from `recovery-phrase-screen.test.tsx`, which mocks
 * `@/lib/native/flag-secure` wholesale. This test intentionally does
 * NOT mock that module — it installs a jest-fn-backed
 * `NativeModules.EnboxFlagSecure` and asserts that the native bridge
 * receives the `activate()` / `deactivate()` calls that the shim is
 * supposed to forward on Android.
 *
 * Rationale: the previous JS shim probed three candidate module names
 * (`RNFlagSecure`, `EnboxFlagSecure`, `FlagSecure`) and silently no-op'd
 * on Android because no native module was registered in the repo. This
 * feature registers the canonical `EnboxFlagSecure` Kotlin module; this
 * test locks the name and call-through behavior so any future rename
 * fails loudly.
 *
 * Covers the wiring half of VAL-UX-043.
 */

// IMPORTANT: no jest.mock() for '@/lib/native/flag-secure' — we want the
// real shim to run so we can observe it calling through to the native
// module via NativeModules.

// Spy on the secure-storage wrapper so component lifecycle cleanup does
// not attempt to hit real SharedPreferences / Keychain.
jest.mock('@/lib/storage/secure-storage', () => ({
  __esModule: true,
  getSecureItem: jest.fn().mockResolvedValue(null),
  setSecureItem: jest.fn().mockResolvedValue(undefined),
  deleteSecureItem: jest.fn().mockResolvedValue(undefined),
}));

import { render } from '@testing-library/react-native';
import { NativeModules, Platform } from 'react-native';

import { RecoveryPhraseScreen } from '@/features/auth/screens/recovery-phrase-screen';
import { FLAG_SECURE_MODULE_NAME } from '@/lib/native/flag-secure';

type NativeModulesRecord = Record<string, unknown>;

const MNEMONIC_24_STRING = Array.from({ length: 24 }, (_, i) => `w${i + 1}`).join(
  ' ',
);

const originalPlatformOS = Platform.OS;

function installFlagSecureNativeMock(): {
  activate: jest.Mock;
  deactivate: jest.Mock;
} {
  const activate = jest.fn().mockResolvedValue(undefined);
  const deactivate = jest.fn().mockResolvedValue(undefined);
  (NativeModules as NativeModulesRecord)[FLAG_SECURE_MODULE_NAME] = {
    activate,
    deactivate,
  };
  return { activate, deactivate };
}

function uninstallFlagSecureNativeMock(): void {
  delete (NativeModules as NativeModulesRecord)[FLAG_SECURE_MODULE_NAME];
}

function withPlatformOS(os: 'ios' | 'android'): void {
  (Platform as { OS: string }).OS = os;
}

describe('RecoveryPhraseScreen × NativeModules.EnboxFlagSecure', () => {
  afterEach(() => {
    (Platform as { OS: string }).OS = originalPlatformOS;
    uninstallFlagSecureNativeMock();
  });

  it('canonical JS name matches the Kotlin FlagSecureModule.NAME contract', () => {
    // Guardrail: this literal MUST stay in lock-step with
    // android/.../FlagSecureModule.kt's `companion object { NAME = ... }`.
    // If this assertion fails, the Kotlin rename was not mirrored here
    // (or vice-versa) and the JS shim will silently no-op on device.
    expect(FLAG_SECURE_MODULE_NAME).toBe('EnboxFlagSecure');
  });

  it('calls NativeModules.EnboxFlagSecure.activate on mount (Android)', () => {
    withPlatformOS('android');
    const { activate, deactivate } = installFlagSecureNativeMock();

    const screen = render(
      <RecoveryPhraseScreen
        mnemonic={MNEMONIC_24_STRING}
        onConfirm={jest.fn()}
      />,
    );

    expect(activate).toHaveBeenCalledTimes(1);
    expect(deactivate).not.toHaveBeenCalled();

    screen.unmount();
  });

  it('calls NativeModules.EnboxFlagSecure.deactivate on unmount (Android)', () => {
    withPlatformOS('android');
    const { activate, deactivate } = installFlagSecureNativeMock();

    const screen = render(
      <RecoveryPhraseScreen
        mnemonic={MNEMONIC_24_STRING}
        onConfirm={jest.fn()}
      />,
    );

    expect(activate).toHaveBeenCalledTimes(1);

    screen.unmount();

    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('does NOT call the native bridge on iOS (shim is Platform.OS-gated)', () => {
    withPlatformOS('ios');
    const { activate, deactivate } = installFlagSecureNativeMock();

    const screen = render(
      <RecoveryPhraseScreen
        mnemonic={MNEMONIC_24_STRING}
        onConfirm={jest.fn()}
      />,
    );

    screen.unmount();

    expect(activate).not.toHaveBeenCalled();
    expect(deactivate).not.toHaveBeenCalled();
  });

  it('silently no-ops on Android when the native module is not registered', () => {
    withPlatformOS('android');
    // Explicitly leave NativeModules.EnboxFlagSecure UNdefined — this is
    // the Jest / iOS / unregistered-build case and the shim must swallow
    // the missing module without throwing.
    uninstallFlagSecureNativeMock();

    expect(() =>
      render(
        <RecoveryPhraseScreen
          mnemonic={MNEMONIC_24_STRING}
          onConfirm={jest.fn()}
        />,
      ).unmount(),
    ).not.toThrow();
  });

  it('shim swallows synchronous errors thrown by the native module', () => {
    withPlatformOS('android');
    const activate = jest.fn(() => {
      throw new Error('simulated native bridge failure');
    });
    const deactivate = jest.fn(() => {
      throw new Error('simulated native bridge failure');
    });
    (NativeModules as NativeModulesRecord)[FLAG_SECURE_MODULE_NAME] = {
      activate,
      deactivate,
    };

    expect(() => {
      const screen = render(
        <RecoveryPhraseScreen
          mnemonic={MNEMONIC_24_STRING}
          onConfirm={jest.fn()}
        />,
      );
      screen.unmount();
    }).not.toThrow();

    // Both sides were still probed, even though they threw.
    expect(activate).toHaveBeenCalledTimes(1);
    expect(deactivate).toHaveBeenCalledTimes(1);
  });
});
