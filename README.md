# Enbox Mobile

Native iOS and Android wallet for Enbox.

Bare React Native 0.85 with the New Architecture, Turbo Native Modules, and the full `@enbox/*` SDK integrated.

## Stack

- **React Native 0.85** -- bare project, no Expo
- **New Architecture** -- Fabric renderer and Turbo Modules enabled by default
- **Turbo Native Modules** with Codegen specs for type-safe JS-to-native bindings
- **@enbox/* SDK** -- agent, auth, crypto, dids, dwn-clients, protocols, api, common
- **React Navigation** -- native stack + bottom tabs
- **TanStack Query + Zustand** -- data fetching and state management
- **Jest + React Native Testing Library** -- 34 tests

## Enbox SDK Integration

The full `@enbox/*` SDK runs in React Native via:

| Concern | Web wallet approach | Mobile approach |
|---|---|---|
| Crypto (`crypto.subtle`) | Browser Web Crypto API | `react-native-quick-crypto` polyfill |
| Streams (`ReadableStream`) | Browser Streams API | `web-streams-polyfill` |
| Persistent storage (`level`) | `browser-level` (IndexedDB) | `react-native-leveldb` (native LevelDB via JSI), intercepted via Metro resolver |
| Auth session storage | `localStorage` | `SecureStorageAdapter` backed by NativeSecureStorage Turbo Module (Keychain/Keystore) |
| Connect flow | Popup + `postMessage` (`@enbox/browser`) | `WalletConnect` relay (QR code + deep links + PIN confirmation) |

### How it works

1. **Polyfills** load in `index.js` before any SDK import
2. **Metro resolver** intercepts `import { Level } from 'level'` across all `@enbox/*` packages and redirects to `RNLevel` (our adapter wrapping `react-native-leveldb`)
3. **Agent initialization** creates `AuthManager` with a `SecureStorageAdapter` and `EnboxUserAgent` with the RN-compatible storage layer
4. **Connect flow** uses the built-in `WalletConnect` relay -- no browser APIs needed

Key files:
- `src/lib/polyfills.ts` -- crypto + streams polyfill setup
- `src/lib/enbox/rn-level.ts` -- LevelDB adapter with sublevel support
- `src/lib/enbox/storage-adapter.ts` -- Keychain/Keystore auth storage
- `src/lib/enbox/agent-init.ts` -- agent + auth manager initialization
- `src/lib/enbox/agent-store.ts` -- global agent state (Zustand)
- `src/lib/enbox/connect.ts` -- mobile connect flow via WalletConnect relay
- `metro.config.js` -- `level` → `RNLevel` resolver override

## Native Modules

Two custom Turbo Native Modules with typed Codegen specs:

### NativeSecureStorage

Spec: `specs/NativeSecureStorage.ts`

| Platform | Implementation | Backing store |
|---|---|---|
| iOS | `ios/EnboxMobile/NativeSecureStorage/` (Obj-C++) | Keychain (`kSecClassGenericPassword`), serialized dispatch queue |
| Android | `android/.../nativemodules/NativeSecureStorageModule.kt` | Android Keystore (AES-256-GCM) + `SharedPreferences.commit()` |

### NativeCrypto

Spec: `specs/NativeCrypto.ts`

| Platform | Implementation | Backing API |
|---|---|---|
| iOS | `ios/EnboxMobile/NativeCrypto/` (Obj-C++) | CommonCrypto (SHA-256, PBKDF2) + Security.framework |
| Android | `android/.../nativemodules/NativeCryptoModule.kt` | `PBKDF2WithHmacSHA256` + `MessageDigest` + `SecureRandom` |

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
  lib/auth/            PIN hashing (PBKDF2) and format validation
  lib/enbox/           SDK adapters: LevelDB, secure storage, agent init, connect
  lib/storage/         Thin wrapper around NativeSecureStorage
  navigation/          React Navigation setup
  providers/           App-wide providers
  theme/               Design tokens
ios/                   Xcode project + native module implementations
android/               Gradle project + native module implementations
```

## Architecture

- **No Expo** -- full control over native projects. `ios/` and `android/` are committed and maintained directly.
- **Turbo Modules + Codegen** -- native module interfaces are declared as TypeScript specs. Codegen generates C++/ObjC/Java glue code at build time.
- **@enbox/* SDK runs natively** -- no browser dependencies, no WebView wrapper. Storage uses native LevelDB, crypto uses platform APIs, connect uses relay + deep links.
- **Real PIN auth** -- PBKDF2-SHA256 (100k iterations + random salt) via native crypto, stored in Keychain/Keystore. Constant-time hash comparison.
- **Auto-lock** -- app locks immediately when backgrounded via AppState listener.
- **Exponential lockout** -- 5 attempts per cycle, progressive durations (30s, 1m, 5m, 15m, 1h). Persists across restarts.
- **Conditional navigation** -- screens swap declaratively based on session state. Lock/unlock/reset all work via state changes, not imperative navigation.

## CI

| Job | Runner | What it validates |
|---|---|---|
| `verify` | `ubuntu-latest` | Lint, typecheck, 34 unit tests |
| `build-android` | `ubuntu-latest` | Full Gradle debug build (Codegen + Kotlin + APK). Cached. Uploads artifact. |
| `build-ios` | `macos-14` | CocoaPods + full Xcode debug build (Codegen + Obj-C++). Cached. |

## Planning

See [docs/planning.md](docs/planning.md) for the web-wallet portability assessment and delivery roadmap.
