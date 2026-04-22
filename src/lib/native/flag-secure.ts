import { NativeModules, Platform } from 'react-native';

/**
 * Android `WindowManager.LayoutParams.FLAG_SECURE` bit value (0x00002000
 * == 8192). Re-exported so tests and any future native-module wiring can
 * reference the same constant without coupling to implementation detail.
 */
export const FLAG_SECURE = 0x00002000;

type FlagSecureModule = {
  activate?: () => void;
  deactivate?: () => void;
};

/**
 * Lazily resolve a potential native module exposing `activate()` /
 * `deactivate()` that sets/clears `Window.setFlags(FLAG_SECURE, FLAG_SECURE)`
 * on the host Activity. When the module is not yet registered the wrapper
 * silently no-ops — screens must still call `enableFlagSecure()` /
 * `disableFlagSecure()` in the same lifecycle positions so the contract
 * is met once the Android-side module lands.
 */
function resolveModule(): FlagSecureModule | undefined {
  const modules = NativeModules as Record<string, unknown>;
  const candidate =
    modules.RNFlagSecure ??
    modules.EnboxFlagSecure ??
    modules.FlagSecure;
  if (candidate && typeof candidate === 'object') {
    return candidate as FlagSecureModule;
  }
  return undefined;
}

/**
 * Enable `FLAG_SECURE` on the Android host Activity. Blocks:
 *   - screenshots (adb / key combos)
 *   - screen recording
 *   - the thumbnail shown in the app Recents / task-switcher list
 *
 * No-ops on any non-Android platform, and silently no-ops when the
 * backing native module has not been registered. Screens MUST still call
 * this on mount and pair it with `disableFlagSecure()` on unmount so the
 * FLAG_SECURE window flag does not leak into subsequent screens.
 *
 * See VAL-UX-043.
 */
export function enableFlagSecure(): void {
  if (Platform.OS !== 'android') return;
  try {
    const mod = resolveModule();
    mod?.activate?.();
  } catch {
    // Native module present but threw; best-effort — never propagate.
  }
}

/**
 * Disable `FLAG_SECURE` on the Android host Activity. Called on screen
 * unmount so the flag does not leak into other screens.
 *
 * No-ops on non-Android platforms and when the backing native module is
 * not registered.
 */
export function disableFlagSecure(): void {
  if (Platform.OS !== 'android') return;
  try {
    const mod = resolveModule();
    mod?.deactivate?.();
  } catch {
    // See enableFlagSecure.
  }
}
