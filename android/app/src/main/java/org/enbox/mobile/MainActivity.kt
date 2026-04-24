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
   * Activity-level FLAG_SECURE baseline (VAL-UX-043).
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
   * This is an additive baseline — the per-screen `enableFlagSecure()` /
   * `disableFlagSecure()` calls stay in place as defense-in-depth (e.g.
   * the restore screen also toggles them) and to keep the cross-platform
   * surface symmetric with the iOS privacy-cover path. Because the flag
   * here is never cleared at the Activity level, a downstream module that
   * calls `disableFlagSecure()` effectively CLEARS our baseline too; that
   * is intentional — the FlagSecureModule writes its own reference-
   * counted state (see the `activate()` / `deactivate()` counter there)
   * so only the non-sensitive screens that explicitly opt out can flip it
   * off. The navigator today never opts any screen out, so the flag is
   * always set in practice.
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
