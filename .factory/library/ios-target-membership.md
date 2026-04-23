# iOS Target Membership for Turbo Native Modules

> Worker-facing reference. Read this before touching
> `ios/EnboxMobile.xcodeproj/project.pbxproj`, `ios/Podfile`, `package.json`
> `codegenConfig.ios.modulesProvider`, or any native module under
> `ios/EnboxMobile/<Module>/`. The goal is that future React Native upgrades
> (and any new Turbo Module additions) keep target-membership in a sane,
> predictable state.
>
> **This doc has been audited against the actual repo contents (misc-1
> scrutiny round 2, feature `fix-ios-target-membership-doc-accuracy`).
> Every concrete claim below cites a file + line. Claims that cannot be
> verified from the repo alone are explicitly marked
> `unverified / not applicable on this host`.**

## TL;DR

The EnboxMobile iOS app has **three** Turbo Native Modules —
`NativeSecureStorage`, `NativeCrypto`, and `NativeBiometricVault` — declared
in `package.json` `codegenConfig.ios.modulesProvider`
(`package.json` lines 20–33). Only **one** of them — `NativeBiometricVault` —
has explicit entries in `ios/EnboxMobile.xcodeproj/project.pbxproj`:

| Module                 | Explicit pbxproj entries?                                                           | Evidence                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `NativeSecureStorage`  | **No.** `rg 'RCTNativeSecureStorage' ios/EnboxMobile.xcodeproj/project.pbxproj` is empty. | Listed in `codegenConfig` (`package.json` line 28); source file at `ios/EnboxMobile/NativeSecureStorage/RCTNativeSecureStorage.mm`. |
| `NativeCrypto`         | **No.** `rg 'RCTNativeCrypto' ios/EnboxMobile.xcodeproj/project.pbxproj` is empty.        | Listed in `codegenConfig` (`package.json` line 29); source file at `ios/EnboxMobile/NativeCrypto/RCTNativeCrypto.mm`.              |
| `NativeBiometricVault` | **Yes.** 9 lines match `BV00*` plus 11 lines match `NativeBiometricVault`.          | Added in commit `08a6b24` (`fix-native-biometric-scrutiny-blockers`). See section "NativeBiometricVault pbxproj entries" below.     |

The `NativeBiometricVault` pbxproj entries are intentional and were added in
response to a scrutiny blocker to make the Xcode target membership visibly
unambiguous to reviewers without launching Xcode. They are also considered
redundant with React Native's Pods-based autolink mechanism, but **we do
NOT have in-repo evidence that autolink compiles
`RCTNativeSecureStorage.mm` or `RCTNativeCrypto.mm` into the app binary on
this host** — see "Codegen + Pods mechanism (unverified on this host)"
below. The canonical signal that all three modules are actually built into
the app is the CI `build-ios` job; there is no `ios/Podfile.lock` checked
into the repo and no local Xcode available on the dev host to verify
statically from on-disk artifacts.

## NativeBiometricVault pbxproj entries (evidenced)

`RCTNativeBiometricVault.{h,mm}` and their two system framework dependencies
are wired into the Xcode project by the following entries in
`ios/EnboxMobile.xcodeproj/project.pbxproj`:

- **`PBXBuildFile`** (Sources build phase for `.mm`, Headers for `.h`):
  - Line 14 — `BV000001A00000000000000A /* RCTNativeBiometricVault.mm in Sources */`
  - Line 15 — `BV000003A00000000000000C /* RCTNativeBiometricVault.h in Headers */`
- **`PBXFileReference`**:
  - Line 31 — `BV000002A00000000000000B /* RCTNativeBiometricVault.mm */` (`path = RCTNativeBiometricVault.mm`)
  - Line 32 — `BV000004A00000000000000D /* RCTNativeBiometricVault.h */` (`path = RCTNativeBiometricVault.h`)
