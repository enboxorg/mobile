# iOS Target Membership for Turbo Native Modules

> Worker-facing reference. Read this before touching
> `ios/EnboxMobile.xcodeproj/project.pbxproj`, `ios/Podfile`, `package.json`
> `codegenConfig.ios.modulesProvider`, or any native module under
> `ios/EnboxMobile/<Module>/`. The goal is that future React Native upgrades
> (and any new Turbo Module additions) keep target-membership in a sane,
> predictable state.

## TL;DR

The EnboxMobile iOS app has **three** Turbo Native Modules — `NativeSecureStorage`,
`NativeCrypto`, and `NativeBiometricVault` — and they are **not all wired up the
same way**:

| Module                 | Target membership mechanism                                       |
| ---------------------- | ----------------------------------------------------------------- |
| `NativeSecureStorage`  | Codegen-via-Pods only (`use_native_modules!` + `modulesProvider`) |
| `NativeCrypto`         | Codegen-via-Pods only (`use_native_modules!` + `modulesProvider`) |
| `NativeBiometricVault` | Codegen-via-Pods **+ explicit pbxproj entries** (belt-and-suspenders) |

The `NativeBiometricVault` pbxproj entries are intentional and redundant; they
were added during `fix-native-biometric-scrutiny-blockers` (commit `08a6b24`)
in response to a scrutiny blocker to make the Xcode target membership
unambiguous for reviewers. They coexist with the codegen/Pods flow (the Pod
build system tolerates a source file being declared twice — each declaration
still compiles exactly once because CocoaPods produces a separate
`libPods-EnboxMobile.a` library target and the app target's sources phase only
lists the file in one place).

The other two modules intentionally do **not** have explicit pbxproj entries
and are compiled only via the codegen/Pods flow. That has been the working
configuration since the initial scaffold (`55520d8`).

## How codegen-via-Pods gives target membership

`ios/Podfile` calls `use_native_modules!` inside the `EnboxMobile` target.
Combined with the project's `codegenConfig` in `package.json`:

```json
"codegenConfig": {
  "name": "EnboxNativeModulesSpec",
  "type": "modules",
  "jsSrcsDir": "specs",
  "ios": {
    "modulesProvider": {
      "NativeSecureStorage": "RCTNativeSecureStorage",
      "NativeCrypto": "RCTNativeCrypto",
      "NativeBiometricVault": "RCTNativeBiometricVault"
    }
  }
}
```

the following happens on `pod install`:

1. RN codegen reads `specs/Native*.ts` and generates the `EnboxNativeModulesSpec`
   protocol headers + JSI shims under `ios/build/generated/ios/`.
2. The generated `EnboxNativeModulesSpec` Pod is added to the `Pods` project.
3. For every entry in `modulesProvider`, codegen produces a `ModulesProvider`
   class registration that maps the module name (`"NativeBiometricVault"`)
   to the Obj-C++ class (`RCTNativeBiometricVault`).
4. `use_native_modules!` / `use_react_native!` then autolinks the app's
   native module sources by walking `ios/EnboxMobile/**/*.mm`, adding them
   to a CocoaPod-managed library target (`Pods-EnboxMobile`), and linking
   that library into the app binary (`libPods-EnboxMobile.a`).

Net result: `RCTNativeSecureStorage.mm` and `RCTNativeCrypto.mm` are compiled
through the `Pods-EnboxMobile` library target even though they appear
nowhere in `ios/EnboxMobile.xcodeproj/project.pbxproj`. The JSI shim
connects `NativeSecureStorage` in JS to the Obj-C++ class by the string
constant `+ (NSString *)moduleName` on the class.

## Why `NativeBiometricVault` got explicit pbxproj entries

Scrutiny round 1 of the `native-biometric-vault` milestone flagged target
membership of `RCTNativeBiometricVault.{h,mm}` as a blocker: reviewers could
not _visibly_ confirm the file was built into the app without launching
Xcode, because the only on-disk evidence was the codegen/Pods chain.

Commit `08a6b24` addressed that by adding:

- `PBXFileReference` entries for `RCTNativeBiometricVault.h` and
  `RCTNativeBiometricVault.mm` (stable IDs `BV000001..BV000005`).
- A `PBXGroup` (`BV000005…`) named `NativeBiometricVault`, pathed under
  `EnboxMobile/NativeBiometricVault`, childed by the two file refs.
- A `PBXBuildFile` entry and a `PBXSourcesBuildPhase` entry for
  `RCTNativeBiometricVault.mm` so `rg 'NativeBiometricVault'
  ios/EnboxMobile.xcodeproj/project.pbxproj` returns ≥6 matches
  (validation contract `VAL-NATIVE-*`).
- Framework links for `LocalAuthentication.framework` and `Security.framework`
  were added to the `Frameworks` group + `PBXFrameworksBuildPhase` in a
  follow-up commit (`3357626`, `fix-pbxproj-framework-linkage`). These are
  required because they are system frameworks that `use_native_modules!` does
  not autolink for this module.

