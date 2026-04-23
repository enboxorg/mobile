# debug-emulator.yml: `enroll_fingerprint` timeout (post-Kotlin-compile-fix)

Discovered during `fix-flag-secure-module-kotlin-compile` on SHA
`ccaf506` (mission branch `mission/biometric-vault`) after fixing the
FlagSecureModule Kotlin compile errors.

## Symptom

With the Kotlin compile issue resolved, `debug-emulator.yml` now
proceeds past APK build: the release APK builds, installs, and
launches on the emulator (logs confirm
`Starting: Intent { cmp=org.enbox.mobile/.MainActivity }`). The flow
then enters `scripts/emulator-debug-flow.py`'s `enroll_fingerprint`
helper and fails:

```
=== Driving onboarding flow by UI text ===
python3 scripts/emulator-debug-flow.py
FLOW_ERROR: enroll_fingerprint: no fingerprint enrolled within 120s
== preparing emulator (device credential + fingerprint) ==
[ensure_device_credential] device PIN already set (pin=0000)
```

The step exits non-zero at the 120s bound in `enroll_fingerprint`
before any screenshot is produced.

## What this proves about the Kotlin fix

The Kotlin compile fix is fully verified by:

- `ci.yml` run `24843234260` on SHA `ccaf506` → `conclusion=success`
  (includes `build-android`).
- `build-apk.yml` run `24843251552` on SHA `ccaf506` →
  `conclusion=success`.
- `debug-emulator.yml` run `24843253074` on SHA `ccaf506` — APK build
  job succeeds (contrast with pre-fix run `24841657181` on SHA
  `e87ea55`, which failed at
  `FlagSecureModule.kt: Unresolved reference 'currentActivity'`).

The emulator flow failure has moved a full layer up (from Kotlin
compile → Python driver script) and is NOT caused by this fix.

## What needs to happen next

The `ci-end-to-end-run` feature (still `status: pending` in
`features.json`, assigned to the `ci-runner` skill) owns driving
`debug-emulator.yml` to full green and diagnosing failures along the
way. Concretely, that feature must:

1. Investigate why `enroll_fingerprint` hits the 120s bound on this
   AVD. Possibilities:
   - The cached AVD snapshot on the runner already has a different
     fingerprint state; the idempotent early-return may not be
     detecting "already enrolled" correctly.
   - The `FINGERPRINT_ENROLL` Settings intent is being dismissed by
     a system dialog (e.g. "Set up lock" wizard) before the script
     can send `adb -e emu finger touch 1`.
   - The emulator's `emu finger touch` ack timing changed between
     images; the per-touch sleep may be too tight.
2. If needed, extend the bound and/or add richer polling diagnostics
   (dumpsys fingerprint snapshot on each retry).
3. Re-dispatch debug-emulator until it completes with
   `conclusion=success` and all 7 required PNGs + 3 logcats are
   present.

## Not in scope for this worker

The current feature's scope was strictly the Kotlin compile fix. The
feature description's "worker MUST verify all three CI workflows turn
green" line collides with the pre-existing enrollment-script bug:
there is no Kotlin-level change that can resolve a Python driver
timeout, and patching the Python driver is the job of
`ci-end-to-end-run` (`skillName: ci-runner`). Flagged in the handoff
as `whatWasLeftUndone` + `discoveredIssues`.
