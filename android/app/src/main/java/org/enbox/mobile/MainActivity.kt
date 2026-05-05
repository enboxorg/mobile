package org.enbox.mobile

import android.os.Bundle
import android.view.WindowManager
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "EnboxMobile"

  /**
   * Activity-level FLAG_SECURE baseline (VAL-UX-043 / Round-2 review
   * Finding 4).
   *
   * The per-screen FlagSecure module (see `FlagSecureModule.kt`) applies
   * `FLAG_SECURE` asynchronously through `runOnUiThread` when a sensitive
   * screen such as `RecoveryPhraseScreen` mounts. That post-to-UI-thread
   * hop creates a first-frame window where the mnemonic can be
   * captured — by a screenshot, the Recents thumbnail, or screen-mirroring
   * software — before the flag lands. Setting the flag here, BEFORE the
   * React root view is attached, closes that window: every frame the user
   * ever sees (including splash and JS-bundle-load) is already marked
   * secure by the WindowManager, so no framebuffer snapshot of the app is
   * ever exposed to the system.
   *
   * This baseline is paired with the FlagSecureModule's reference-
   * counted activate/deactivate counter (initialised to 1 to mirror the
   * baseline). A per-screen `activate→deactivate` cycle therefore
   * leaves the counter at 1 and the flag SET — the baseline survives
   * sensitive-screen unmounts, so the first-frame race cannot
   * reappear when a SECOND sensitive screen mounts later in the
   * session. Without that refcount, the unmount path's unconditional
   * `clearFlags` would tear down this baseline, defeating the
   * first-frame guarantee.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    window.setFlags(
      WindowManager.LayoutParams.FLAG_SECURE,
      WindowManager.LayoutParams.FLAG_SECURE,
    )
    super.onCreate(savedInstanceState)
  }

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