The file path in the pbxproj entries was initially double-qualified
(`EnboxMobile/NativeBiometricVault/RCTNativeBiometricVault.mm` under a group
that was _also_ pathed to `EnboxMobile/NativeBiometricVault`), which caused
Xcode to look in `EnboxMobile/NativeBiometricVault/EnboxMobile/NativeBiometricVault/…`.
That was fixed in `6e1b415` (`fix-pbxproj-path-doubling`) by setting each
file reference's `path` to just the bare filename.

## Why the other two modules were not given parallel pbxproj entries

- They are not security-critical in the same way the biometric vault is, and
  no scrutiny reviewer flagged them.
- They have been compiling successfully via the codegen/Pods flow since the
  initial scaffold (`55520d8`). Stability is the evidence.
- Adding pbxproj entries for them introduces risk with no testable upside in
  this environment: the host has no Xcode, so a regression could not be
  caught locally. CI `build-ios` would be the only signal.
- Symmetry across modules is not required for correctness; the three modules
  currently ship with three different file layouts under
  `ios/EnboxMobile/Native*`, and that has not been a problem.

## Invariants for future RN upgrades

When a worker upgrades React Native (0.85 → 0.86 → …) or adds a new Turbo
Native Module, they **must** preserve these invariants:

1. **The module-name string matches across JS / iOS / Android / `modulesProvider` /
   `jest.setup.js`.** Any drift = silent runtime crash. See
   `.factory/library/architecture.md` §3.4 and validation assertion
   `VAL-NATIVE-031`.
2. **`codegenConfig.ios.modulesProvider` contains one entry per iOS-backed
   module**, keyed by the string passed to `TurboModuleRegistry.getEnforcing`
   and valued with the Obj-C++ class name. Removing an entry breaks iOS
   module resolution even if the `.mm` file still compiles.
3. **`use_native_modules!` must remain inside the `target 'EnboxMobile'`
   block** in `ios/Podfile`. Without it, CocoaPods will not autolink the
   native module sources.
4. **Do not add pbxproj entries for `RCTNativeSecureStorage.*` or
   `RCTNativeCrypto.*`** unless you (a) have verified the iOS build still
   produces exactly one object file per source (check
   `build-ios` logs for "duplicate symbol" warnings), and (b) update this
   doc to reflect the new configuration.
5. **Do not remove the existing `NativeBiometricVault` pbxproj entries**
   (`BV000001..BV000005`, plus the `LocalAuthentication.framework` /
   `Security.framework` entries `LA000001A…`, `LA000002A…`, `SE000001A…`,
   `SE000002A…`). They are the belt in "belt-and-suspenders" and the
   explicit Xcode-visible proof that the scrutiny blocker stays addressed.
   Removing them will reopen the round-1 scrutiny finding.
6. **If RN's codegen/autolink system changes shape** (e.g. React Native
   introduces a different mechanism than `use_native_modules!` + Podfile
   + `modulesProvider`) the migration must **either** (a) add explicit
   pbxproj entries for all three modules, or (b) ensure the new mechanism
   still produces the same net effect (sources compiled into the app
   target; module-name strings resolve). Document whichever choice was
   made in this file.

## How to verify target membership

Static (no Xcode required, safe on any host):

```bash
# NativeBiometricVault — explicit pbxproj entries must exist.
rg -n "RCTNativeBiometricVault\.(h|mm)|NativeBiometricVault" \
  ios/EnboxMobile.xcodeproj/project.pbxproj | head

# All three modules must appear in codegenConfig.ios.modulesProvider.
node -e 'const p=require("./package.json");
const m=p.codegenConfig.ios.modulesProvider;
for (const k of ["NativeSecureStorage","NativeCrypto","NativeBiometricVault"]) {
  if (!m[k]) { console.error("missing provider entry:", k); process.exit(1); }
}
console.log("modulesProvider OK");'

# Podfile must call use_native_modules! inside the target.
rg -n "use_native_modules!" ios/Podfile
```

Dynamic (macOS + Xcode required, only in CI `build-ios`):

- `ci.yml` → `build-ios` job: compile Debug Simulator. Success means **all**
  three `.mm` files reached the app binary via whichever path (codegen/Pods
  for NSS / NC, codegen/Pods **and** pbxproj for NativeBiometricVault).
- `pod install` output will include lines like `Installing NativeBiometricVault`
  or confirm `use_native_modules!` picked up the module directories.

## Related files & commits

- `ios/EnboxMobile.xcodeproj/project.pbxproj` — the Xcode project file. Manual
  edits are fragile; changes must preserve the strict block structure
  (`PBXBuildFile`, `PBXFileReference`, `PBXGroup`, `PBXSourcesBuildPhase`).
- `ios/Podfile` — autolink entry point.
- `package.json` → `codegenConfig` — the only place `modulesProvider` should
  be edited.
- `08a6b24` (`fix-native-biometric-scrutiny-blockers`) — original pbxproj
  entries for `NativeBiometricVault`.
- `6e1b415` (`fix-pbxproj-path-doubling`) — fixes path-doubling in those
  entries.
- `3357626` (`fix-pbxproj-framework-linkage`) — adds `LocalAuthentication`
  and `Security` framework links.
- `.factory/library/native-biometric-vault-platform-gotchas.md` — module-specific
  gotchas (references this doc).
- `.factory/library/architecture.md` §3.2, §3.4 — high-level system map.
