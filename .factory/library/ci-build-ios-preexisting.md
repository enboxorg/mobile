# Pre-existing CI `build-ios` breakage (as of 2026-04-22)

`ci.yml` → `build-ios` has been failing on `master` and on `mission/biometric-vault`
for reasons unrelated to the biometric vault mission. Two distinct failure modes
have been observed:

## A. `iPhone 16` simulator missing on `macos-15` runner (current run)

Run `24752970167` (commit `d471150`, mission branch) failed during destination
resolution:

```
xcodebuild: error: Unable to find a device matching the provided destination specifier:
    { platform:iOS Simulator, OS:latest, name:iPhone 16 }
Available destinations for the "EnboxMobile" scheme:
    { platform:macOS ... }
    { platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device }
    { platform:iOS Simulator, id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-iphonesimulator:placeholder, name:Any iOS Simulator Device }
```

The `macos-15` runner no longer ships a pre-installed `iPhone 16` simulator.
Fix suggestion (future feature, not part of `native-biometric-ios-impl`):

- Change `.github/workflows/ci.yml` `build-ios` destination to
  `-destination 'generic/platform=iOS Simulator'`, OR
- Install a simulator via `xcrun simctl` before invoking `xcodebuild`, OR
- Pin the runner image / install an `iPhone 16` runtime explicitly.

## B. `react-native-camera-kit` targets iOS 26 APIs (older runs on master)

Master runs prior to 2026-04-22 (e.g. `24744022377`) failed inside
`react-native-camera-kit`:

```
node_modules/react-native-camera-kit/ios/ReactNativeCameraKit/RealCamera.swift:621:24: error:
  value of type 'AVCapturePhotoOutput' has no member 'isDeferredStartSupported'
```

The library uses `isDeferredStartSupported` / `isDeferredStartEnabled`, which
are iOS 26 APIs. The runner's Xcode 16.4 / SDK 18.5 does not expose them. Fix
requires either bumping Xcode/SDK on the runner or applying a patch (via
`scripts/apply-patches.mjs`) that wraps the iOS-26-only code behind
`#if swift(>=6.2)` / explicit availability guards.

## Relevance to `native-biometric-ios-impl`

`RCTNativeBiometricVault.{h,mm}` itself compiles cleanly against the
`LocalAuthentication` and `Security` frameworks and conforms to
`NativeBiometricVaultSpec`. Both pre-existing breakages (A) and (B) are in
unrelated parts of the build graph and block `VAL-NATIVE-013` for reasons
outside the feature's scope. When (A) and (B) are fixed in follow-up work,
`VAL-NATIVE-013` should pass without further changes to
`ios/EnboxMobile/NativeBiometricVault/*`.
