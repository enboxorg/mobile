#!/usr/bin/env bash
#
# ci-debug-emulator-runner.sh — orchestrates the biometric-first
# onboarding flow inside ``debug-emulator.yml``.
#
# This file exists because ``reactivecircus/android-emulator-runner@v2``
# splits its ``script:`` input on newlines and runs each line as a
# separate ``sh -c`` invocation (see its ``parseScript`` helper). Bash
# functions, ``trap`` handlers, and any construct that spans multiple
# lines therefore do NOT survive the parser — the action's log shows
# ``capture_artifacts() {`` being handed to ``sh -c`` on its own, which
# fails with ``Syntax error: end of file unexpected``.
#
# The workaround recommended by the action's maintainers (see
# https://github.com/ReactiveCircus/android-emulator-runner/issues/391)
# is to dump the body of the step into a shell file and invoke that
# file in a single one-liner. That's exactly what this script is.
#
# Behavior (Option A — workflow-level always-run capture):
#   1. Ensure ``/tmp/emulator-ui`` + ``/tmp/emulator-ui-artifacts``
#      exist so screenshots + dumps always have a destination.
#   2. Install the release APK, clear logcat, launch the app, take a
#      baseline startup logcat, then run ``emulator-debug-flow.ts``
#      via ``bun`` with its exit code explicitly captured (no ``set
#      -e``, no ``|| true``).
#   3. UNCONDITIONALLY copy screenshots/uiautomator dumps and dump
#      the final logcat streams — this happens inside the same
#      ``reactivecircus/android-emulator-runner`` step so ``adb`` is
#      still alive (the emulator is torn down by the action's post
#      hook, not by the script's end). The capture runs whether the
#      driver succeeded, failed loudly, or was killed by an
#      unhandled exception — see VAL-CI-013 / VAL-CI-023 / VAL-CI-024
#      / VAL-CI-032.
#   4. Export the driver's exit code to ``$GITHUB_ENV`` as
#      ``SCRIPT_EXIT_CODE`` and exit ``0`` from this script. A
#      downstream workflow step with ``if: always()`` reads the
#      exported code and re-exits with it so the job fails loudly
#      (VAL-CI-024) without short-circuiting the subsequent
#      ``if: always()`` upload / verification steps.
#
# The script assumes ``adb`` and ``bun`` are on ``PATH`` (the workflow
# installs both via ``oven-sh/setup-bun@v2`` and the Android SDK
# action), and that ``ANDROID_SERIAL`` / ``EMULATOR_PORT`` are set by
# ``reactivecircus/android-emulator-runner`` before invocation. When
# run locally (outside CI) it still works against whichever emulator
# ``adb`` defaults to.

# Intentionally no ``set -e`` — we want the script to continue past a
# failing Python driver so the always-run capture phase executes.

UI_DIR=/tmp/emulator-ui
ARTIFACT_DIR=/tmp/emulator-ui-artifacts
LOGCAT_FULL=/tmp/logcat-full.txt
LOGCAT_RN=/tmp/logcat-rn.txt
LOGCAT_STARTUP=/tmp/logcat-startup.txt
# Round-9 F5: capture the emulator-debug-flow.ts driver's stdout +
# stderr to a file so a 600s enrollment timeout (or any other
# blocking failure) leaves a uploadable transcript for post-mortem
# debugging. Without this artifact the only visible diagnostic was
# the ``logcat`` tail, which often misses the driver's own
# step-by-step "[flow] ..." log lines that show exactly which Wizard
# screen the script was stuck on.
DRIVER_LOG=/tmp/emulator-debug-flow.log
MAX_LOGCAT_BYTES=10485760  # 10 MiB — keeps each artifact well under GH's limit (VAL-CI-032)
APP_PACKAGE=org.enbox.mobile
APP_ACTIVITY="${APP_PACKAGE}/.MainActivity"

mkdir -p "${UI_DIR}" "${ARTIFACT_DIR}"
# Pre-create the driver log file so the artifact-upload step's path
# glob always resolves, even if the driver process never produced
# any output (e.g. ``bun`` exec failed before the first println).
: > "${DRIVER_LOG}"

echo "=== Installing release APK ==="
adb install android/app/build/outputs/apk/release/app-release.apk

echo "=== Clearing logcat ==="
adb logcat -c

echo "=== Launching app ==="
adb shell am start -n "${APP_ACTIVITY}"

echo "=== Waiting for app to start (20s) ==="
sleep 20

