# Biometric-First Native Vault — Architecture

> Worker-facing reference. Read this **before** touching any file in the mission.
> Mission issue: https://github.com/enboxorg/mobile/issues/1

This document captures the high-level shape of the post-refactor system: what
the app is, how the vault + agent lifecycle works, which components own which
concerns, the invariants you must not break, and how work is validated. It is
deliberately short and scannable — defer to the mission file and the
validation contract for exact assertions.

---

## 1. System map

Bare **React Native 0.85** iOS + Android app (no Expo). Single-user wallet app
built on the **Enbox SDK** (`@enbox/*` packages) integrated natively on the
device; there is no backend server owned by this repo.

### Runtime stack

- **UI:** React Native 0.85, React Navigation, TanStack Query (used sparingly
  for any future server state).
- **State (app-local):** Zustand stores
  - `src/features/session/session-store.ts` — biometric/session gate state.
  - `src/lib/enbox/agent-store.ts` — in-memory `EnboxUserAgent` instance +
    initialize/unlock/teardown actions.
  - Wallet-connect store.
- **SDK:** `@enbox/agent`, `@enbox/auth`, `@enbox/crypto`, etc.
- **Native bridge:** React Native **Turbo Modules** (codegen’d from
  `specs/*.ts`).

### Polyfills / native shims (required for the SDK to run on RN)

| Purpose                                 | Package                     |
| --------------------------------------- | --------------------------- |
| WebCrypto / getRandomValues / subtle    | `react-native-quick-crypto` |
| Web Streams (used by DWN / agent)       | `web-streams-polyfill`      |
| LevelDB (agent + DWN stores)            | `react-native-leveldb`      |
| Turbo Module: biometric-free secure KV  | `NativeSecureStorage`       |
| Turbo Module: low-level crypto helpers  | `NativeCrypto`              |
| **Turbo Module (new): biometric vault** | **`NativeBiometricVault`**  |

### Key directories

```
specs/                                # Turbo Module codegen specs
ios/EnboxMobile/NativeBiometricVault/ # iOS impl (Objective-C++ .h/.mm)
android/app/src/main/java/org/enbox/mobile/nativemodules/  # Android Kotlin
src/lib/enbox/                        # JS vault + agent init + stores
src/features/auth/screens/            # Onboarding + unlock screens
src/features/session/                 # Session store + route matrix
src/navigation/                       # App navigator (gate)
src/hooks/                            # useAutoLock, etc.
scripts/apply-patches.mjs             # postinstall @enbox + leveldb patcher
scripts/emulator-debug-flow.py        # CI Android e2e driver
.github/workflows/                    # ci.yml, build-apk.yml, debug-emulator.yml
```

---

## 2. Post-refactor vault + agent lifecycle

The PIN / JWE flow is gone. There is **exactly one** long-lived secret on the
device: a 32-byte random blob stored under the keychain/keystore alias
`enbox.wallet.root`, gated by biometrics, invalidated on enrollment change. The
HD seed, the 24-word BIP-39 mnemonic, and the `BearerDid` are **derived** from
this secret every time the app unlocks.

### 2.1 First launch (fresh install)

```
Welcome  →  BiometricAvailabilityCheck
            ├── unavailable / not-enrolled → BiometricUnavailable (hard gate)
            └── ready → BiometricSetup
                         └── initialize()
                              1. NativeBiometricVault.generateAndStoreSecret(
                                   'enbox.wallet.root',
                                   { requireBiometrics: true,
                                     invalidateOnEnrollmentChange: true })
                              2. Derive HD seed from the 32-byte secret
                                 (mirrors HdIdentityVault recipe via @enbox/crypto)
                              3. Derive 24-word BIP-39 mnemonic from seed
                              4. Load BearerDid
                              5. Return mnemonic (shown once)
                         → RecoveryPhrase (displayed once, user confirms backup)
                         → Main
```

### 2.2 Relaunch (vault exists, app was killed or backgrounded)