- **`PBXGroup` for the module** (`name = NativeBiometricVault`,
  `path = EnboxMobile/NativeBiometricVault`):
  - Lines 64–72 — group `BV000005A00000000000000E` childed by the `.h` and `.mm`
    file references (lines 67–68).
  - Line 59 — parent `EnboxMobile` group cites the `BV000005A…` child.
- **`PBXSourcesBuildPhase` entry**:
  - Line 271 — `BV000001A00000000000000A /* RCTNativeBiometricVault.mm in Sources */`
    inside the `13B07F871A680F5B00A75B9A /* Sources */` phase.
- **System framework links** (required because they are Apple-provided
  frameworks that autolink mechanisms do not pull in for this module):
  - `LocalAuthentication.framework`:
    - Line 16 — `PBXBuildFile` (`LA000001A00000000000F001`)
    - Line 33 — `PBXFileReference` (`LA000002A00000000000F002`, `path = System/Library/Frameworks/LocalAuthentication.framework`)
    - Line 43 — listed inside the `Frameworks` build phase (`13B07F8C1A680F5B00A75B9A`)
    - Line 79 — listed inside the `Frameworks` group (`2D16E6871FA4F8E400B85C8A`)
  - `Security.framework`:
    - Line 17 — `PBXBuildFile` (`SE000001A00000000000F003`)
    - Line 34 — `PBXFileReference` (`SE000002A00000000000F004`, `path = System/Library/Frameworks/Security.framework`)
    - Line 44 — listed inside the `Frameworks` build phase
    - Line 80 — listed inside the `Frameworks` group

Commit history for these entries:

- `08a6b24` (`fix-native-biometric-scrutiny-blockers`) — original `BV00…` entries.
- `6e1b415` (`fix-pbxproj-path-doubling`) — fixes a path-doubling bug by
  setting each `PBXFileReference.path` to the bare filename.
- `3357626` (`fix-pbxproj-framework-linkage`) — adds
  `LocalAuthentication.framework` and `Security.framework` entries above.

## Codegen + Pods mechanism (unverified on this host)

> ⚠ **Unverified on this host / not applicable as a static claim.** The
> claims in this section describe the React Native Turbo Module autolink
> mechanism in general terms. They are NOT evidenced in this repo because
> (a) `ios/Podfile.lock` is not checked in, (b) the dev host has no Xcode
> and no CocoaPods cache, and (c) no pbxproj entry inside this repo refers
> to `RCTNativeSecureStorage.mm` or `RCTNativeCrypto.mm`. The only
> first-party signal that these two modules actually end up in the app
> binary is **CI `build-ios`** succeeding on the mission branch. Treat the
> rest of this section as a design intent, not a verified invariant.

**Design intent.** `ios/Podfile` (line 17: `target 'EnboxMobile' do`,
line 18: `config = use_native_modules!`) invokes RN's autolink helper
inside the app target. Combined with `package.json` `codegenConfig`
(`package.json` lines 20–33):

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

the intended effect is:

1. `pod install` runs RN codegen, which reads `specs/Native*.ts` and emits
   the `EnboxNativeModulesSpec` protocol headers + JSI shims somewhere
   under `ios/build/generated/` or the Pods project. **(Unverified in
   repo — output directory depends on RN version; no generated files
   are committed.)**
2. Each entry in `modulesProvider` is turned into a class-registration
   mapping so the JS-side module name resolves to the Obj-C++ class.
   **(Unverified in repo — depends on RN `TurboModule` provider
   generation.)**
3. `use_native_modules!` / `use_react_native!` is expected to walk the
   app's native module source directories and link them via the
   Pods-managed library target `Pods-EnboxMobile`. Evidence this target
   exists in general: `project.pbxproj` line 10 references
   `libPods-EnboxMobile.a` in the Frameworks build phase. **Whether
   `RCTNativeSecureStorage.mm` / `RCTNativeCrypto.mm` are actually pulled
   into that library is NOT verifiable from the repo.**

**What we can verify statically without CocoaPods or Xcode:**

