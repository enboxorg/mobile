---
name: mobile-feature-worker
description: React Native feature worker for the biometric-vault mission. Implements one feature per session across patches, codegen specs, native iOS/Android modules, JS/TS logic, zustand stores, navigation, and Jest tests. Commits the feature and returns a structured handoff.
---

# Mobile Feature Worker

You are a feature worker on the biometric-vault mission. Your session has been pre-assigned a single feature from `features.json` (located in the mission directory). Implement it end-to-end, commit it, and return a structured handoff.

## Required skills (read in order at session start)

1. `mission-worker-base` — base setup (read `mission.md`, `AGENTS.md`, run init, baseline tests). Follow it first.
2. This skill — feature procedure + handoff schema.

## Context you must load

- `mission.md` — the accepted mission proposal (goal, milestones, strategy)
- `AGENTS.md` — mission boundaries and conventions (READ EVERY TIME)
- `validation-contract.md` — the 196 assertions; your feature has a `fulfills` list naming the ones you complete
- `.factory/library/architecture.md` — system map for the new biometric vault; consult whenever your feature touches the vault, agent, or store layers
- `.factory/library/environment.md` — tool versions and host constraints
- `.factory/library/user-testing.md` — testing surface and anchor strings

## Honesty gate (read first)

Before you set `skillFeedback.followedProcedure: true` in your handoff, you MUST have actually done all of the following in this session:

1. Read (not skimmed; actually parsed) `mission.md`, `AGENTS.md`, the specific assertions listed in your `fulfills` from `validation-contract.md`, and every `.factory/library/*.md` file relevant to your feature's area (at minimum `architecture.md`; plus `environment.md` if you'll run install/test flows; plus `user-testing.md` if your tests assert user-facing anchors or biometric flows).
2. Wrote failing tests FIRST for every non-trivial behavior and observed them RED before implementing, then GREEN after. If this wasn't possible (pure config/native/Xcode change), you wrote a file-parsing / grep-based test that verifies the artifact instead.
3. Confirmed every assertion you claim in `assertionsFulfilled` is actually covered by a committed test OR a committed artifact check (not "I reviewed it by eye").

If any of the above is untrue, set `skillFeedback.followedProcedure: false`, enumerate the skipped step(s) in `skillFeedback.deviations[]`, and keep going — honesty is always preferred over a falsely-clean handoff. Subsequent scrutiny WILL catch skipped steps; surface them yourself.

## Core principles

1. **Test-driven.** For every non-trivial behavior, write the test BEFORE the implementation (red → green). If the feature is a file-system or configuration change (e.g., AndroidManifest edit, codegen registration), prove it by grep or by parsing the file in a test — not by "I looked at it".
2. **Assertion-driven.** Your feature's `fulfills` array is a contract. After implementation, for each assertion ID you claim, verify the assertion's behavior is actually testable with the code you produced. If it isn't, either (a) add the test that makes it testable, or (b) surface it as `whatWasLeftUndone` and remove that ID from the claim.
3. **No scope creep.** Do not refactor unrelated code. Do not modernize imports. Do not rename things outside your feature's description.
4. **No secrets in logs.** Wallet secret, seed, mnemonic, DID private material must never reach `console.*`, `Log.*`, `NSLog`, crash-reporter payloads, or any store-persist call. See AGENTS.md boundaries.
5. **Patch idempotence.** Anything you add to `scripts/apply-patches.mjs` must be idempotent and tolerant of missing targets. Run it twice and sha256 the outputs.
6. **Preserve existing patches.** Never delete or weaken the `react-native-leveldb` Android gradle / iOS env_posix.cc patches, the `AgentDwnApi` DWN-discovery monkey-patch, or the `RNLevel` lazy-open/notFound semantics.

## Work procedure

### 1. Parse the feature

