# User Testing Surface

Runtime knowledge for the `user-testing-validator`. Complements `validation-contract.md` by describing *how* to test each area. Validators update this file with findings as the mission progresses.

## Validation surfaces

This mission has two testing surfaces:

### 1. Jest component / unit surface (local, default)

- **Tool:** Jest 29 + `@testing-library/react-native` 13.
- **Command:** `bun run test` (always `--runInBand`).
- **What it covers:** Everything that can be exercised against mocked native modules and mocked `@enbox/*` modules — i.e. all of VAL-PATCH, VAL-NATIVE (JS wrapper), VAL-VAULT, VAL-UX, VAL-CROSS that doesn't require real biometrics.
- **Concurrency:** 1. Do not enable parallel workers.
- **Resource cost:** trivial (<60s on this host for the full suite).
- **Isolation:** each test file gets a fresh module registry; `jest.setup.js` installs per-test mocks for `@specs/NativeSecureStorage`, `@specs/NativeCrypto`, `@specs/NativeBiometricVault` (to be added), `react-native-leveldb`, `AppState`, etc.
- **Credentials:** none.
- **Common anchors the CI script (and thus tests) rely on:**
  - `"Get started"` (Welcome)
  - `"Enable biometric unlock"` (BiometricSetup)
  - `"Unlock with"` prefix (BiometricUnlock)
  - `"I’ve saved it"` (RecoveryPhrase confirm button)
  - `"Restore wallet"` (RecoveryRestore)
  - `"Open Settings"` (BiometricUnavailable)

### 2. CI Android emulator surface (final milestone only)

- **Tool:** GitHub Actions (`debug-emulator.yml`) via `gh workflow run` / `gh run watch` / `gh run download`. Driver script: `scripts/run-ci-emulator.sh` (to be added by `run-ci-emulator-wrapper` feature).
- **What it covers:** VAL-CI-001..037 plus smoke of VAL-CROSS at real integration.
- **Runner:** `ubuntu-latest` with KVM; API 31 x86_64 `pixel_5`; headless; single concurrency.
- **Resource cost:** HIGH (~25 min per run, consumes ~1 job hour of CI quota). Treat each dispatch as expensive.
- **Isolation:** `force-avd-creation: true` recreates the AVD on each run; `adb logcat -c` clears logs pre-run; `adb uninstall org.enbox.mobile` not required because APK install reinstalls.
- **Biometric automation:** `adb shell locksettings set-pin 0000` sets a device PIN (required before enrolling fingerprints on Android). Enrollment via the Settings fingerprint intent + `adb -e emu finger touch 1` loop. Prompt satisfaction at runtime via the same `emu finger touch 1` command once the `com.android.systemui` BiometricPrompt overlay is visible.
- **Credentials:** none beyond `GITHUB_TOKEN` (provided by the runner).
- **Sensitive UI dump caveat:** `uiautomator dump` captures text even for
  screens whose PNG screenshots are blocked by `FLAG_SECURE`. Do not
  treat `*.xml` dumps as automatically safe. In particular, the
  `RecoveryPhrase` screen's dump must be redacted or skipped before
  upload, and validators should scan uploaded XML dumps for mnemonic or
  other secret-bearing text, not just `logcat-*.txt`.