- The source files exist at their expected paths:
  `ios/EnboxMobile/NativeSecureStorage/RCTNativeSecureStorage.{h,mm}` and
  `ios/EnboxMobile/NativeCrypto/RCTNativeCrypto.{h,mm}`.
- Their Obj-C++ classes adopt the codegen-generated spec protocols
  (`RCTNativeSecureStorage.h:6` declares `<NativeSecureStorageSpec>`;
  `RCTNativeCrypto.h:6` declares `<NativeCryptoSpec>`).
- `package.json` `codegenConfig.ios.modulesProvider` maps their JS names
  to these class names (`package.json` lines 28–30).
- `ios/Podfile` line 17 opens `target 'EnboxMobile' do` and line 18
  calls `config = use_native_modules!` inside that target.

Everything else about how they reach the app binary must be taken on
faith from RN's docs **or** proven by a green CI `build-ios` run.

## Why `NativeBiometricVault` got explicit pbxproj entries

Scrutiny round 1 of the `native-biometric-vault` milestone flagged target
membership of `RCTNativeBiometricVault.{h,mm}` as a blocker: reviewers
could not _visibly_ confirm the file was built into the app without
launching Xcode, because at the time the only on-disk evidence would
have been the codegen + Pods chain (which this repo cannot validate
statically — see above).

Commit `08a6b24` addressed that by adding the `BV00…` entries documented
above, so that `rg 'NativeBiometricVault'
ios/EnboxMobile.xcodeproj/project.pbxproj` returns ≥6 matches (the
validation-contract floor for `VAL-NATIVE-*` target-membership
assertions). This is the reviewer-visible proof that the vault file is
in the app's Sources build phase regardless of whether autolink also
picks it up.

## Why the other two modules were not given parallel pbxproj entries

- They are not security-critical in the same way the biometric vault is,
  and no scrutiny reviewer flagged them as blocking.
- Parallel pbxproj entries for them could only be safely added together
  with a CI `build-ios` run that confirms no "duplicate symbol" linker
  errors. The dev host has no Xcode, so a regression could not be caught
  locally, and the current verify gate (`bun run verify`) does not
  include an iOS build.
- Symmetry across modules is **not** required for correctness; only the
  vault's pbxproj entries were requested by scrutiny. Adding entries for
  the other two would be scope creep.

## Invariants for future RN upgrades

When a worker upgrades React Native or adds a new Turbo Native Module,
they **must** preserve these invariants:

1. **Module-name string matches across JS / iOS / Android /
   `modulesProvider` / `jest.setup.js`.** Any drift = silent runtime
   crash. See `.factory/library/architecture.md` §3.4 and validation
   assertion `VAL-NATIVE-031`.
2. **`codegenConfig.ios.modulesProvider` contains one entry per
   iOS-backed module**, keyed by the string passed to
   `TurboModuleRegistry.getEnforcing` and valued with the Obj-C++ class
   name. Removing an entry breaks iOS module resolution even if the
   `.mm` file still compiles.
3. **`use_native_modules!` must remain inside the `target 'EnboxMobile'`
   block** in `ios/Podfile` (currently `ios/Podfile` line 17 +
   line 18). Removing it would break the RN autolink pathway that the
   non-vault modules rely on.
4. **Do not add pbxproj entries for `RCTNativeSecureStorage.*` or
   `RCTNativeCrypto.*`** unless you (a) have a CI `build-ios` run
   confirming no duplicate-symbol errors, and (b) update this doc to
   reflect the new configuration.
5. **Do not remove the existing `NativeBiometricVault` pbxproj entries**
   (`BV000001A…`–`BV000005A…`, plus `LA000001A…`, `LA000002A…`,
   `SE000001A…`, `SE000002A…`). Removing them reopens the round-1
   scrutiny finding and removes the only in-repo proof that the vault
   source is in the app's Sources build phase.
6. **If RN's codegen/autolink system changes shape** (e.g., a different
   mechanism replaces `use_native_modules!` + Podfile + `modulesProvider`),
   the migration must either (a) add explicit pbxproj entries for all
   three modules, or (b) ensure the new mechanism still produces the same
   net effect (sources compiled into the app target; module-name strings
   resolve). Document whichever choice was made here.

