import { NativeModules, Platform } from 'react-native';

/**
 * Android `WindowManager.LayoutParams.FLAG_SECURE` bit value (0x00002000
 * == 8192). Re-exported so tests and any future native-module wiring can
 * reference the same constant without coupling to implementation detail.
 */
export const FLAG_SECURE = 0x00002000;

/**
 * Canonical JS name of the Android native module that toggles the
 * window's FLAG_SECURE flag. Must match the module name exported by the
 * Kotlin implementation in
 * `android/app/src/main/java/org/enbox/mobile/nativemodules/FlagSecureModule.kt`
 * (`FlagSecureModule.NAME = "EnboxFlagSecure"`).
 *
 * Exported so tests and platform-specific wiring can reference the same
 * string without duplicating the literal.
 */
export const FLAG_SECURE_MODULE_NAME = 'EnboxFlagSecure';

type FlagSecureModule = {
  activate?: () => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
};

/**
 * Lazily resolve the canonical `EnboxFlagSecure` native module. The
 * module is registered by the Android app build (see
 * `FlagSecureModule.kt` + `NativeModulesPackage.kt`); on iOS and in
 * Jest the module is absent and the resolver returns `undefined` so
 * callers silently no-op.
 *
 * History: earlier versions of this shim probed three candidate names
 * (`RNFlagSecure`, `EnboxFlagSecure`, `FlagSecure`) because no native
 * module was registered in the repo. Now that we own the native impl,
 * we lock the probe to the single canonical name so a mis-registration
 * fails loudly (in manual QA) rather than silently falling through.
 */
function resolveModule(): FlagSecureModule | undefined {
  const modules = NativeModules as Record<string, unknown>;
  const candidate = modules[FLAG_SECURE_MODULE_NAME];
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
 * backing native module has not been registered. Screens MUST still
 * call this on mount and pair it with `disableFlagSecure()` on unmount
 * so the FLAG_SECURE window flag does not leak into subsequent screens.
 *
 * See VAL-UX-043.
 */
export function enableFlagSecure(): void {
  if (Platform.OS !== 'android') return;
  try {
    const mod = resolveModule();
    // Fire-and-forget — the native promise resolves once the UI-thread
    // setFlags has been scheduled; we never block React render on it.
    mod?.activate?.();
  } catch {
    // Native module present but threw synchronously; best-effort —
    // never propagate so a broken bridge cannot take down the screen.
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
