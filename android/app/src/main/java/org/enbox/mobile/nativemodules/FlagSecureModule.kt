package org.enbox.mobile.nativemodules

import android.view.WindowManager.LayoutParams.FLAG_SECURE
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.atomic.AtomicInteger

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
 * Reference-counted activation (VAL-UX-043 / Round-2 review Finding 4):
 *
 *   `MainActivity.onCreate` sets FLAG_SECURE before the first frame as a
 *   global baseline. Sensitive screens (RecoveryPhraseScreen,
 *   RecoveryRestoreScreen) call `activate()` on mount and `deactivate()`
 *   on unmount, expecting the flag to ride alongside the screen lifecycle.
 *   Without a refcount the unmount path's unconditional `clearFlags`
 *   would tear down the MainActivity baseline too — re-opening the
 *   first-frame race that the baseline exists to prevent on EVERY
 *   subsequent sensitive-screen mount, since the activate→deactivate
 *   pair only re-asserts the flag for the duration of the sensitive
 *   screen.
 *
 *   The fix:
 *     - Initialise the counter to 1 to mirror the
 *       `MainActivity.onCreate` baseline. A `deactivate()` on a
 *       no-active-screen state therefore decrements to 0 and clears
 *       the flag (legacy semantics for the few screens that DO want
 *       the flag off — none today, but the API stays composable).
 *     - `activate()` increments and (re)applies FLAG_SECURE.
 *     - `deactivate()` decrements; only when the count reaches 0 do
 *       we actually `clearFlags(FLAG_SECURE)`. The count is clamped
 *       at 0 so a stray extra `deactivate()` is a no-op rather than
 *       a negative refcount. With the baseline of 1, a single per-
 *       screen `activate→deactivate` pair leaves the baseline
 *       (count == 1) intact.
 *
 *   `AtomicInteger` is used because `activate`/`deactivate` may be
 *   invoked from different RN bridge threads concurrently with
 *   `runOnUiThread`-scheduled window mutations; the counter itself
 *   doesn't drive the actual window state (the UI-thread block
 *   handles that), it only records the desired final state.
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

        /**
         * Process-wide refcount of FLAG_SECURE activations. Initialised
         * to 1 to mirror the activity-level baseline applied in
         * `MainActivity.onCreate`. `companion object` scope (not
         * instance scope) so a React context restart that recreates
         * the FlagSecureModule does not zero the counter and clear the
         * baseline that was applied by the activity outside this
         * module's lifetime.
         *
         * Internal visibility for the test harness — production
         * callers must go through `activate()` / `deactivate()`.
         */
        @JvmStatic
        internal val activationCount: AtomicInteger = AtomicInteger(1)
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
        activationCount.incrementAndGet()
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
        // Decrement, clamped at 0 so a stray extra `deactivate()` doesn't
        // drive the counter negative. Only clear FLAG_SECURE when the
        // refcount reaches 0 — i.e. neither the MainActivity baseline
        // (count >= 1 always while the baseline holds) nor any sensitive
        // screen still wants the flag on. With the baseline initialised
        // to 1, a single sensitive-screen activate→deactivate pair leaves
        // the count at 1 and the flag stays SET, preserving the
        // first-frame-secure guarantee for any subsequent sensitive
        // screen that mounts later in the session.
        val newCount = activationCount.updateAndGet { current ->
            if (current <= 0) 0 else current - 1
        }
        val activity = reactApplicationContext.currentActivity ?: run {
            promise.resolve(null)
            return
        }
        if (newCount == 0) {
            activity.runOnUiThread {
                activity.window?.clearFlags(FLAG_SECURE)
            }
        }
        promise.resolve(null)
    }
}
