package org.enbox.mobile.nativemodules

import android.view.WindowManager
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
        val activity = currentActivity
        if (activity == null) {
            // No Activity attached (e.g. headless bring-up): best-effort
            // no-op, matching the JS shim's silently-no-op contract.
            promise.resolve(null)
            return
        }
        activity.runOnUiThread {
            activity.window?.setFlags(
                WindowManager.LayoutParams.FLAG_SECURE,
                WindowManager.LayoutParams.FLAG_SECURE,
            )
        }
        promise.resolve(null)
    }

    @ReactMethod
    fun deactivate(promise: Promise) {
        val activity = currentActivity
        if (activity == null) {
            promise.resolve(null)
            return
        }
        activity.runOnUiThread {
            activity.window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
        promise.resolve(null)
    }
}