```
BiometricUnlock
  └── NativeBiometricVault.getSecret('enbox.wallet.root', prompt) [biometric prompt]
       → reconstruct HD seed → reconstruct BearerDid → agent ready
       → Main
```

### 2.3 Background / inactive

- `use-auto-lock` observes `AppState`.
- On `background`/`inactive`: `sessionStore.lock()` **and**
  `agentStore.teardown()` fire **immediately** (no grace period, no timeout).
- Foregrounding therefore always hits `BiometricUnlock`.

### 2.4 Invalidation (user added/removed biometric enrollment)

```
getSecret → rejects with code KEY_INVALIDATED
  → sessionStore.biometricStatus = 'invalidated'
  → navigator routes to RecoveryRestore
  → user enters 24-word mnemonic
    → derive seed → NativeBiometricVault.generateAndStoreSecret (re-seal)
    → Main
```

### 2.5 Unavailable / not enrolled

Hard gate. `BiometricUnavailable` screen with an **Open Settings** CTA, shown
regardless of `hasCompletedOnboarding`, `hasIdentity`, `isLocked`, or pending
wallet-connect requests. No PIN fallback in release.

---

## 3. Component map & responsibilities

### 3.1 Turbo Module spec — `specs/NativeBiometricVault.ts`

JS-visible surface (exactly these methods, no more):

| Method                      | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `isBiometricAvailable()`    | `{ available, enrolled, type, reason? }` — drives `biometricStatus`.    |
| `generateAndStoreSecret()`  | Random 32-byte secret → biometric-gated keystore/keychain item.         |
| `getSecret()`               | Prompts biometrics, returns secret as lower-case hex.                   |
| `hasSecret()`               | Non-authenticated existence check for `enbox.wallet.root`.              |
| `deleteSecret()`            | Idempotent delete (missing alias must resolve, not reject).             |

Exported as `TurboModuleRegistry.getEnforcing<Spec>('NativeBiometricVault')`.

Canonical error codes (must be identical across iOS + Android):

```
BIOMETRY_UNAVAILABLE | BIOMETRY_NOT_ENROLLED | BIOMETRY_LOCKOUT
  | BIOMETRY_LOCKOUT_PERMANENT | USER_CANCELED | AUTH_FAILED
  | KEY_INVALIDATED | NOT_FOUND | VAULT_ERROR
```

### 3.2 iOS — `ios/EnboxMobile/NativeBiometricVault/`

