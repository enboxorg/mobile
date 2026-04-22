# Native biometric vault platform gotchas

- **iOS target membership is explicit.** This repo's `ios/EnboxMobile.xcodeproj/project.pbxproj` still controls source compilation through `PBXSourcesBuildPhase`. Adding a new Obj-C++ file under `ios/EnboxMobile/NativeBiometricVault/` is not enough by itself; verify the `.mm` file appears in the target sources or the TurboModule will not be compiled into the app binary.
- **Android Keystore AES/GCM must generate its own IV when randomized encryption is required.** If a key is created with `setRandomizedEncryptionRequired(true)`, initialize encryption with `cipher.init(Cipher.ENCRYPT_MODE, key)` and persist `cipher.iv`. Supplying a caller-generated IV through `GCMParameterSpec` can fail for Keystore-backed keys during encryption.
