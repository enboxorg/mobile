# Enbox Mobile

Native iOS and Android wallet for Enbox.

Bare React Native 0.85 with the New Architecture, Turbo Native Modules, and custom native code in Objective-C++ (iOS) and Kotlin (Android).

## Stack

- **React Native 0.85** -- bare project, no Expo
- **New Architecture** -- Fabric renderer and Turbo Modules enabled by default
- **Turbo Native Modules** with Codegen specs for type-safe JS-to-native bindings
- **React Navigation** -- native stack + bottom tabs
- **TanStack Query + Zustand** -- data fetching and state management
- **Jest + React Native Testing Library** -- 35 tests

## Native Modules

The app includes two custom Turbo Native Modules with typed specs:

### NativeSecureStorage

Spec: `specs/NativeSecureStorage.ts`

| Platform | Implementation | Backing store |
|---|---|---|
| iOS | `ios/EnboxMobile/NativeSecureStorage/` (Obj-C++) | Keychain (`kSecClassGenericPassword`) |
| Android | `android/.../nativemodules/NativeSecureStorageModule.kt` | Android Keystore (AES-256-GCM) + encrypted SharedPreferences |

### NativeCrypto

Spec: `specs/NativeCrypto.ts`

| Platform | Implementation | Backing API |
|---|---|---|
| iOS | `ios/EnboxMobile/NativeCrypto/` (Obj-C++) | CommonCrypto (SHA-256) + Security.framework (SecRandomCopyBytes) |
| Android | `android/.../nativemodules/NativeCryptoModule.kt` | `java.security.MessageDigest` + `java.security.SecureRandom` |

### Adding a new native module

1. Create a Codegen spec in `specs/NativeMyModule.ts`
2. Write the iOS implementation in `ios/EnboxMobile/NativeMyModule/`
3. Write the Android implementation in `android/.../nativemodules/`
4. Register in `codegenConfig` (package.json) and the Android package
5. Run `pod install` (iOS) or rebuild (Android) to generate bindings

## Commands

```bash
bun install
bun run verify        # lint + typecheck + test
bun run ios           # build and run on iOS simulator
bun run android       # build and run on Android emulator
```

## Structure

```
specs/                 Turbo Module Codegen specs (TypeScript)
src/
  components/ui/       Shared UI primitives
  constants/           Auth config
  features/            Feature screens, domain logic, tests
  hooks/               App-wide hooks (auto-lock)
  lib/                 Thin JS wrappers around native modules
  navigation/          React Navigation setup
  providers/           App-wide providers
  theme/               Design tokens
ios/                   Xcode project + native module implementations
android/               Gradle project + native module implementations
```

## Architecture

- **No Expo** -- full control over native projects. `ios/` and `android/` are committed and maintained directly.
- **Turbo Modules + Codegen** -- native module interfaces are declared as TypeScript specs. Codegen generates C++/ObjC/Java glue code at build time.
- **Real PIN auth** -- PINs are hashed with PBKDF2-SHA256 (100k iterations + random salt) via the native crypto module and stored in Keychain/Keystore. Constant-time comparison on verification. No plaintext PINs.
- **Auto-lock** -- app locks immediately when backgrounded via AppState listener.
- **Exponential lockout** -- 5 attempts per cycle, with progressive lockout durations (30s, 1m, 5m, 15m, 1h). Lockout state persists across restarts.

## Planning

See [docs/planning.md](docs/planning.md) for the web-wallet portability assessment and delivery roadmap.