echo "=== Capturing initial logcat (size-bounded to 10 MiB, tail-preserving) ==="
# Round-9 F5: use ``tail -c`` rather than ``head -c`` so the artifact
# preserves the MOST RECENT bytes. The startup capture is taken just
# after launch — the interesting events for this snapshot ARE near
# the end of the buffer (process spawn, RN bootstrap, etc.) and
# tail-c wins by a wide margin in practice.
adb logcat -d 2>&1 | tail -c "${MAX_LOGCAT_BYTES}" > "${LOGCAT_STARTUP}"

echo "=== Driving onboarding flow by UI text ==="
# No ``|| true`` and no ``set -e``: the driver's exit code is captured
# explicitly. The unconditional capture block below runs regardless of
# the outcome; a downstream ``if: always()`` workflow step re-exits
# with this code so CI still fails loudly when the driver regresses.
# See VAL-CI-013 / VAL-CI-024.
#
# Round-9 F5: tee both stdout AND stderr into ``${DRIVER_LOG}`` so
# the post-mortem artifact captures the driver's own step-by-step
# "[flow] ..." log lines. Without ``tee`` the artifact upload would
# only contain the logcat tail, which omits the driver's narration
# of which Wizard screen / focus matcher it was on at failure
# time. ``2>&1`` first so stderr is interleaved into the same
# stream as stdout (preserves order); ``${PIPESTATUS[0]}`` then
# captures the EXIT CODE OF ``bun`` rather than ``tee``.
bun run scripts/emulator-debug-flow.ts 2>&1 | tee "${DRIVER_LOG}"
SCRIPT_EXIT_CODE=${PIPESTATUS[0]}

echo ""
echo "=== [capture] Driver exit code: ${SCRIPT_EXIT_CODE} ==="

# ----------------------------------------------------------------------
# ALWAYS-RUN CAPTURE PHASE
# Everything below this line MUST run whether the Python driver
# succeeded, failed, or died on an unhandled exception. This replaces
# the old ``trap capture_artifacts EXIT`` mechanism with explicit
# linear flow so future readers can see the capture path on the page.
# ----------------------------------------------------------------------

echo ""
echo "=== [capture] Copying screenshots and uiautomator dumps into the artifact tree ==="
# Round-6 Finding 5: surface ``cp`` failures loudly. The pre-fix
# variant silenced stderr and forced exit 0, which let a copy
# failure silently zero out the privacy-gate audit trail without
# anyone noticing. The downstream verify step (Round-6 F5 part 2)
# now hard-fails the job when ``/tmp/emulator-ui-artifacts`` is
# empty, but the loud error here makes the root cause obvious in
# the logs without requiring a developer to chase a "missing
# artifacts" workflow failure back to a swallowed copy stderr.
if [ -d "${UI_DIR}" ]; then
    # ``/.`` semantics: copy the contents of UI_DIR into ARTIFACT_DIR,
    # not the directory itself.
    if cp -R "${UI_DIR}/." "${ARTIFACT_DIR}/"; then
        ARTIFACT_FILE_COUNT=$(find "${ARTIFACT_DIR}" -type f 2>/dev/null | wc -l)
        echo "[capture] copied UI artifacts into ${ARTIFACT_DIR} (${ARTIFACT_FILE_COUNT} file(s) total)"
    else
        echo "::error::cp -R ${UI_DIR}/. ${ARTIFACT_DIR}/ FAILED — privacy-gate audit trail (PNGs / uiautomator dumps) will be missing from the uploaded artifact bundle. Inspect the ::error:: line above for the underlying cp diagnostic." >&2
    fi
else
    echo "::error::UI artifact source directory ${UI_DIR} is missing — ci-debug-emulator-runner.sh's mkdir -p step earlier in this script should have created it. The privacy-gate audit trail is unavailable for this run." >&2
fi

echo ""
echo "========================================="
echo "=== ReactNativeJS + Crash Logs ==="
echo "========================================="
adb logcat -d -s ReactNativeJS:V ReactNative:V AndroidRuntime:E 2>&1 || true

echo ""
echo "========================================="
echo "=== All ERROR level logs ==="
echo "========================================="
adb logcat -d '*:E' 2>&1 | grep -i 'react\|enbox\|level\|crypto\|fatal\|exception' || true

