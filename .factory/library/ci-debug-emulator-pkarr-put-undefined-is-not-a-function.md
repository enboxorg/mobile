# debug-emulator.yml: blocked by "undefined is not a function" in Pkarr PUT

Discovered 2026-04-23 by the `ci-end-to-end-run` feature on mission
branch `mission/biometric-vault` at SHA `2a259473`. The previous
blocker (`Key not found: urn:jwk:...` inside `LocalKeyManager.sign`)
was resolved by commit `2a25947`
(`fix-deterministic-key-generator-sign-override`). Re-dispatching
`debug-emulator.yml` (run `24861822390`) exposes a new app-level
failure, one layer further inside `DidDht.create`'s publication step.

## Current end-to-end status on mission/biometric-vault at 2a259473

| Workflow              | Run                                                         | Conclusion |
|-----------------------|-------------------------------------------------------------|------------|
| `ci.yml`              | https://github.com/enboxorg/mobile/actions/runs/24861825094 | ✅ success  |
| `build-apk.yml`       | https://github.com/enboxorg/mobile/actions/runs/24859608158 (on parent f5fead5) | ✅ success (one commit behind) |
| `debug-emulator.yml`  | https://github.com/enboxorg/mobile/actions/runs/24861822390 | ❌ failure (blocked — see root cause) |

The diff between `f5fead5` and `2a25947` is entirely inside
`src/lib/enbox/biometric-vault.ts` (the `sign()` override) plus a new
Jest integration test and its snapshot. No native / gradle / pod
changes — the APK built at `f5fead5` is behaviorally equivalent for
the build-apk workflow contract. The prior `build-apk.yml` run on
`f5fead5` is green (`24859608158`). Dispatching `build-apk.yml` on
`2a25947` is reasonable but not required by the JS-level changes.

## What the `sign()` override fix resolved

Logcat `logcat-rn.txt` from run `24861822390` no longer contains the
`Key not found: urn:jwk:pzfyAMiKjjC6PJ6Gf7lD09f2r1aHQkRJl0MKwlyscRA`
line that blocked the preceding run. The flow now drives the agent
past `DidDht.create`'s internal `keyManager.sign({ keyUri, data })`
call — signing the DID document succeeds with the Ed25519 keys we
pre-loaded via `DeterministicKeyGenerator.addPredefinedKeys`.

## Root cause of the new failure

`logcat-rn.txt` now ends with:

```
I ReactNativeJS: [agent-store] initializeFirstLaunch: creating agent...
I ReactNativeJS: [agent-init] Patched AgentDwnApi.agent setter for mobile
I ReactNativeJS: [agent-init] Creating auth manager...
I ReactNativeJS: [agent-init] Auth manager created.
I ReactNativeJS: [agent-init] Creating biometric vault...
I ReactNativeJS: [agent-init] Creating agent...
I ReactNativeJS: [agent-init] Agent created.
I ReactNativeJS: [agent-store] checking firstLaunch...
I ReactNativeJS: '[agent-store] firstLaunch:', true
I ReactNativeJS: [agent-store] initializing vault (biometric prompt)...
E ReactNativeJS: '[agent-store] first launch failed:',
                 'internalError: internalError: Failed to put Pkarr record
                  for identifier thdtwfzi4p74dqoqjx4gae9j75x7ezyrbyb6cr3gaqcn1mipinxy:
                  undefined is not a function'
```

