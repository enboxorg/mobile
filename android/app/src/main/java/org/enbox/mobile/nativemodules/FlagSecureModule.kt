package org.enbox.mobile.nativemodules

import android.view.WindowManager.LayoutParams.FLAG_SECURE
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * FlagSecureModule — Android native bridge for toggling
 * `WindowManager.LayoutParams.FLAG_SECURE` on the host Activity.
 *
 * When active, FLAG_SECURE blocks:
 *   - screenshots (adb / hardware key combos)
 *   - screen recording
 *   - the thumbnail shown in the app Recents / task-switcher list
 *
 * JS contract (see `src/lib/native/flag-secure.ts`):
 *   - Canonical NativeModules name is `EnboxFlagSecure`.
 *   - `activate(promise)` sets FLAG_SECURE on the current Activity's window.
 *   - `deactivate(promise)` clears it.
 *   - Both methods resolve `null` once the flag change has been scheduled
 *     on the UI thread (window flag mutations MUST happen on the UI thread
 *     per Android SDK contract); they never reject with an error so the JS
 *     shim can keep a best-effort, silently-no-op posture.
 *
 * Deliberately NOT a TurboModule (no codegen spec) — the surface is tiny,
 * platform-specific (Android only), and does not need TurboModule eager
 * loading. The JS shim probes `NativeModules.EnboxFlagSecure` lazily.
 *
 * See VAL-UX-043 in `validation-contract.md`.
 */
class FlagSecureModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        /**
         * Canonical module name exposed to JS. Must match the name probed
         * by `src/lib/native/flag-secure.ts`.
         */
        const val NAME = "EnboxFlagSecure"
    }

    override fun getName(): String = NAME

    @ReactMethod
    fun activate(promise: Promise) {
        // FlagSecureModule extends ReactContextBaseJavaModule directly (not
        // a codegen spec), so `currentActivity` is NOT resolvable as a bare
        // identifier under Kotlin compilation on CI. Go through
        // `reactApplicationContext.currentActivity` which returns a
        // nullable Activity? — mirrors the pattern used by upstream RN Java
        // samples and keeps our silently-no-op contract for a detached
        // Activity (e.g. headless bring-up).
        val activity = reactApplicationContext.currentActivity ?: run {
            promise.resolve(null)
            return
        }
        activity.runOnUiThread {
            activity.window?.setFlags(FLAG_SECURE, FLAG_SECURE)
        }
        promise.resolve(null)
    }

    @ReactMethod
    fun deactivate(promise: Promise) {
        val activity = reactApplicationContext.currentActivity ?: run {
            promise.resolve(null)
            return
        }
        activity.runOnUiThread {
            activity.window?.clearFlags(FLAG_SECURE)
        }
        promise.resolve(null)
    }
}
