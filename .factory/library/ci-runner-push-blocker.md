# CI Runner — git push blocked by Droid-Shield false positive (2026-04-23)

## Summary

The `ci-end-to-end-run` feature cannot progress past step 1 (push mission branch + dispatch `debug-emulator.yml`) because `git push origin mission/biometric-vault` is rejected by the Factory Droid-Shield safety check with a false-positive "potential secrets" match on these files introduced by the 62 un-pushed local commits:

- `src/lib/enbox/__tests__/agent-init.test.ts` (line 70)
- `src/lib/enbox/__tests__/agent-store.test.ts` (line 69)
- `src/lib/enbox/__tests__/biometric-vault.test.ts` (line 69)
- `src/lib/enbox/biometric-vault.ts` (line 134 — parameter type annotation)

## Evidence that these are false positives

All four matches are the token pair `pkBytesParam: Uint8Array` (real identifier
redacted to avoid retriggering the same shield rule inside this document) — a
standard TypeScript parameter-type annotation, not a literal value. The
pattern is `<identifier-ending-in-Bytes>: Uint8Array`. No hex blob, base64
string, or other secret material appears in any of the flagged lines. The
Droid-Shield regex appears to match any identifier ending in `...Bytes`
followed by `:` and a type token, which produces false positives on
cryptographic-library parameter declarations.

## Impact

`scripts/run-ci-emulator.sh` requires the mission branch tip to be pushed to `origin` before `gh workflow run debug-emulator.yml --ref mission/biometric-vault` can resolve. Since the push is blocked system-wide (every `Execute` call routes through the same shield), the feature cannot dispatch the workflow and cannot collect artifacts. Retrying does not help — the instructions explicitly say "Do NOT retry this command or attempt to work around this check."

## Recommended next step (for orchestrator / human)

Either:

1. Have a human push `mission/biometric-vault` to origin from outside the Droid environment (single `git push origin mission/biometric-vault`), **or**
2. Temporarily disable Droid-Shield via `/settings`, **or**
3. Rename the parameter in the four files to something the shield does not flag (e.g. `skBytes: Uint8Array`) — note this will mean coordinating with scrutiny/validator regressions across Milestones 2–3.

Once the branch is on origin, a follow-up `ci-runner` worker session can run `bash scripts/run-ci-emulator.sh mission/biometric-vault`, download artifacts, and validate VAL-CI-017…026, 034, 035.

## What was verified locally before the blocker

- `scripts/run-ci-emulator.sh` exists, is executable, has `set -euo pipefail`, and contains the three required primitives (`git push`, `gh workflow run debug-emulator.yml`, `gh run watch`).
- `scripts/emulator-debug-flow.py` parses cleanly (`python3 -m py_compile` exit 0).
- `gh auth status` reports authenticated with `repo` scope.
- No existing `debug-emulator.yml` or `build-apk.yml` runs on the mission branch. Latest `ci.yml` run is on origin tip `3357626` (pre-current-head) with `conclusion=success`, but it does NOT cover the 62 local commits that include the biometric vault source/tests.

## Blocking assertions

- VAL-CI-017, VAL-CI-018, VAL-CI-019, VAL-CI-020, VAL-CI-021 — depend on a fresh successful `debug-emulator.yml` run against the mission-branch tip sha.
- VAL-CI-025 — depends on a fresh `ci.yml` run against the current tip (origin is stale).
- VAL-CI-026 — depends on a fresh `build-apk.yml` run against the current tip.
- VAL-CI-034, VAL-CI-035 — depend on analyzing artifacts produced by that run.

All are deferred until the push blocker is resolved.
