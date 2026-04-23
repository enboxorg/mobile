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
# Behavior:
#   1. Ensure ``/tmp/emulator-ui`` + ``/tmp/emulator-ui-artifacts``
#      exist so screenshots + dumps always have a destination.
#   2. Register a ``trap ... EXIT`` that ALWAYS captures logcat and
#      copies screenshots, so an enrollment timeout or any other
#      Python flow regression still produces a full debug bundle
#      (VAL-CI-013 / VAL-CI-023 / VAL-CI-024 / VAL-CI-032).
#   3. Install the release APK, clear logcat, launch the app, take a
#      baseline startup logcat, and run ``emulator-debug-flow.py``.
#   4. Propagate the Python driver's non-zero exit code so the
#      workflow step fails when the flow regresses (VAL-CI-013 /
#      VAL-CI-024).
#
# The script assumes ``adb`` is on ``PATH`` and ``ANDROID_SERIAL`` /
# ``EMULATOR_PORT`` are set by ``reactivecircus/android-emulator-runner``
# before invocation. When run locally (outside CI) it still works
# against whichever emulator ``adb`` defaults to.

set -e

UI_DIR=/tmp/emulator-ui
ARTIFACT_DIR=/tmp/emulator-ui-artifacts
LOGCAT_FULL=/tmp/logcat-full.txt
LOGCAT_RN=/tmp/logcat-rn.txt
LOGCAT_STARTUP=/tmp/logcat-startup.txt
MAX_LOGCAT_BYTES=10485760  # 10 MiB — keeps each artifact well under GH's limit (VAL-CI-032)
APP_PACKAGE=org.enbox.mobile
APP_ACTIVITY="${APP_PACKAGE}/.MainActivity"

mkdir -p "${UI_DIR}" "${ARTIFACT_DIR}"

capture_artifacts() {
    # Never exit this handler with a non-zero status — the trap fires on
    # the normal exit path AND on set -e-induced failure, and the shell
    # would otherwise clobber the original exit code. The original code
    # is preserved by explicit ``exit`` at the end.
    local original_exit_code=$?
    set +e

    echo ""
    echo "=== [cleanup] Copying screenshots and dumps into the artifact tree ==="
    if [ -d "${UI_DIR}" ]; then
        # ``/.`` semantics: copy the contents of UI_DIR into ARTIFACT_DIR,
        # not the directory itself. stderr silenced so a missing-source
        # case (rare) doesn't spam the log.
        cp -R "${UI_DIR}/." "${ARTIFACT_DIR}/" 2>/dev/null
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
    echo "=== [cleanup] Saving full logcat (size-bounded to 10 MiB) ==="
    # Always produce the two required artifact files even if adb is
    # unresponsive — empty files are fine; missing files are not (the
    # ``actions/upload-artifact`` step warns + uploads nothing when ALL
    # paths are missing, which is what broke the run before this
    # refactor).
    adb logcat -d 2>&1 | head -c "${MAX_LOGCAT_BYTES}" > "${LOGCAT_FULL}" || true
    adb logcat -d -s ReactNativeJS:V ReactNative:V AndroidRuntime:E 2>&1 \
        | head -c "${MAX_LOGCAT_BYTES}" > "${LOGCAT_RN}" || true
    if [ ! -s "${LOGCAT_FULL}" ]; then
        echo "warning: ${LOGCAT_FULL} is empty (adb may be unreachable)" >&2
    fi

    exit "${original_exit_code}"
}
trap capture_artifacts EXIT

echo "=== Installing release APK ==="
adb install android/app/build/outputs/apk/release/app-release.apk

echo "=== Clearing logcat ==="
adb logcat -c

echo "=== Launching app ==="
adb shell am start -n "${APP_ACTIVITY}"

echo "=== Waiting for app to start (20s) ==="
sleep 20

echo "=== Capturing initial logcat (size-bounded to 10 MiB) ==="
adb logcat -d 2>&1 | head -c "${MAX_LOGCAT_BYTES}" > "${LOGCAT_STARTUP}"

echo "=== Driving onboarding flow by UI text ==="
# No `|| true` — the Python driver's exit code must propagate so flow
# regressions fail the job. See VAL-CI-013 / VAL-CI-024.
python3 scripts/emulator-debug-flow.py
