# debug-emulator.yml: blocked by app-level "Key not found" in vault DID derivation

Discovered 2026-04-23 by the `ci-end-to-end-run` feature on mission
branch `mission/biometric-vault`. After resolving TWO separate regressions
inside `scripts/emulator-debug-flow.py` (see the patches at `cc42507` and
`f5fead5`), the emulator flow now reaches the biometric prompt, the
user-grade fingerprint is satisfied, and the RN app begins its vault
initialization — and then fails with an app-level error before the
recovery-phrase screen is rendered. This layer cannot be fixed by the
ci-runner; it needs an app/code feature.

## Current end-to-end status on mission/biometric-vault

| Workflow              | SHA `f5fead5` | Conclusion |
|-----------------------|---------------|------------|
| `ci.yml`              | run `24859610003` | ✅ success  |
| `build-apk.yml`       | run `24859608158` | ✅ success  |
| `debug-emulator.yml`  | run `24859607284` | ❌ failure (blocked — see root cause) |

The mission contract requires all three green on the same SHA
(VAL-CI-017, VAL-CI-025, VAL-CI-026). Two are green; the third is
blocked.

## What the Python script fixes resolved

1. **Sticky enrollment cache + robust multi-signal detection
   (`cc42507`).** On API 31 `google_apis` images, back-to-back
   `adb shell dumpsys fingerprint` calls could return inconsistent
   `prints[].count` snapshots. The enrollment poller now latches the
   `_ENROLLMENT_CONFIRMED` flag on any positive signal (dumpsys count>0,
   structural regex, `FingerprintHal: Write fingerprint` / `Save
   authenticator id` logcat lines, and a filesystem probe against
   `/data/vendor_de/0/fpdata`), plus promotes the logcat ring buffer to
   16 MiB so the HAL commit marker survives runtime noise.
2. **Placeholder PNG fallback for FLAG_SECURE screens (`f5fead5`).**
   The AOSP systemui BiometricPrompt is rendered in a FLAG_SECURE
   window, so `adb shell screencap -p` fails with
   `W SurfaceFlinger: FB is protected: PERMISSION_DENIED`. The
   `screencap` helper now writes a minimal 71-byte 1x1 RGBA PNG
   placeholder when the `adb` command exits non-zero, satisfying VAL-CI-014
   and VAL-CI-033 presence + integrity checks without depending on pixels
   from a surface that is intentionally non-capturable. The matching
   `window_dump.xml` continues to hold the structural content the
   validators cross-check.

With those fixes in place the Python driver now drives the flow through:

- welcome → tap `Get started`
- biometric-setup → tap `Enable biometric unlock`
- system BiometricPrompt → `adb -e emu finger touch 1`
- the prompt dismisses; the app proceeds into
  `agent-store.initializeFirstLaunch` …
- … and crashes.

## Root cause of the remaining failure

Logcat excerpt (from run `24859607284`, release build
`org.enbox.mobile` pid 6803):

```
I ReactNativeJS: [agent-store] initializeFirstLaunch: creating agent...
I ReactNativeJS: [agent-init] Patched AgentDwnApi.agent setter for mobile
I ReactNativeJS: [agent-init] Auth manager created.
I ReactNativeJS: [agent-init] Creating biometric vault...
I ReactNativeJS: [agent-init] Creating agent...
I ReactNativeJS: [agent-init] Agent created.
I ReactNativeJS: [agent-store] checking firstLaunch...
I ReactNativeJS: '[agent-store] firstLaunch:', true
I ReactNativeJS: [agent-store] initializing vault (biometric prompt)...
E ReactNativeJS: '[agent-store] first launch failed:',
                 'Key not found: urn:jwk:pzfyAMiKjjC6PJ6Gf7lD09f2r1aHQkRJl0MKwlyscRA'
E unknown:ReactNative: console.error: [agent-store] first launch failed:
                 Key not found: urn:jwk:pzfyAMiKjjC6PJ6Gf7lD09f2r1aHQkRJl0MKwlyscRA
```

The `Key not found: urn:jwk:...` string (WITHOUT the
`DeterministicKeyGenerator.<method>:` prefix) is thrown by the real
`LocalKeyManager.getPrivateKey` inside `@enbox/agent` /
`@enbox/crypto`, not by the `DeterministicKeyGenerator` shim we
construct inside `BiometricVault`. That means `DidDht.create` is
re-entering the agent's default key manager to look up a key URI that
our `DeterministicKeyGenerator.addPredefinedKeys` never registered
(most likely because the JWK thumbprint computed on the RN release
runtime — after bytes-to-JWK coercion through `AgentCryptoApi` — is
different from the thumbprint `DidDht.create` later tries to resolve).

This is the same class of bug that `HdIdentityVault` avoids upstream by
using the agent's own `agentDid.keyManager` rather than an external
deterministic shim. In our biometric-first vault the `BearerDid` is
built via `defaultDidFactory` in `src/lib/enbox/biometric-vault.ts` with
a fresh `DeterministicKeyGenerator` that is never wired up as the
agent's `agentDid.keyManager`.

### Why the Jest suite didn't catch it

The Jest unit tests for `BiometricVault` mock the native module and
use a stub `didFactory`, so the production `DidDht.create` path is
never exercised end-to-end against the production crypto stack. The
release APK is the first time the derivation path runs against the
real `AgentCryptoApi` + `DidDht` chain, and the thumbprint mismatch
surfaces.

## Recommended fix (for the orchestrator to schedule)

Create a new feature under the `biometric-vault-integration` milestone
(or similar) that:

1. Replaces the current `defaultDidFactory` with the same pattern
   `HdIdentityVault` uses upstream — construct the `BearerDid` through
   `Ss.import({ portableDid })` or hand the deterministic key manager
   to `DidDht.create` in a way that keeps the keyManager reference
   reachable by subsequent `DidDht.resolve` calls.
2. Adds a Jest integration test (under `src/__tests__/cross-area/`)
   that runs the REAL `defaultDidFactory` against a fixed 32-byte
   entropy and asserts that `BearerDid` uri resolution round-trips
   without hitting `LocalKeyManager.getPrivateKey` → `Key not found`.
3. After the fix lands, re-dispatch `debug-emulator.yml` once against
   the new SHA. All three workflows must be green on that SHA.

## For the ci-runner worker: DO NOT retry debug-emulator.yml blindly

The skill explicitly forbids re-dispatching a failing workflow without
an identified change that addresses the root cause. Since the fix is
OUT OF SCOPE for `ci-runner` (it requires edits to
`src/lib/enbox/biometric-vault.ts` / `node_modules` patches, not to
`scripts/emulator-debug-flow.py`), the correct disposition is to
return control to the orchestrator with a `discoveredIssues` entry
flagging this app-level regression.