echo ""
echo "=== [capture] Saving full logcat (size-bounded to 10 MiB, tail-preserving) ==="
# Always produce the two required artifact files even if adb is
# unresponsive — empty files are fine; missing files are not (the
# ``actions/upload-artifact`` step warns + uploads nothing when ALL
# paths are missing, which is what broke the run before this
# refactor).
#
# Round-9 F5: switched from ``head -c`` to ``tail -c``. The pre-fix
# variant kept the OLDEST bytes in the buffer, which is exactly the
# wrong window when the driver hits a 10-minute enrollment timeout
# — the failure breadcrumbs (``BiometricService.hasEnrollments
# stayed false for 600s``) are in the LAST few hundred KB of the
# 10MB buffer, not the first few. The artifact must preserve the
# failure tail so the GitHub UI shows actionable diagnostics.
adb logcat -d 2>&1 | tail -c "${MAX_LOGCAT_BYTES}" > "${LOGCAT_FULL}" || true
adb logcat -d -s ReactNativeJS:V ReactNative:V AndroidRuntime:E 2>&1 \
    | tail -c "${MAX_LOGCAT_BYTES}" > "${LOGCAT_RN}" || true
if [ ! -s "${LOGCAT_FULL}" ]; then
    echo "warning: ${LOGCAT_FULL} is empty (adb may be unreachable)" >&2
fi

# Round-9 follow-up #2: also snapshot ``adb shell dumpsys window`` so
# any post-mortem of a FLAG_SECURE assertion failure has the actual
# source-of-truth window-manager dump (window block layout, focus
# markers, mAttrs flag-bit format) rather than relying on whatever
# the in-driver diagnostic was able to persist before crashing.
# This is the artifact that would have unblocked the round-9
# follow-up investigation in 30 seconds instead of 30 minutes.
echo ""
echo "=== [capture] Snapshotting 'adb shell dumpsys window' ==="
DUMPSYS_WINDOW="${ARTIFACT_DIR}/dumpsys-window.txt"
{
    adb shell dumpsys window 2>&1 || true
} | tail -c "${MAX_LOGCAT_BYTES}" > "${DUMPSYS_WINDOW}" || true
if [ -s "${DUMPSYS_WINDOW}" ]; then
    DUMPSYS_BYTES=$(wc -c < "${DUMPSYS_WINDOW}" 2>/dev/null || echo 0)
    echo "[capture] dumpsys window snapshot: ${DUMPSYS_WINDOW} (${DUMPSYS_BYTES} bytes)"
else
    echo "warning: ${DUMPSYS_WINDOW} is empty (adb may be unreachable)" >&2
fi

# Round-9 F5: bound the driver transcript to the same 10 MiB ceiling
# so a runaway loop can't blow GitHub's 500 MiB artifact limit. The
# ``tee`` invocation above does NOT cap the file, so we trim it
# in-place here. ``mv`` instead of ``cp`` to keep the sentinel
# inode unique-named while ``tail -c`` reads the original file.
if [ -s "${DRIVER_LOG}" ]; then
    DRIVER_LOG_BYTES=$(wc -c < "${DRIVER_LOG}" 2>/dev/null || echo 0)
    if [ "${DRIVER_LOG_BYTES}" -gt "${MAX_LOGCAT_BYTES}" ]; then
        echo "[capture] driver transcript exceeds ${MAX_LOGCAT_BYTES} bytes; trimming to tail"
        tail -c "${MAX_LOGCAT_BYTES}" "${DRIVER_LOG}" > "${DRIVER_LOG}.trim" \
            && mv "${DRIVER_LOG}.trim" "${DRIVER_LOG}"
    fi
    DRIVER_LOG_LINES=$(wc -l < "${DRIVER_LOG}" 2>/dev/null || echo 0)
    echo "[capture] driver transcript: ${DRIVER_LOG} (~${DRIVER_LOG_LINES} lines)"
else
    echo "warning: driver transcript ${DRIVER_LOG} is empty (driver produced no output)" >&2
fi

# Export the Python driver's exit code to ``$GITHUB_ENV`` so a
# downstream ``if: always()`` workflow step can re-exit with it. The
# guard lets local (non-CI) invocations still work — they simply skip
# the env export.
if [ -n "${GITHUB_ENV:-}" ] && [ -w "${GITHUB_ENV}" ]; then
    echo "SCRIPT_EXIT_CODE=${SCRIPT_EXIT_CODE}" >> "${GITHUB_ENV}"
    echo "=== [capture] Exported SCRIPT_EXIT_CODE=${SCRIPT_EXIT_CODE} to GITHUB_ENV ==="
else
    echo "=== [capture] GITHUB_ENV unavailable; SCRIPT_EXIT_CODE=${SCRIPT_EXIT_CODE} (local mode) ==="
fi

# Always exit 0 from this step so subsequent ``if: always()`` steps
# (artifact upload, sanity check, exit-code propagation) run in a
# well-defined order. The propagation step is responsible for failing
# the job when SCRIPT_EXIT_CODE != 0.
exit 0