- **Content-aware RecoveryPhrase XML sanitization (VAL-CI,
  scrutiny round 2 2026-04-24):**
  `scripts/emulator-debug-flow.py` runs every uiautomator dump
  through `_sanitize_bip39_xml` **before** writing it to disk, regardless
  of the destination filename. Detection is content-driven, not
  filename-driven: if any `<node>` `text` / `content-desc` attribute
  contains the case-insensitive substring `recovery phrase` (matches
  the screen title "Back up your recovery phrase" and the grid
  wrapper's `content-desc="Recovery phrase"`) **or** ≥3 node
  attribute values match the canonical 2048-word BIP-39 English
  wordlist (embedded at `scripts/bip39_wordlist.py`), the dump is
  treated as RecoveryPhrase-bearing and every 3–8 char lowercase
  BIP-39 wordlist hit in `text` / `content-desc` is replaced with
  the literal string `[redacted]`. Otherwise the pulled bytes are
  returned byte-for-byte unchanged.
  - This closes the failure-path leak flagged in scrutiny round 2:
    `window_dump.xml` (overwritten by every `uidump` call) and
    `flow-error.xml` (captured when the flow crashes) are now
    scrubbed whenever they contain RecoveryPhrase content, not only
    when the destination filename happens to start with
    `recovery-phrase`.
  - Structural nodes (hierarchy wrappers, the
    `"Back up your recovery phrase"` title, the body copy, the
    `"1."`–`"24."` index labels, and the
    `content-desc="Recovery phrase"` grid wrapper) are preserved
    verbatim so validators can still assert the screen was reached.
  - The 3+ wordlist-hit threshold tolerates a single stray BIP-39
    entry (e.g. a Settings screen literally showing the verb
    `update`) without a false-positive redaction on unrelated dumps.
  - Self-test: `python3 scripts/emulator-debug-flow.py --self-test`
    exercises (a) direct RecoveryPhrase dump — redacts all cells,
    (b) `flow-error.xml` shape containing the RecoveryPhrase
    hierarchy — redacts all cells, (c) clean `welcome.xml` — byte-
    exact passthrough, (d) `welcome.xml` with one stray BIP-39
    word — byte-exact passthrough.

## Why `agent-browser` and `tuistory` do not apply

- This is a React Native **mobile app**. It has no web surface — there's no URL, no browser, no HTML. `agent-browser` is inapplicable.
- It is not a TUI — it's a full GUI on iOS/Android. `tuistory` is inapplicable.

The only real-device test surface is the CI Android emulator, automated via `adb` + `uiautomator dump`. Workers/validators should not try to repurpose `agent-browser` or `tuistory` here.

## Assertion → surface mapping

The contract file `validation-contract.md` labels each assertion with its `Tool:` field. Summary:

- **VAL-PATCH-\***: Jest + file-system assertions + shell greps. Local only.
- **VAL-NATIVE-001..006, 031 (spec + codegen)**: Local file + typecheck.
- **VAL-NATIVE-007..021, 037..042 (iOS / Android native)**: CI build success (`ci.yml`) + code-level grep of implementation files. No runtime biometric exercise from the validator — enforced by build + static checks.
- **VAL-NATIVE-022..030, 033..036 (JS wrapper)**: Jest.
- **VAL-VAULT-\***: Jest (against mocked NativeBiometricVault).
- **biometric-vault-js note:** most local `VAL-VAULT-*` evidence currently lives in the consolidated `src/lib/enbox/__tests__/biometric-vault.test.ts` plus focused companions like `biometric-vault.lock.test.ts`, `biometric-vault.reset.test.ts`, and `biometric-vault.invalidation.test.ts`, even where the contract prose names split test files.
- **VAL-UX-\***: Jest component tests (`@testing-library/react-native`).
- **VAL-CI-\***: CI emulator + artifact inspection (milestone 5 only).
- **VAL-CROSS-001..010, 013, 014**: Jest RTL integration tests + file grep.
- **VAL-CROSS-011 (no-secret-in-logs)**: Jest `console.*` spies AND, at milestone 5, `logcat` / workflow stdout regex.
- **VAL-CROSS-012 (no crash reporter)**: file-system grep (absence of sentry/bugsnag/crashlytics imports).

## Isolation approach used

- **Per-test:** Jest module registry reset; `jest.setup.js` provides deterministic native-module mocks.
- **Cross-feature:** no shared state across validator runs — each spawned validator reads only `validation-contract.md`, `validation-state.json`, and the repo at HEAD.
- **CI emulator:** `force-avd-creation: true`; emulator is discarded at job end.

## Known constraints

- The Jest preset for React Native is sensitive; enabling multi-worker Jest has historically caused flakes — keep `--runInBand`.
- `uiautomator dump` on cold emulator startup can miss the first frame. The CI flow script is expected to poll with bounded retries (see VAL-CI-010).
- The CI emulator runner has finite disk; the workflow already frees `/usr/share/dotnet` + Android NDK ghosts before building. Do not add large artifact steps that break this budget.
- For `VAL-PATCH-007`, avoid a plain `grep "IdentityVault"` on the ESM bundle because it also matches the valid `HdIdentityVault` fallback symbol as a substring; use an exact-word regex or import-specific guard instead.
- For local `VAL-PATCH-001` reruns on Bun 1.3.11, a plain fresh repo copy is not enough once the host has installed before: Bun reuses postinstall-mutated cache entries for `@enbox/agent` and `react-native-leveldb`. To reproduce the expected `[postinstall] Patched ...` lines, validate in a temp repo copy **and** temporarily move only those package cache entries out of `~/.bun/install/cache/`, then restore them after the install completes.
- For build-only assertions backed by GitHub Actions (`VAL-NATIVE-013`, `VAL-NATIVE-021`, and later CI assertions), compare the successful run's `headSha` to the local branch tip before treating the run as authoritative. If local `HEAD` is ahead of `origin/<branch>`, existing green runs do not cover the newer commits and the assertion should stay blocked until CI runs on the newer tip.
- If the only `ci.yml` run for the exact branch tip is still `in_progress`, wait on that run with `gh run watch <run-id>` before deciding build-backed assertions. Do not freeze `VAL-NATIVE-013` / `VAL-NATIVE-021` from older runs while the matching-HEAD run is still executing.
- For local onboarding-ux `VAL-UX-004`, the contract grep `unlock-screen` is broader than the legacy file name and also matches `src/features/auth/screens/biometric-unlock-screen.test.tsx` in `bun run test -- --listTests`; treat that match as a real contract failure until the grep is narrowed or the file naming changes.
- For local onboarding-ux negative token sweeps like `VAL-UX-002`, `VAL-UX-040`, and `VAL-UX-042`, the contract scans include test files/comments under `src/`; retained PIN/passcode strings in assertion text, comments, or static-regression tests still fail those assertions even if runtime UI behavior is otherwise correct.

## Validation Concurrency

- **Surface: jest-local**
  - Max concurrent validators: `1`
  - Reason: the authoritative local surface is `bun run test` with Jest `--runInBand`, plus shell/file assertions against a single shared working tree and `node_modules/`.
- **Surface: ci-android-emulator**
  - Max concurrent validators: `1`
  - Reason: emulator runs are expensive, mutate shared GitHub Actions branch state, and the mission guidance allows only one outstanding CI emulator dispatch at a time.

## Flow Validator Guidance: jest-local

- Isolation boundary: the shared repository checkout at `/home/liran/src/enboxorg/mobile`.
- Allowed tools: local shell commands, Jest, file reads/greps, and temporary files under `.factory/validation/<milestone>/user-testing/` plus mission evidence directories.
- Do not start browsers, TUIs, Android emulators, Gradle, Xcode, or other native-build tooling for milestone `patch-injection`.
- Keep execution single-threaded: do not enable parallel Jest workers and do not spawn nested validators.
- Do not edit product code while validating. Only write the assigned flow report and evidence artifacts.
- For patch-injection assertions, prefer the real local user-facing validation surface defined by the contract: `bun install --frozen-lockfile`, `bun run verify`, shell greps, and smoke scripts against the patched `@enbox/agent` package.

## Flow Validator Guidance: native-biometric-vault-local

- Isolation boundary: the shared repository checkout at `/home/liran/src/enboxorg/mobile`, using only read-only repo inspection commands plus validation artifact writes under `.factory/validation/native-biometric-vault/user-testing/` and the mission evidence directory.
- Allowed tools: `bun run verify`, targeted Jest invocations, `rg`/file reads, and read-only `gh` inspection of existing GitHub Actions runs needed for `VAL-NATIVE-013` and `VAL-NATIVE-021`.
- Do not dispatch new workflows, push commits, start emulators, or run Gradle/Xcode locally. For this milestone, CI build validation comes from inspecting already-completed `ci.yml` runs on `mission/biometric-vault`.
- Keep execution single-threaded: at most one validator at a time and no nested validators.
- Do not edit product code while validating. Only write the assigned flow report and any evidence notes/artifacts.

## Update policy

`user-testing-validator` may append to this file with:
- Runtime findings (e.g., new anchors the script discovered)
- Isolation approach refinements
- Newly discovered constraints

Workers (non-validator) should treat this file as read-only reference.