## How to verify target membership (concrete, repo-runnable)

Run the following from the repo root. All commands are read-only and
safe on any host.

```bash
# 1. NSS and NC are NOT in the pbxproj — expect zero matches.
rg -n 'RCTNativeSecureStorage|RCTNativeCrypto' ios/EnboxMobile.xcodeproj/project.pbxproj \
  && echo "UNEXPECTED: doc claim violated — NSS/NC now in pbxproj" \
  || echo "OK: NSS/NC not in pbxproj (matches doc)"

# 2. NSS/NC source files + spec conformance DO live under ios/EnboxMobile/.
rg -n 'RCTNativeSecureStorage|RCTNativeCrypto' ios/

# 3. NativeBiometricVault IS in the pbxproj — expect ≥6 matches.
grep -n 'NativeBiometricVault' ios/EnboxMobile.xcodeproj/project.pbxproj | wc -l
# Also: the BV00* stable IDs used by commit 08a6b24.
grep -n 'BV00' ios/EnboxMobile.xcodeproj/project.pbxproj | wc -l

# 4. Framework linkage for the vault (LocalAuthentication + Security).
grep -n 'LocalAuthentication\.framework\|Security\.framework' \
  ios/EnboxMobile.xcodeproj/project.pbxproj

# 5. Podfile still invokes use_native_modules! inside the app target.
rg -n 'use_native_modules!' ios/Podfile

# 6. codegenConfig still lists all three JS-side names + Obj-C++ classes.
node -e 'const p=require("./package.json");
const m=p.codegenConfig.ios.modulesProvider;
for (const k of ["NativeSecureStorage","NativeCrypto","NativeBiometricVault"]) {
  if (!m[k]) { console.error("missing provider entry:", k); process.exit(1); }
}
console.log("modulesProvider OK");'
```

Expected output summary:

- (1) prints `OK: NSS/NC not in pbxproj (matches doc)`.
- (2) prints the spec-protocol adoption lines plus `.mm` file headers.
- (3) prints `11` then `9`.
- (4) prints 8 lines (2 PBXBuildFile + 2 PBXFileReference + 2 Frameworks
  phase entries + 2 Frameworks group entries).
- (5) prints a single hit in `ios/Podfile`.
- (6) prints `modulesProvider OK`.

Dynamic verification (only possible in CI, not on the dev host):

- `.github/workflows/ci.yml` → `build-ios` job: builds Debug Simulator.
  A green run is the only in-repo-reachable proof that **all three**
  `.mm` files reached the app binary, via whichever linking path
  (pbxproj Sources phase for the vault; codegen-via-Pods autolink, if it
  works as documented upstream, for NSS / NC).

## Related files & commits

- `ios/EnboxMobile.xcodeproj/project.pbxproj` — the Xcode project file.
  Manual edits are fragile; changes must preserve the strict block
  structure (`PBXBuildFile`, `PBXFileReference`, `PBXGroup`,
  `PBXSourcesBuildPhase`, `PBXFrameworksBuildPhase`).
- `ios/Podfile` — autolink entry point (line 17 target, line 18
  `use_native_modules!`).
- `ios/Podfile.lock` — **not checked in.** Generated at CI `pod install`
  time.
- `package.json` → `codegenConfig` (lines 20–33) — the only place
  `modulesProvider` should be edited.
- `08a6b24` (`fix-native-biometric-scrutiny-blockers`) — original pbxproj
  entries for `NativeBiometricVault`.
- `6e1b415` (`fix-pbxproj-path-doubling`) — fixes path-doubling in those
  entries.
- `3357626` (`fix-pbxproj-framework-linkage`) — adds `LocalAuthentication`
  and `Security` framework links.
- `.factory/library/native-biometric-vault-platform-gotchas.md` —
  module-specific gotchas (references this doc).
- `.factory/library/architecture.md` §3.2, §3.4 — high-level system map.