The error text "`Failed to put Pkarr record for identifier <zbase32>:
undefined is not a function`" is thrown by `pkarrPut` in
`node_modules/@enbox/dids/src/methods/did-dht-pkarr.ts`:

```ts
try {
  response = await fetch(url, {
    method  : 'PUT',
    headers : { 'Content-Type': 'application/octet-stream' },
    body,
    signal  : AbortSignal.timeout(30_000),   // <-- suspect call
  });
} catch (error: any) {
  throw new DidError(
    DidErrorCode.InternalError,
    `Failed to put Pkarr record for identifier ${identifier}: ${error.message}`
  );
}
```

The double-nested `internalError: internalError:` prefix comes from
the outer `DidDht.create` wrapping this `DidError` once more. The
inner `error.message === 'undefined is not a function'` is a JS-level
`TypeError.message` surfaced from within the `fetch(...)` call.

### Why `AbortSignal.timeout(30_000)` is the most likely culprit

- React Native's Hermes 0.85 runtime does not guarantee the static
  factory `AbortSignal.timeout`. It was added to WHATWG spec in 2021
  and to Node.js 17.3 / 18, but Hermes' AbortController impl has
  historically lagged: `AbortController`/`AbortSignal` instances are
  present (polyfilled by RN itself), but `AbortSignal.timeout` (a
  *static* method) is not.
- Our `src/lib/polyfills.ts` does not shim `AbortSignal.timeout`. It
  polyfills `TextDecoder`, `crypto.subtle`,
  `crypto.getRandomValues`, and `ReadableStream` via
  `react-native-quick-crypto` + `web-streams-polyfill`, but nothing
  touches `AbortSignal.timeout`.
- When `AbortSignal.timeout` is `undefined`, calling it throws
  `TypeError: undefined is not a function` — matching the observed
  error verbatim.

Cross-check in the logcat: the RN runtime does execute our polyfills
(`[polyfills] crypto.subtle: object` / `ReadableStream: function` all
print), so the environment is otherwise healthy; only this static
factory is missing.

Secondary suspects, lower probability:

- `new DataView(body.buffer).setBigUint64(...)` — Hermes has
  supported `setBigUint64` since 0.12; 0.85 has it. Unlikely culprit.
- `new URL(identifier, gatewayUri).href` — RN's `URL` shim can be
  flaky for some inputs, but would typically throw
  `TypeError: Invalid URL`, not "undefined is not a function".
- `fetch` itself — but the fetch here reuses RN's global
  `fetch`, known to work elsewhere in the app.

## Recommended fix (for the orchestrator to schedule)

Create a new feature under the `biometric-vault-integration` /
`ci-emulator-validation` milestone (one of):

1. **Polyfill `AbortSignal.timeout` in `src/lib/polyfills.ts`** (MUST
   be applied before any `@enbox/*` import, i.e. at the top of the
   file). Minimum safe implementation:
   ```ts
   if (typeof AbortSignal !== 'undefined'
       && typeof (AbortSignal as any).timeout !== 'function') {
     (AbortSignal as any).timeout = (ms: number): AbortSignal => {
       const controller = new AbortController();
       setTimeout(() => controller.abort(
         new DOMException('TimeoutError', 'TimeoutError')
       ), ms);
       return controller.signal;
     };
   }
   ```
   Add a polyfill-availability log line next to the existing ones so
   regressions are visible in `logcat-rn.txt`. Confirm
   `AbortSignal.timeout: function` is printed in the artifact on the
   next re-dispatch.

2. **Unit-test coverage.** Add a test under
   `src/lib/__tests__/polyfills.test.ts` asserting
   `typeof AbortSignal.timeout === 'function'` and that it returns a
   `signal.aborted === true` after the timeout elapses (fake timers).

3. **Do not patch `@enbox/dids` upstream.** The bug is our runtime's
   missing host API, not the library's use of it; patching
   `node_modules/@enbox/dids` would violate the "never fork `@enbox`"
   rule and leave other call sites broken.

4. After the polyfill lands, the ci-runner feature should re-dispatch
   `debug-emulator.yml` and confirm the run reaches the
   `RecoveryPhrase` / `MainWallet` screens. All three workflows must
   be green on the new SHA.

## Partial artifact audit (run `24861822390`)

Even though the flow aborted mid-onboarding, the artifacts that the
flow script DID capture pass the mission security audit:

- PNGs present: `welcome.png` (1080×2340), `biometric-setup.png`
  (1080×2340), `biometric-prompt-1.png` (1×1 FLAG_SECURE placeholder —
  expected), `flow-error.png` (1080×2340). `file *.png` reports
  "PNG image data" for all four.
- PNGs missing: `recovery-phrase.png`, `main-wallet.png`,
  `relaunch-unlock-prompt.png`, `after-relaunch.png` — all
  downstream of the crash, consistent with the root cause.
- No PIN-era strings in `logcat-*.txt` or in any UI dump.
- No 24-word mnemonic sub-sequences in any log.
- `\b[0-9a-f]{40,}\b` matches in `logcat-full.txt` are Google
  Assistant CDN URLs (`dl.google.com/assistant/nga/1/<sha1>.mddz`) —
  not wallet-related secrets. No vault / biometric / seed /
  mnemonic / Keystore leakage.
- No `FATAL`, `unhandled promise rejection`, or
  `AndroidRuntime: E` in `logcat-rn.txt`. The only error is the
  caught `console.error('[agent-store] first launch failed:', ...)`
  diagnosis-friendly log.

## For the ci-runner worker: DO NOT retry debug-emulator.yml blindly

Per the skill, "Never retry blindly. If a run fails, download
artifacts, diagnose, and return a root-cause summary." The required
fix is a JS polyfill in `src/lib/polyfills.ts` — out of scope for
`ci-runner`. Return control to the orchestrator with a
`discoveredIssues` entry referencing this document and the commit
range.