- `RCTNativeBiometricVault.{h,mm}` (Objective-C++).
- Storage: **Keychain** `kSecClassGenericPassword`, service string namespaced
  under `org.enbox.mobile.biometric` (must differ from
  `RCTNativeSecureStorage`'s `org.enbox.mobile.secure`).
- Access control: `SecAccessControlCreateWithFlags(...)`
  - `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` (no iCloud sync, passcode required).
  - `kSecAccessControlBiometryCurrentSet` (enrollment change → item invalidated).
- Availability: `LAContext.canEvaluatePolicy(LAPolicyDeviceOwnerAuthenticationWithBiometrics)`.
- **No passcode fallback.** Do **not** use `LAPolicyDeviceOwnerAuthentication`.
- Requires `NSFaceIDUsageDescription` in `ios/EnboxMobile/Info.plist`.

### 3.3 Android — `android/app/src/main/java/org/enbox/mobile/nativemodules/NativeBiometricVaultModule.kt`

- Keystore AES-256-GCM key. `KeyGenParameterSpec`:
  - `setUserAuthenticationRequired(true)`
  - `setInvalidatedByBiometricEnrollment(true)`
  - `setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)`
    (**no** `DEVICE_CREDENTIAL`)
  - `setBlockModes(GCM)`, `setEncryptionPaddings(NONE)`, `setKeySize(256)`.
- Decrypt: `BiometricPrompt.authenticate(PromptInfo, CryptoObject(cipher))`.
- Availability: `BiometricManager.from(ctx).canAuthenticate(BIOMETRIC_STRONG)`.
- Manifest: `USE_BIOMETRIC` + `USE_FINGERPRINT`.
- Gradle: `implementation("androidx.biometric:biometric:<pinned-version>")`.
- `KeyPermanentlyInvalidatedException → KEY_INVALIDATED`.

### 3.4 Registration glue

| Platform | File                                                                                               | What it registers                                             |
| -------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| iOS      | `package.json` → `codegenConfig.ios.modulesProvider`                                                | `NativeBiometricVault: RCTNativeBiometricVault`               |
| Android  | `.../nativemodules/NativeModulesPackage.kt`                                                         | `getModule` + `getReactModuleInfoProvider` entries            |

The string `"NativeBiometricVault"` must match **exactly** across the spec,
iOS `moduleName`, Android `NAME`, `modulesProvider` key, and the
`jest.mock('./specs/NativeBiometricVault', ...)` path. Any drift = silent
runtime crash.

### 3.5 JS biometric vault — `src/lib/enbox/biometric-vault.ts`

Implements `@enbox/agent`'s `IdentityVault<{ InitializeResult: string }>`
interface. Internally calls `NativeBiometricVault` and derives crypto material
using `@enbox/crypto` utilities, mirroring `HdIdentityVault`'s recipe so the
produced `BearerDid` is deterministic w.r.t. the native 32-byte secret.

| Method                         | Behavior                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `initialize({ dwnEndpoints })` | `hasSecret` guard → `generateAndStoreSecret` → derive HD seed + 24-word mnemonic → return mnemonic (one-shot).   |
| `unlock()`                     | `getSecret` (biometric prompt) → reconstruct HD seed → load `BearerDid` → in-memory state set.                   |
| `lock()`                       | Zero in-memory seed/DID state. Native key stays put.                                                             |
| `isInitialized()`              | `NativeBiometricVault.hasSecret('enbox.wallet.root')`.                                                           |
| `isLocked()`                   | In-memory flag.                                                                                                  |
| `getStatus()`                  | Standard `IdentityVaultStatus` + Enbox extension `biometricState`.                                               |
| `backup()` / `restore()`       | Mnemonic-based. `restore()` re-seals the native secret from the mnemonic-derived seed.                           |
| `encryptData` / `decryptData`  | Delegate to the in-memory seed-derived key (required by `@enbox/auth` `AuthManager`).                            |

Error surface (stable codes consumed by the store + screens):
`VAULT_ERROR_ALREADY_INITIALIZED`, `VAULT_ERROR_NOT_INITIALIZED`,
`VAULT_ERROR_LOCKED`, `VAULT_ERROR_BIOMETRICS_UNAVAILABLE`,
`VAULT_ERROR_USER_CANCELED`, `VAULT_ERROR_KEY_INVALIDATED`,
`VAULT_ERROR_BIOMETRY_LOCKOUT`.

### 3.6 `@enbox/agent` patch — `scripts/apply-patches.mjs`

Postinstall patcher. Widens `EnboxUserAgent.create({ agentVault })` (and the
exported type) from the concrete `HdIdentityVault` class to the existing
`IdentityVault` **interface**:

- Patch targets:
  - `node_modules/@enbox/agent/dist/types/enbox-user-agent.d.ts`
  - `node_modules/@enbox/agent/dist/esm/enbox-user-agent.js`
- Preserves the default `new HdIdentityVault(...)` fallback when `agentVault`
  is omitted (other consumers unaffected).
- **Idempotent** (re-running produces byte-identical output).
- Must leave the existing `react-native-leveldb` patches intact.
- Uses a type-only import for `IdentityVault`: `import type { IdentityVault }
  from './types/identity-vault.js'` (runtime barrel does not export it).

### 3.7 Agent init — `src/lib/enbox/agent-init.ts`

Constructs a single `EnboxUserAgent` wired with:

- `agentVault: new BiometricVault(...)` (our class above).
- `AuthManager` from `@enbox/auth`.
- `RNLevel` adapter for the agent + DWN stores (via `rn-level.ts`).
- `AgentDwnApi.prototype.agent` setter **monkey patch** that skips
  `LocalDwnDiscovery` on mobile and forces `localDwnStrategy: 'off'`.

### 3.8 Agent store — `src/lib/enbox/agent-store.ts`

Zustand store exposing:

- `initializeFirstLaunch()` — **no** password argument; delegates to
  `biometricVault.initialize()`, returns the mnemonic to the UI for one-shot
  display.
- `unlockAgent()` — **no** password argument; triggers the biometric prompt
  via the vault.
- `teardown()` — disposes the in-memory agent; the next unlock rebuilds from
  scratch.

### 3.9 Session store — `src/features/session/session-store.ts`

```ts
type SessionSnapshot = {
  hasCompletedOnboarding: boolean;
  hasIdentity: boolean;
  isLocked: boolean;
  biometricStatus:
    | 'unknown'        // not yet probed
    | 'unavailable'    // no biometric hw
    | 'not-enrolled'   // hw present, no enrollment
    | 'ready'          // healthy
    | 'invalidated';   // enrollment changed, must restore
};
```

- **No** PIN / lockout / attempt-count fields. Any reference to them in the
  session store is a regression.
- Status transitions cover: `unknown → unavailable | not-enrolled | ready`,
  `ready → invalidated`, `invalidated → ready` (after restore).

### 3.10 Auto-lock — `src/hooks/use-auto-lock.ts`

Listens to `AppState`. On `background` or `inactive`:

1. `sessionStore.lock()` (flips `isLocked: true`).
2. `agentStore.teardown()` (drops the in-memory `EnboxUserAgent`).

No timer. No foreground grace period. The next foreground always requires a
biometric prompt.

### 3.11 Navigation — `src/navigation/app-navigator.tsx`

Route stack param names (canonical, legacy `CreatePin`/`Unlock` removed):

```
BiometricUnavailable | Welcome | BiometricSetup | RecoveryPhrase
  | BiometricUnlock  | RecoveryRestore | Main
  | WalletConnectRequest | WalletConnectScanner
```

Gate matrix (VAL-UX-028). `getInitialRoute(snapshot)`:

| biometricStatus | hasCompletedOnboarding | isLocked | Route                  |
| --------------- | ---------------------- | -------- | ---------------------- |
| `unavailable`   | any                    | any      | `BiometricUnavailable` |
| `not-enrolled`  | any                    | any      | `BiometricUnavailable` |
| `invalidated`   | any                    | any      | `RecoveryRestore`      |
| `ready`         | `false`                | any      | `Welcome`              |
| `ready`         | `true`, no vault yet   | any      | `BiometricSetup`       |
| `ready`         | `true`, pending backup | any      | `RecoveryPhrase`       |
| `ready`         | `true`, vault ready    | `true`   | `BiometricUnlock`      |
| `ready`         | `true`, vault ready    | `false`  | `Main`                 |
| `unknown`       | any                    | any      | defers (loading)       |

`BiometricUnavailable` is a **hard gate** — it outranks any pending
wallet-connect request.

### 3.12 Auth screens — `src/features/auth/screens/`

Each of these is a new screen with its own Jest component test:

- `biometric-unavailable-screen.tsx` — hardware gate, "Open Settings" CTA.
- `biometric-setup-screen.tsx` — first-launch enroll confirmation + "Enable
  biometric unlock" button that drives `initializeFirstLaunch()`.
- `biometric-unlock-screen.tsx` — relaunch unlock via biometric prompt.
- `recovery-phrase-screen.tsx` — **one-shot** mnemonic display after
  first-launch init; user confirms backup.
- `recovery-restore-screen.tsx` — mnemonic input, re-seals the native secret.

The legacy `create-pin-screen.tsx` and `unlock-screen.test.tsx` are **deleted**.

---

## 4. Data flows & invariants

### Single source of truth

> The **only** secret persisted on-device is the biometric-gated native blob
> under `enbox.wallet.root`.

Everything else (HD seed, mnemonic, DID, agent instance) is derived from that
blob and held **only in memory**.

### Mnemonic handling

- Shown **once**, on the `RecoveryPhrase` screen, immediately after first-launch
  initialization.
- Never persisted by the app.
- Never logged, never included in crash reports, never sent to analytics.
- Accepted by the `RecoveryRestore` flow to re-seal the native secret.

### Deterministic identity

Same 32-byte secret → same HD seed → same `BearerDid`. This must hold across:

- Unlocks on the same device.
- Restores from the same mnemonic (on the same device or a reinstall).

### Agent lifecycle

- Constructed on `initializeFirstLaunch()` and `unlockAgent()`.
- Lives **in memory only**.
- Torn down on background (see §3.10).
- Rebuilt on next unlock.

### Reset

Reset = `NativeBiometricVault.deleteSecret('enbox.wallet.root')` + wipe
LevelDB stores + `sessionStore.reset()` + `agentStore.teardown()`.

### Restore

Restore = accept mnemonic → derive seed → `generateAndStoreSecret` (re-seal)
→ continue to `Main`. Never force-loss: a healthy mnemonic is always enough
to recover.

---

## 5. Testing & validation layers

### Local (every milestone)

```
bun run lint          # ESLint
bun run typecheck     # tsc --noEmit
bun run test          # Jest, unit + component
bun run verify        # the three above
```

- `jest.setup.js` mocks `specs/NativeBiometricVault` (and the pre-existing
  `NativeSecureStorage`, `NativeCrypto` mocks are preserved).
- `@enbox/agent` is mocked at construction boundaries so Jest never boots the
  real runtime.
- Component tests drive navigation gates via `react-navigation`'s test renderer.
- Patched file assertions are executed via `rg`/`grep` checks on
  `node_modules/@enbox/agent/dist/...`.

### CI

| Workflow                          | What it does                                                                |
| --------------------------------- | --------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`        | lint + typecheck + test + **Android debug build** + **iOS debug build**.    |
| `.github/workflows/build-apk.yml` | Release-ish APK build.                                                      |
| `.github/workflows/debug-emulator.yml` | Android emulator end-to-end (API 31, Pixel 5, headless, KVM).          |

### Emulator end-to-end (Milestone 5 only)

Driver: `scripts/emulator-debug-flow.py`. Highlights:

- `enroll_fingerprint()` helper:
  `adb shell locksettings set-pin 0000` → open the fingerprint-enroll intent →
  loop `adb -e emu finger touch 1` until the UI says "Fingerprint added".
- Waits for Welcome → taps **Get started**.
- Taps **Enable biometric unlock** on `BiometricSetup`.
- Detects the system `BiometricPrompt` (`com.android.systemui`) and fires
  `adb -e emu finger touch 1`.
- Screenshots `RecoveryPhrase`, scrolls until the `I’ve saved it` button
  is visible, then taps that anchor.
- Asserts the main wallet UI ("Identities" tab, etc.).
- Force-stops + relaunches, satisfies the prompt again, confirms Main.

Dispatch from a dev machine:

```bash
scripts/run-ci-emulator.sh   # wraps: gh workflow run debug-emulator.yml --ref <branch>
```

Artifacts: `logcat-rn.txt`, `emulator-ui-artifacts/*.png`, UI dumps.

---

## 6. Security posture (release builds)

Summary of the non-negotiable security requirements from the issue:

- **Biometrics only. No passcode / device-credential fallback.**
  - iOS: `SecAccessControlCreateWithFlags(kSecAccessControlBiometryCurrentSet, ...)`
    + `LAPolicyDeviceOwnerAuthenticationWithBiometrics`. **Do not** use
    `LAPolicyDeviceOwnerAuthentication`.
  - Android: `AUTH_BIOMETRIC_STRONG` only. **Never** OR in `DEVICE_CREDENTIAL`.
- **Enrollment-change invalidation (fail-closed).** Adding/removing a finger
  or face → key becomes unusable → `KEY_INVALIDATED` → `RecoveryRestore`.
- **No sync / no backup of the key material.**
  - iOS: iCloud Keychain sync disabled (do not set `kSecAttrSynchronizable`).
  - Android: app `allowBackup` disabled, or `ENBOX_AGENT/` prefs and the
    biometric-vault storage explicitly excluded from backup.
- **Screen capture prevention.**
  - Android: `FLAG_SECURE` on the window while `RecoveryPhrase` /
    `RecoveryRestore` are visible.
  - iOS: obscure the app switcher snapshot over sensitive screens.
- **No secrets in logs.** Mnemonic and secret bytes must not appear in any
  `console.log`, Bugsnag/Sentry breadcrumb, logcat, or Xcode console output —
  even in debug builds.

---

## 7. Preserved patches (DO NOT REGRESS)

These predate the mission and must survive unchanged.

### 7.1 `react-native-leveldb` (Android gradle)

- `scripts/apply-patches.mjs` removes the package-local `buildscript { ... }`
  block in `node_modules/react-native-leveldb/android/build.gradle` and
  ensures the `repositories` block contains `google()`.
- Regression check:

  ```bash
  grep -n "^buildscript" node_modules/react-native-leveldb/android/build.gradle   # must be empty
  grep -n "google()"     node_modules/react-native-leveldb/android/build.gradle   # must match
  ```

### 7.2 `react-native-leveldb` (iOS `env_posix.cc`)

- `scripts/apply-patches.mjs` rewrites `std::memory_order::memory_order_relaxed`
  (invalid in this toolchain) to a valid form in
  `node_modules/react-native-leveldb/cpp/leveldb/util/env_posix.cc`.
- Regression check:

  ```bash
  grep -n "std::memory_order::memory_order_relaxed" \
    node_modules/react-native-leveldb/cpp/leveldb/util/env_posix.cc   # must be empty
  ```

### 7.3 `AgentDwnApi.prototype.agent` monkey patch (agent-init.ts)

- Overrides the setter on `AgentDwnApi.prototype` so that the agent skips
  `LocalDwnDiscovery` on mobile.
- Forces `localDwnStrategy: 'off'` when wiring the agent.
- This was added to unblock earlier crashes during DWN bring-up; removing it
  re-introduces those crashes.

### 7.4 RNLevel adapter (`src/lib/enbox/rn-level.ts`)

- LazyOpen: the underlying `react-native-leveldb` DB is opened on first use,
  not at construction time.
- Flattened directory names (avoids RN storage path quirks).
- `notFound` semantics match the node `level` package (used by `@enbox/agent`'s
  key lookups).

---

## 8. Quick orientation for new workers

Before you write any code:

1. **Read the mission** (`mission.md`) and the relevant **Area** of
   `validation-contract.md` for your milestone. Every change must trace back
   to a `VAL-*` assertion.
2. **Run `bun run verify` on a clean branch first** to make sure the tree is
   green before you start. Any new failure is something you introduced.
3. **Mock, don't boot.** Jest must never spin up the real `EnboxUserAgent`,
   the real native modules, or a real emulator. The harness lives in
   `jest.setup.js`.
4. **Touch `node_modules/` only via `scripts/apply-patches.mjs`.** Never
   commit edits under `node_modules/`. `git status --porcelain node_modules`
   must stay empty.
5. **Preserve the patches in §7.** When in doubt, re-run `node
   scripts/apply-patches.mjs` and diff before + after.
6. **Do not re-introduce PIN code.** `CreatePin`, `Unlock`, `pin-hash`,
   `pin-format`, lockout counters — all removed. Any new reference is a
   regression.
7. **Strings match across platforms.** The module name
   `"NativeBiometricVault"`, the keychain alias `enbox.wallet.root`, and the
   error codes in §3.1 are contract-stable identifiers; treat them as such.
8. **Biometrics-only in release.** No device-credential fallback, no "set a
   PIN as backup", no silent unauthenticated fallback in
   `generateAndStoreSecret` (see VAL-NATIVE-033).

When unsure, prefer failing closed (requiring restore from mnemonic) over
degrading security.