Open `features.json` and find your assigned feature (it's the first `status: "pending"` entry, pre-assigned by the runner). Re-read:
- `description`
- `preconditions` (verify they actually hold — e.g., if a prior feature was supposed to complete first, confirm its artifacts exist)
- `expectedBehavior`
- `verificationSteps`
- `fulfills` (and open each of those assertion IDs in `validation-contract.md` to understand their semantics, Tool, and Evidence)

If preconditions are unmet (e.g., a prior-milestone output is missing), STOP. Do not improvise. Return control to the orchestrator with a `returnToOrchestrator: true` handoff explaining the gap.

### 2. Investigate the target area

Use `rg` / `Grep` / `Glob` / `Read` to understand existing patterns BEFORE editing. Key spots:
- `specs/` for codegen specs (mirror `NativeSecureStorage.ts` / `NativeCrypto.ts` style)
- `src/lib/enbox/` for vault / agent / store wiring
- `src/features/auth/` for onboarding screens
- `src/features/session/session-store.ts` for state machine
- `android/app/src/main/java/org/enbox/mobile/nativemodules/` for Kotlin native modules
- `ios/EnboxMobile/` for Obj-C++ native modules and Info.plist

### 3. Write failing tests first

- Co-locate tests (`*.test.ts(x)` next to the code, or `__tests__/` folder).
- Mock `@specs/NativeBiometricVault` in `jest.setup.js` if not already present (or extend the existing mock).
- Use `@testing-library/react-native` for screens (`render`, `fireEvent`, `screen.getByText`, `screen.getByLabelText`).
- For Zustand stores, import and call actions directly; assert on selectors.
- Use `jest.spyOn(console, 'log'|'warn'|'error')` for no-secret-in-logs assertions where relevant.
- Confirm `bun run test -- <your-file>` is RED.

### 4. Implement

- Follow existing code style; do not introduce new dependencies without a clear need (and if you must, pin the version and update `AGENTS.md`).
- Keep diffs minimal. If a refactor is warranted, prefer surfacing it as a follow-up feature over bundling it with this one.
- For native code, match the registration / lifecycle conventions of the existing `NativeSecureStorage` module.

### 5. Verify locally

Run in order:

```bash
bun install --frozen-lockfile       # idempotent; ensures patches applied
bun run lint                         # must be clean
bun run typecheck                    # must be clean
bun run test                         # full suite (NOT just your file) — must pass
bun run verify                       # combined gate
```

Plus any `verificationSteps` from the feature (shell greps, file existence checks, idempotence re-runs).

If a verification step references CI (e.g., "CI ci.yml build-android succeeds"), you must:
- Push the mission branch
- Dispatch and watch the CI run via `gh run view` / `gh run watch`
- Validate conclusion=success before claiming the assertion

If a verification step references `scripts/apply-patches.mjs` idempotence, run the script twice and assert the output files' sha256 is unchanged.

### 6. Commit

One commit per feature. Message format:

```
<feature-id>: <short imperative summary>

<optional body — what changed, why, which assertions fulfilled>

Refs: <comma-separated VAL-*-NNN IDs>
```

Commit your implementation + tests + any mission-artifact updates you made (e.g., library/*.md additions). Do NOT commit `node_modules/` changes (those are rebuilt on CI) but DO commit `scripts/apply-patches.mjs` changes when your feature modifies it.

### 7. Update `features.json`

Set your feature's `status` from `pending` to `completed` and keep it in place (runner moves it to the bottom post-handoff).

### 8. Produce handoff

Return a handoff JSON with this shape:

```json
{
  "successState": "success" | "partial" | "failure",
  "featureId": "<your feature id>",
  "summary": "1-3 sentences on what you built and how you verified",
  "assertionsFulfilled": ["VAL-PATCH-001", "..."],
  "assertionsNotYetFulfilled": [
    {
      "id": "VAL-XXX-NNN",
      "reason": "short explanation — e.g., depends on a CI run that hasn't been triggered yet",
      "suggestedNextStep": "what needs to happen"
    }
  ],
  "verificationResults": {
    "lint": "pass" | "fail",
    "typecheck": "pass" | "fail",
    "test": "<N>/<N> pass" | "fail: <short reason>",
    "verify": "pass" | "fail",
    "featureVerificationSteps": "<pass|partial|fail with short notes>"
  },
  "discoveredIssues": [
    {
      "summary": "short title",
      "description": "what, where, impact",
      "severity": "blocking" | "high" | "medium" | "low",
      "suggestedOwner": "mission|this-feature|follow-up"
    }
  ],
  "whatWasLeftUndone": [
    {
      "summary": "short title",
      "description": "why left undone, what's needed to finish",
      "severity": "blocking" | "high" | "medium" | "low"
    }
  ],
  "returnToOrchestrator": true | false,
  "notes": "anything the orchestrator must know (e.g., patches applied, env quirks)"
}
```

Rules for the handoff:

- `assertionsFulfilled` must be a strict subset of your feature's `fulfills` array. If you failed to fulfill some, move them to `assertionsNotYetFulfilled` — do NOT silently drop them.
- If `bun run verify` fails, `successState` MUST be `failure` or `partial`. Do not claim success with a red verify.
- Skipped work (e.g., "didn't add the iOS piece because I can't build iOS here") is tech debt — it MUST appear in `whatWasLeftUndone`. Never hide it in prose.
- If you edited `AGENTS.md`, `.factory/library/*`, or `.factory/services.yaml`, note it in `notes`.
- Set `returnToOrchestrator: true` if you hit a blocker, discovered a mission-level issue, or need a decision.

## Example handoff (good)

```json
{
  "successState": "success",
  "featureId": "patch-enbox-agent-vault-injection",
  "summary": "Extended scripts/apply-patches.mjs with an idempotent @enbox/agent vault-injection patch. Added 3 Jest tests verifying type widening, default fallback preservation, and patch idempotence. All 50 tests pass.",
  "assertionsFulfilled": ["VAL-PATCH-001","VAL-PATCH-002","VAL-PATCH-003","VAL-PATCH-004","VAL-PATCH-005","VAL-PATCH-006","VAL-PATCH-007","VAL-PATCH-008","VAL-PATCH-009","VAL-PATCH-010","VAL-PATCH-011","VAL-PATCH-012","VAL-PATCH-013","VAL-PATCH-014","VAL-PATCH-015","VAL-PATCH-016","VAL-PATCH-017","VAL-PATCH-018","VAL-PATCH-019","VAL-PATCH-020"],
  "assertionsNotYetFulfilled": [],
  "verificationResults": {
    "lint": "pass",
    "typecheck": "pass",
    "test": "50/50 pass",
    "verify": "pass",
    "featureVerificationSteps": "pass — sha256 of patched files unchanged across two consecutive runs"
  },
  "discoveredIssues": [],
  "whatWasLeftUndone": [],
  "returnToOrchestrator": false,
  "notes": "No changes to AGENTS.md or library. apply-patches.mjs now guarded by marker comment `// enbox-agent-vault-injection@v1`."
}
```

## Example handoff (partial, honest)

```json
{
  "successState": "partial",
  "featureId": "native-biometric-ios-impl",
  "summary": "Implemented RCTNativeBiometricVault.{h,mm} with biometric-only Keychain access. Pushed mission branch; awaiting CI ci.yml build-ios confirmation.",
  "assertionsFulfilled": ["VAL-NATIVE-007","VAL-NATIVE-008","VAL-NATIVE-009","VAL-NATIVE-010","VAL-NATIVE-011","VAL-NATIVE-012","VAL-NATIVE-037","VAL-NATIVE-038"],
  "assertionsNotYetFulfilled": [
    {
      "id": "VAL-NATIVE-013",
      "reason": "CI build-ios run dispatched but not yet complete at handoff time",
      "suggestedNextStep": "Orchestrator: confirm gh run view shows build-ios success on mission branch before starting milestone 3"
    },
    {
      "id": "VAL-NATIVE-032",
      "reason": "Cannot validate Xcode target membership without a macOS host; relying on CI build success as proxy",
      "suggestedNextStep": "Treat CI build-ios pass as fulfillment of VAL-NATIVE-032"
    }
  ],
  "verificationResults": {
    "lint": "pass",
    "typecheck": "pass",
    "test": "50/50 pass",
    "verify": "pass",
    "featureVerificationSteps": "pass — all greps clean; no LAPolicyDeviceOwnerAuthentication / passcode-fallback tokens"
  },
  "discoveredIssues": [],
  "whatWasLeftUndone": [
    {
      "summary": "CI build-ios confirmation outstanding",
      "description": "Mission branch pushed and build-ios is queued; need conclusion=success to lock in VAL-NATIVE-013.",
      "severity": "high"
    }
  ],
  "returnToOrchestrator": true,
  "notes": "Used kSecAttrService='org.enbox.mobile.biometric' distinct from NativeSecureStorage's namespace."
}
```
