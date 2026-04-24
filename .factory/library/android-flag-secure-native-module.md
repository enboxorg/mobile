# Android FLAG_SECURE native module (`EnboxFlagSecure`)

This doc covers the Android-only native bridge that toggles
`WindowManager.LayoutParams.FLAG_SECURE` on the host Activity so
screens that render the BIP-39 mnemonic (currently
`RecoveryPhraseScreen` and `RecoveryRestoreScreen`) can block
screenshots, screen recording, and the Recents thumbnail snapshot
(VAL-UX-043).

## Components

1. **Kotlin impl.** `android/app/src/main/java/org/enbox/mobile/nativemodules/FlagSecureModule.kt`
   - Extends `ReactContextBaseJavaModule` (intentionally NOT a
     TurboModule — the surface is tiny, Android-only, and the JS shim
     resolves it lazily).
   - `companion object { const val NAME = "EnboxFlagSecure" }`.
   - `@ReactMethod fun activate(promise: Promise)` schedules
     `window.setFlags(FLAG_SECURE, FLAG_SECURE)` on the UI thread via
     `reactApplicationContext.currentActivity?.runOnUiThread { … }` and
     resolves `null`.
   - `@ReactMethod fun deactivate(promise: Promise)` schedules
     `window.clearFlags(FLAG_SECURE)` the same way.
   - Both methods tolerate a null
     `reactApplicationContext.currentActivity` (headless bring-up) by
     resolving immediately — keeps the JS shim's silently-no-op
     contract intact.

2. **Package registration.** `NativeModulesPackage.kt`
   - `getModule`: `FlagSecureModule.NAME -> FlagSecureModule(reactContext)`.
   - `getReactModuleInfoProvider`: entry with `isTurboModule = false`
     (mirrors the legacy bridge path; the module does not have a
     codegen spec under `specs/`).

3. **JS shim.** `src/lib/native/flag-secure.ts`
   - Exports `FLAG_SECURE` (0x00002000) and
     `FLAG_SECURE_MODULE_NAME = 'EnboxFlagSecure'` plus
     `enableFlagSecure()` / `disableFlagSecure()`.
   - `enableFlagSecure()` early-returns on `Platform.OS !== 'android'`.
   - Otherwise reads `NativeModules[FLAG_SECURE_MODULE_NAME]` and calls
     `activate()` (fire-and-forget; the native promise resolves once the
     UI-thread schedule lands and we never block the React render on it).
   - Both enable and disable swallow synchronous throws so a broken
     bridge cannot crash the screen.

## Canonical name and why we locked it

The shim used to probe three candidate names (`RNFlagSecure`,
`EnboxFlagSecure`, `FlagSecure`) and silently fall through to the
no-op branch because no native module was actually registered in this
repo. Once we own the native impl, the multi-name probe is
anti-hygienic: a typo'd JS rename would silently no-op on device
instead of failing loudly in manual QA. The shim now resolves one name
— `EnboxFlagSecure` — matching the Kotlin module name.

If you rename the Kotlin side, you MUST rename
`FLAG_SECURE_MODULE_NAME` in `src/lib/native/flag-secure.ts` in the
same commit. The
`src/features/auth/screens/__tests__/recovery-phrase-screen.flag-secure-native.test.tsx`
test has an explicit assertion that `FLAG_SECURE_MODULE_NAME ===
'EnboxFlagSecure'` so the drift surfaces in CI.

## Testing

Two layers of Jest coverage:

- **Component-level mock** (`recovery-phrase-screen.test.tsx`) mocks
  `@/lib/native/flag-secure` wholesale and asserts that
  `enableFlagSecure` is called on mount and `disableFlagSecure` on
  unmount. Quick to evaluate and independent of the bridge wiring.
- **Integration** (`recovery-phrase-screen.flag-secure-native.test.tsx`)
  intentionally does NOT mock the shim. It instead installs a jest-fn
  pair under `NativeModules.EnboxFlagSecure` and asserts the real
  shim forwards `activate` / `deactivate` to the native bridge on
  `Platform.OS === 'android'` — and does NOT call through on iOS.

Because the host has no Java / Android SDK per mission boundaries, the
Kotlin module itself is not unit-tested locally; the CI Android build
(`ci.yml` `build-android`) is the integration proof that the module
compiles, registers, and does not regress the existing module surface.

## Platform gotchas

- `Window.setFlags` / `Window.clearFlags` MUST run on the UI thread.
  We wrap the call in
  `reactApplicationContext.currentActivity?.runOnUiThread { … }` for
  that reason; bare `currentActivity` is not available on
  `ReactContextBaseJavaModule` and was the source of the CI Kotlin
  compile failure fixed during the `ci-emulator-validation` milestone.
  Calling `Window` APIs directly from a background thread is a silent
  no-op on some OEM builds and an `IllegalStateException` on others.
- FLAG_SECURE is per-Activity and per-window. It is NOT sticky across
  Activity restarts, so the JS shim must re-activate on every screen
  mount rather than assume the flag persists from a previous screen.
- Calling `setFlags(FLAG_SECURE, FLAG_SECURE)` repeatedly on the same
  window is idempotent. The React double-invoke of `useEffect` under
  Strict Mode simply lands two setFlags + two clearFlags calls, which
  is harmless (matches `NativeBiometricVault`'s tolerance of repeat
  `hasSecret` probes).
- FLAG_SECURE is silently ignored by the emulator's MediaProjection
  screenshot path for the Recents thumbnail, but adb screenshots and
  third-party recording apps are blocked.
