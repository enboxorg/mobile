# Environment

Environment variables, external dependencies, and host-level setup notes.

**What belongs here:** Required env vars, tool versions, external API dependencies, platform quirks.
**What does NOT belong here:** Commands or service ports (see `.factory/services.yaml`), system architecture (see `architecture.md`), testing surface (see `user-testing.md`).

---

## Toolchain

- **Node:** >= 22.11.0 (verified: 22.x). Declared in `package.json` `engines`.
- **Bun:** 1.3.11 verified. Used as the primary package manager (`bun install`, `bun run <script>`).
- **TypeScript:** 5.8.3 (via devDeps). Strict mode on.
- **Jest:** 29.6.3. Always invoked with `--runInBand` via `bun run test`.
- **gh CLI:** 2.45.0, authenticated with `repo` scope on this host. Used for `gh workflow run`, `gh run watch`, `gh run download`.
- **git:** 2.43.0. Default branch `master`.
- **python3:** 3.10.6 (used only inside CI emulator flow scripts; not required locally).

## Not installed on the orchestrator/worker host

Workers run on a Linux host WITHOUT these — do not attempt to use them locally:

- No Java / JDK
- No Android SDK / emulator / ADB
- No Xcode / CocoaPods / macOS
- No ffmpeg, no Jupyter, no Docker

Any step requiring an Android build, iOS build, or emulator MUST run on GitHub Actions (`ci.yml`, `build-apk.yml`, `debug-emulator.yml`). Workers trigger those via `gh` CLI and validate via artifact inspection.

## React Native specifics

- React Native 0.85 (bare project, no Expo).
- New Architecture enabled (Fabric + Turbo Modules). Codegen runs at build time on CI.
- Metro resolver override in `metro.config.js` rewrites `level` imports in `@enbox/*` packages to `src/lib/enbox/rn-level.ts`.
- `scripts/apply-patches.mjs` runs on `postinstall`. Existing patches for `react-native-leveldb` (Android gradle + iOS env_posix.cc) must be preserved; the mission adds an `@enbox/agent` vault-injection patch.
- `react-native-camera-kit`'s iOS static permission helper has a shipped type/runtime mismatch: `checkDeviceCameraAuthorizationStatus()` is typed as `Promise<boolean>` in the generated spec, but the native implementation returns `-1` for `AVAuthorizationStatus.notDetermined`. Scanner permission code should treat `-1` as "not determined" instead of assuming a strict boolean.
- No metro/dev server is expected to run under a worker session — tests only.

## External APIs / services

- **@enbox/* SDK packages** (agent, auth, crypto, dids, dwn-clients, protocols, api, common) installed from npm. No network access at runtime required by tests.
- **DWN discovery:** disabled on mobile by the `AgentDwnApi` monkey-patch in `agent-init.ts` (`localDwnStrategy === 'off'`). Tests must not regress this.
- **WalletConnect relay:** used at runtime for the `enbox://connect` flow. Not required for unit tests — mocked.

## Environment variables

No mission-specific environment variables. The app itself has no `.env` file; all config is committed.

## GitHub Actions runners

- `ci.yml`: `ubuntu-latest` (verify + build-android) and `macos-14` (build-ios).
- `debug-emulator.yml`: `ubuntu-latest` with KVM enabled; uses `reactivecircus/android-emulator-runner@v2` at API 31 / x86_64 / `pixel_5`, headless, `-no-window -gpu swiftshader_indirect`.
- `build-apk.yml`: `ubuntu-latest`.

## Host resources

This orchestrator host has 257 GB RAM / 32 cores. Workers may run multiple `rg`/`jest` invocations in parallel when helpful; however, Jest itself is pinned to `--runInBand` to avoid flakes with React Native's jest-preset.

## Jest + polyfills quirk (local-only)

`src/lib/polyfills.ts` installs diagnostic wrappers around
`globalThis.crypto.subtle` methods for RN/Hermes diagnostics. Those
wrappers used to mutate Node's built-in `SubtleCrypto` when the module
was loaded under Jest and left the runner hanging on exit (open-handle
leaks exit 1 even when every test passes). The module now gates the
`wrapSubtleMethod(...)` calls behind
`if (process.env.NODE_ENV !== 'test')`, so Jest skips them while RN
still installs them on device. Tests that need to `require()` the
polyfills module can do so directly — no `globalThis.crypto.subtle`
workaround is required.

## Bun cache gotcha (local-only)

Bun 1.3.11 caches the **post-install** contents of packages at `~/.bun/install/cache/<pkg>@<ver>@@@<n>`. Consequently, after the first `bun install` on a given host, `scripts/apply-patches.mjs` persists its widened `@enbox/agent` and `react-native-leveldb` output INTO the cache. A subsequent `rm -rf node_modules && bun install --frozen-lockfile` then reuses that already-patched cached extraction and `scripts/apply-patches.mjs` prints nothing because all targets are already patched.

**Implication:** if you (or a validator) need to reproduce the fresh-install postinstall log output for `@enbox/agent` / `react-native-leveldb` on a host that has already installed once, you must clear the cache entries for those two packages first:

```bash
mv ~/.bun/install/cache/@enbox/agent@* /tmp/ 2>/dev/null || true
mv ~/.bun/install/cache/react-native-leveldb* /tmp/ 2>/dev/null || true
rm -rf node_modules
bun install --frozen-lockfile   # now prints [postinstall] Patched ... lines
```

CI runners start with an empty cache so this is a local-only concern. Jest tests for patch logging (`src/lib/enbox/__tests__/enbox-agent-patch.test.ts`) avoid the cache entirely by mutating the already-installed `node_modules/` files and re-running the script directly.
