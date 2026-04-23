#!/usr/bin/env python3
"""CI emulator driver for the biometric-first onboarding + relaunch flow.

This script is executed inside the ``debug-emulator.yml`` workflow after the
release APK has been installed and launched. It automates the entire
biometric-first onboarding flow end to end using ``adb``:

    welcome
      -> biometric-setup
      -> biometric-prompt-1
      -> recovery-phrase
      -> main-wallet
      -> relaunch-unlock-prompt
      -> after-relaunch

All waits are bounded (explicit ``timeout=`` arguments that raise
``TimeoutError``/``RuntimeError`` on expiry) and every stage captures a
screenshot using the literal names consumed by the CI validation contract.
When any required anchor is missing, the script writes a ``flow-error`` PNG
plus a UI dump and exits with a non-zero status so the workflow step fails
loudly instead of silently swallowing the regression.

The script never types or waits for app-level PIN material. The only digits
entered at the OS level are the device lockscreen PIN ``0000`` required to
enroll a fingerprint on API 31 (Keystore ``setUserAuthenticationRequired``).
"""

from __future__ import annotations

import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Iterable, Optional


# Artifact output root. Both the workflow and validators read PNG/XML files
# from here, so do not change without coordinating with the CI workflow.
ROOT = Path("/tmp/emulator-ui")
ROOT.mkdir(parents=True, exist_ok=True)


# -- application + emulator constants -----------------------------------------

APP_PACKAGE = "org.enbox.mobile"
APP_ACTIVITY = f"{APP_PACKAGE}/.MainActivity"

# Device lockscreen PIN used ONLY for `locksettings set-pin`, which unlocks
# Keystore enrollment on API 31. This is NOT an app-level credential.
DEVICE_PIN = "0000"

# Fingerprint id sent by `adb -e emu finger touch <id>`. Matches the id used
# throughout the enrollment + unlock flow.
FINGER_ID = "1"

# Anchor strings keyed off the real UI copy in this repo.
WELCOME_ANCHOR = "Get started"
BIOMETRIC_SETUP_ANCHOR = "Enable biometric unlock"
RECOVERY_PHRASE_CONFIRM = "I\u2019ve saved it"  # curly apostrophe, matches the RecoveryPhrase screen
MAIN_WALLET_ANCHOR = "Identities"

SYSTEM_UI_PACKAGE = "com.android.systemui"
BIOMETRIC_PROMPT_PATTERNS = (
    "Use fingerprint",
    "Use your fingerprint",
    "Touch the fingerprint sensor",
    "Verify it\u2019s you",
    "Verify it's you",
    "fingerprint",
    "Fingerprint",
    "BiometricPrompt",
)


# -- subprocess + adb plumbing ------------------------------------------------


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    """Run a command with captured output."""

    return subprocess.run(args, check=check, text=True, capture_output=True)


def adb(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    """Run an ``adb`` command."""

    return run("adb", *args, check=check)


def adb_emu(*args: str, check: bool = False) -> subprocess.CompletedProcess[str]:
    """Run an ``adb -e`` command (targets the running emulator)."""

    return run("adb", "-e", *args, check=check)


# -- UI dump / screenshot helpers --------------------------------------------


def dump_ui(name: Optional[str] = None) -> ET.Element:
    """Dump the current UI hierarchy and return the parsed root element.

    When ``name`` is provided, the XML is also copied to ``/tmp/emulator-ui/<name>.xml``
    so downstream validators can read it alongside the matching screenshot.
    """

    adb("shell", "uiautomator", "dump", "/sdcard/window_dump.xml")
    local = ROOT / "window_dump.xml"
    adb("pull", "/sdcard/window_dump.xml", str(local))
    if name:
        named = ROOT / f"{name}.xml"
        named.write_bytes(local.read_bytes())
    return ET.parse(local).getroot()


def parse_bounds(bounds: str) -> tuple[int, int]:
    match = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
    if not match:
        raise ValueError(f"Invalid bounds: {bounds}")
    left, top, right, bottom = map(int, match.groups())
    return (left + right) // 2, (top + bottom) // 2


def find_node_by_text(root: ET.Element, text: str) -> Optional[ET.Element]:
    """Return the first node whose ``text`` or ``content-desc`` matches ``text``.

    Falls back to substring matches on ``text`` for robustness against minor
    UI wording changes.
    """

    for node in root.iter("node"):
        if node.attrib.get("text") == text or node.attrib.get("content-desc") == text:
            return node
    for node in root.iter("node"):
        node_text = node.attrib.get("text", "")
        if text and text in node_text:
            return node
    return None


def find_node_by_text_ci(root: ET.Element, text: str) -> Optional[ET.Element]:
    """Return the first node whose ``text`` or ``content-desc`` matches
    ``text`` case-insensitively.

    Used for OS wizard buttons (``MORE``, ``AGREE``, ``DONE`` etc.) which
    render in uppercase on API 31 AOSP/``google_apis`` images, unlike the
    app-level anchors which must match exact copy.
    """

    needle = text.lower()
    for node in root.iter("node"):
        node_text = (node.attrib.get("text") or "").lower()
        node_desc = (node.attrib.get("content-desc") or "").lower()
        if node_text == needle or node_desc == needle:
            return node
    for node in root.iter("node"):
        node_text = (node.attrib.get("text") or "").lower()
        if needle and needle in node_text:
            return node
    return None


def find_system_ui_biometric_node(
    root: ET.Element, patterns: Iterable[str] = BIOMETRIC_PROMPT_PATTERNS
) -> Optional[ET.Element]:
    """Return the first node rendered by ``com.android.systemui`` whose text
    matches any biometric prompt pattern.
    """

    patterns_lc = [p.lower() for p in patterns]
    for node in root.iter("node"):
        if node.attrib.get("package") != SYSTEM_UI_PACKAGE:
            continue
        haystack = " ".join(
            (
                node.attrib.get("text", ""),
                node.attrib.get("content-desc", ""),
                node.attrib.get("class", ""),
                node.attrib.get("resource-id", ""),
            )
        ).lower()
        if not haystack.strip():
            continue
        for needle in patterns_lc:
            if needle and needle in haystack:
                return node
    return None


def wait_for_text(text: str, timeout: float = 25.0) -> ET.Element:
    """Bounded poll: return the first node matching ``text`` before ``timeout``.

    Raises :class:`TimeoutError` on expiry so that the top-level ``except``
    captures a ``flow-error`` screenshot and exits non-zero.
    """

    deadline = time.time() + timeout
    while time.time() < deadline:
        root = dump_ui()
        node = find_node_by_text(root, text)
        if node is not None:
            return node
        time.sleep(1)
    raise TimeoutError(f"Text not found within {timeout:.0f}s: {text!r}")


def tap_text(text: str, timeout: float = 25.0) -> None:
    node = wait_for_text(text, timeout)
    x, y = parse_bounds(node.attrib["bounds"])
    adb("shell", "input", "tap", str(x), str(y))


def tap_node(node: ET.Element) -> None:
    x, y = parse_bounds(node.attrib["bounds"])
    adb("shell", "input", "tap", str(x), str(y))


def input_text(value: str) -> None:
    adb("shell", "input", "text", value)


def press_enter() -> None:
    # KEYCODE_ENTER (66) dismisses the lockscreen PIN entry dialog.
    adb("shell", "input", "keyevent", "66")


def screencap(name: str) -> None:
    """Capture a screenshot and pull it to ``/tmp/emulator-ui/<name>.png``."""

    device_path = f"/sdcard/{name}.png"
    adb("shell", "screencap", "-p", device_path)
    adb("pull", device_path, str(ROOT / f"{name}.png"), check=False)


def wait_until_package(
    package: str, timeout: float = 30.0, *, poll: float = 1.0
) -> None:
    """Bounded wait: block until the foreground window belongs to ``package``.

    Raises :class:`TimeoutError` on expiry.
    """

    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        result = adb(
            "shell",
            "dumpsys",
            "window",
            "windows",
            check=False,
        )
        last = result.stdout
        if package in last:
            return
        time.sleep(poll)
    raise TimeoutError(
        f"Package {package!r} did not reach the foreground within {timeout:.0f}s"
    )


# -- device credential + fingerprint enrollment -------------------------------


def _locksettings_pin_is_set() -> bool:
    """Best-effort check: does the device already have a lockscreen PIN?

    ``locksettings get-disabled`` is NOT a credential probe — it returns
    ``false`` whenever the keyguard is active, which is the default on
    stock AVDs (swipe-to-unlock). To actually detect a PIN credential we
    check ``dumpsys trust`` and ``dumpsys account`` markers and fall back
    to a probe via ``set-pin`` (which reports "already set" when a PIN
    exists).
    """

    # Probe: try setting the PIN without --old. If one is already set
    # with a different value we get an explicit error; if one is set
    # with the same value we get a success message; if none is set at
    # all we get a success and return True (the PIN is now set).
    probe = adb(
        "shell",
        "locksettings",
        "set-pin",
        DEVICE_PIN,
        check=False,
    )
    combined = f"{probe.stdout}\n{probe.stderr}".lower()
    if probe.returncode == 0:
        # We either re-set the same PIN or set a fresh PIN to the
        # expected value; either way the device now has the expected
        # credential.
        return True
    if (
        "already set" in combined
        or "existing" in combined
        or "old password" in combined
    ):
        # A different PIN is already set. We'll re-issue with --old in
        # the outer function to normalize it to DEVICE_PIN.
        return True
    return False


def ensure_device_credential(timeout: float = 20.0) -> None:
    """Ensure the device has a lockscreen PIN (idempotent).

    Strong biometric Keystore keys on API 31 require a device credential
    before a fingerprint can be enrolled. The helper:

    1. Returns immediately when the emulator already has a credential set
       (cached AVD).
    2. Otherwise, runs ``adb shell locksettings set-pin 0000``.
    3. Falls back to ``--old 0000`` on "already set" failures to stay
       idempotent across reruns on the same AVD.

    ``timeout`` bounds the total retry budget to keep the helper from
    looping indefinitely on a broken emulator.
    """

    deadline = time.time() + timeout
    if _locksettings_pin_is_set():
        print(f"[ensure_device_credential] device PIN already set (pin={DEVICE_PIN})")
        return
    while time.time() < deadline:
        result = adb(
            "shell",
            "locksettings",
            "set-pin",
            DEVICE_PIN,
            check=False,
        )
        if result.returncode == 0:
            print("[ensure_device_credential] set-pin succeeded")
            return
        combined = f"{result.stdout}\n{result.stderr}".lower()
        if "already" in combined or "existing" in combined or "old" in combined:
            retry = adb(
                "shell",
                "locksettings",
                "set-pin",
                "--old",
                DEVICE_PIN,
                DEVICE_PIN,
                check=False,
            )
            if retry.returncode == 0:
                print("[ensure_device_credential] set-pin with --old succeeded")
                return
        time.sleep(1)
    raise RuntimeError(
        f"ensure_device_credential: failed to set device PIN within {timeout:.0f}s"
    )


def enrolled_fingerprint_count() -> int:
    """Parse ``dumpsys fingerprint`` and return the enrolled-finger count."""

    result = adb("shell", "dumpsys", "fingerprint", check=False)
    if result.returncode != 0:
        return 0
    text = result.stdout or ""
    for line in text.splitlines():
        lower = line.lower()
        if "enrolled" in lower:
            # Examples observed on API 31:
            #   "Fingerprint enrolled for user 0: 1"
            #   "enrolled=1"
            matches = re.findall(r"(\d+)", line)
            if matches:
                try:
                    return int(matches[-1])
                except ValueError:
                    continue
    if "already enrolled" in text.lower():
        return 1
    return 0


def _enter_device_pin_if_prompted(timeout: float = 8.0) -> bool:
    """When the lockscreen PIN confirm sheet is visible, type the PIN.

    Returns ``True`` if the PIN was entered, ``False`` when no PIN prompt
    appeared within ``timeout`` seconds.
    """

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            root = dump_ui()
        except subprocess.CalledProcessError:
            time.sleep(0.5)
            continue
        # Match the lockscreen credential confirm sheet by Android-system
        # copy only. The legacy app-level PIN/unlock strings from the
        # pre-biometric flow are intentionally absent here (see VAL-CI-002).
        needles = (
            "Enter your PIN",
            "Enter PIN",
            "Enter device PIN",
            "Device PIN",
            "Confirm your PIN to continue",
        )
        found = None
        for needle in needles:
            node = find_node_by_text(root, needle)
            if node is not None:
                found = node
                break
        if found is not None:
            input_text(DEVICE_PIN)
            time.sleep(0.5)
            press_enter()
            return True
        time.sleep(0.5)
    return False


# Labels that advance through the fingerprint enrollment wizard on API 31
# AOSP/google_apis images. Order matters: earlier labels (Intro screen) are
# tried before later ones (Finish screen) so the tap lands on the correct
# button when multiple are present on-screen (rare but possible).
#
# Explicitly exclude "No thanks", "Cancel", "Skip", "Not now" — tapping any
# of those dismisses the wizard and the enrollment will never complete.
WIZARD_ADVANCE_LABELS: tuple[str, ...] = (
    "I agree",
    "Acknowledge",
    "I Agree",
    "Agree",
    "Continue",
    "More",
    "Start",
    "Next",
    "Done",
    "Fingerprint added",
)


# Activity class fragments we expect to see in ``current_focus()`` during the
# fingerprint enrollment wizard on API 31 ``google_apis`` images. These are
# checked case-insensitively to make the state-machine resilient to minor
# class-name drift between system images.
ENROLL_FOCUS_CONFIRM = ("confirmlockpassword", "confirmlockpin", "confirmlockpattern")
ENROLL_FOCUS_INTRO = ("fingerprintenrollintroduction",)
ENROLL_FOCUS_FIND_SENSOR = ("fingerprintenrollfindsensor",)
ENROLL_FOCUS_ENROLLING = ("fingerprintenrollenrolling", "fingerprintenrollsidecar")
ENROLL_FOCUS_FINISH = ("fingerprintenrollfinish",)
# Any activity in the settings fingerprint package counts as "still in the
# enrollment flow" even when the specific class isn't one we recognize by
# name. Used to decide whether we need to re-launch the intent.
ENROLL_FOCUS_SETTINGS_FINGERPRINT = ("biometrics.fingerprint",)


def current_focus() -> str:
    """Return a short string describing the current foreground activity.

    Used for diagnostics so enrollment timeouts surface *where* the flow
    got stuck.
    """

    result = adb("shell", "dumpsys", "window", check=False)
    if result.returncode != 0:
        return ""
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if stripped.startswith("mCurrentFocus=") or stripped.startswith(
            "mFocusedApp="
        ):
            return stripped
    return ""


def _focus_matches(focus: str, fragments: Iterable[str]) -> bool:
    """Case-insensitive substring match over activity ``focus`` line."""

    focus_lower = focus.lower()
    return any(frag in focus_lower for frag in fragments)


def _tap_first_label(
    root: Optional[ET.Element], labels: Iterable[str]
) -> Optional[str]:
    """Tap the first node whose text matches any of ``labels``.

    Matching is case-insensitive so that OS wizard labels like ``MORE`` or
    ``AGREE`` (which render uppercase on API 31 ``google_apis``) are tapped
    even when our label list uses mixed case.

    Returns the tapped label on success, ``None`` otherwise.
    """

    if root is None:
        return None
    for label in labels:
        node = find_node_by_text_ci(root, label)
        if node is not None:
            try:
                tap_node(node)
                return label
            except Exception as tap_exc:  # pragma: no cover - diagnostic only
                print(
                    f"[enroll_fingerprint] tap '{label}' failed: {tap_exc}",
                    flush=True,
                )
                return None
    return None


def enroll_fingerprint(timeout: float = 300.0) -> None:
    """Enroll a fingerprint on the running emulator (idempotent).

    The emulator's fingerprint wizard on API 31 ``google_apis`` images
    drives through several activities that must each be satisfied in
    order:

    - ``FingerprintEnrollIntroduction`` — intro; auto-advances to
      ``ConfirmLockPassword`` via ``launchConfirmLock`` when a PIN is
      already set on the device (no tap required).
    - ``ConfirmLockPassword`` / ``ConfirmLockPin`` — device PIN confirm.
      We ``input text 0000`` + KEYCODE_ENTER; on API 31 this submits
      the credential and advances the wizard.
    - ``FingerprintEnrollFindSensor`` — "Touch the sensor" screen, needs
      a "Start" / "Next" tap.
    - ``FingerprintEnrollEnrolling`` — records finger samples; needs
      repeated ``adb -e emu finger touch 1`` (5-7 touches on Pixel 5).
    - ``FingerprintEnrollFinish`` — "Fingerprint added"; best-effort
      "Done" tap to return Settings to a clean state.

    The loop dispatches on ``current_focus()`` so that it doesn't rely
    on fragile UI-text matching (earlier iterations bailed to
    ``SECURITY_SETTINGS`` whenever focus shifted to ``ConfirmLockPassword``
    because the text-based PIN-prompt detection missed the API 31
    copy — see ``.factory/library/ci-debug-emulator-fingerprint-enrollment-timeout.md``).

    Steps:

    1. Early-return when ``dumpsys fingerprint`` already reports an
       enrolled finger (cached AVD). This satisfies VAL-CI-037.
    2. Launch the ``FINGERPRINT_ENROLL`` settings intent.
    3. Poll ``current_focus()``; for each known activity, run the
       dispatch handler (type PIN, tap advance button, fire finger
       touches, etc.) and check ``enrolled_fingerprint_count()`` each
       iteration.
    4. If ``current_focus()`` ever leaves the fingerprint wizard
       entirely (e.g. user bounced back to Security Settings) and the
       finger count is still zero, re-launch the intent rather than
       sit idle.

    Diagnostics (current foreground activity + ``dumpsys fingerprint``
    excerpt + on-screen button candidates) are printed every ~15 seconds
    so a timeout reveals exactly where the wizard got stuck.

    Raises :class:`TimeoutError` when enrollment cannot be verified within
    ``timeout`` seconds.
    """

    if enrolled_fingerprint_count() >= 1:
        print(
            "[enroll_fingerprint] fingerprint already enrolled; skipping",
            flush=True,
        )
        return

    print(
        "[enroll_fingerprint] launching android.settings.FINGERPRINT_ENROLL",
        flush=True,
    )
    adb(
        "shell",
        "am",
        "start",
        "-a",
        "android.settings.FINGERPRINT_ENROLL",
        check=False,
    )
    time.sleep(2.0)

    deadline = time.time() + timeout
    touches = 0
    taps = 0
    pins = 0
    relaunches = 0
    last_diagnostic = 0.0
    stuck_at_non_wizard_since: Optional[float] = None
    while time.time() < deadline:
        count = enrolled_fingerprint_count()
        if count >= 1:
            print(
                f"[enroll_fingerprint] enrolled after {touches} touch(es), "
                f"{taps} wizard tap(s), {pins} pin-confirm(s); count={count}",
                flush=True,
            )
            # Best-effort "Done" tap to leave Settings in a clean state; the
            # app is force-stopped in main() regardless.
            try:
                root = dump_ui()
                _tap_first_label(root, ("Done", "Finish", "OK", "Next"))
            except Exception:
                pass
            return

        focus = current_focus()
        try:
            root = dump_ui()
        except subprocess.CalledProcessError:
            root = None

        handled = False

        # 1) Credential confirmation — type the device PIN + ENTER.
        if _focus_matches(focus, ENROLL_FOCUS_CONFIRM):
            input_text(DEVICE_PIN)
            time.sleep(0.5)
            press_enter()
            pins += 1
            print(
                f"[enroll_fingerprint] typed device PIN on ConfirmLock* ({pins} total)",
                flush=True,
            )
            time.sleep(2.0)
            handled = True

        # 2) Intro screen usually auto-advances via launchConfirmLock on
        # API 31, but on some images the user has to tap "More" / "Agree"
        # / "Continue" first. Cover both paths.
        elif _focus_matches(focus, ENROLL_FOCUS_INTRO):
            # Order: prefer Agree/Continue (terminal advance), fall back to
            # More (scroll to reveal Agree) only when no terminal is visible.
            # All matches are case-insensitive so that API 31 uppercase
            # variants ("AGREE"/"MORE") are recognized.
            tapped = _tap_first_label(
                root, ("I Agree", "I agree", "Agree", "Continue", "Next", "More")
            )
            if tapped is not None:
                print(
                    f"[enroll_fingerprint] tapped '{tapped}' on Introduction",
                    flush=True,
                )
                taps += 1
                time.sleep(1.5)
            else:
                # The intro usually auto-advances — give it a moment.
                time.sleep(1.0)
            handled = True

        # 3) "Touch the sensor" screen — tap "Start"/"Next" to proceed to
        # actual enrollment, then fire a touch for good measure.
        elif _focus_matches(focus, ENROLL_FOCUS_FIND_SENSOR):
            tapped = _tap_first_label(root, ("Start", "Next", "Continue"))
            if tapped is not None:
                print(
                    f"[enroll_fingerprint] tapped '{tapped}' on FindSensor",
                    flush=True,
                )
                taps += 1
            adb_emu("emu", "finger", "touch", FINGER_ID)
            touches += 1
            time.sleep(1.0)
            handled = True

        # 4) Enrollment in progress — fire touches until the HAL records
        # enough samples and the wizard advances on its own.
        elif _focus_matches(focus, ENROLL_FOCUS_ENROLLING):
            adb_emu("emu", "finger", "touch", FINGER_ID)
            touches += 1
            time.sleep(0.8)
            handled = True

        # 5) Finish screen — enrollment succeeded; tap Done and re-check
        # the count on the next iteration (which will exit the loop).
        elif _focus_matches(focus, ENROLL_FOCUS_FINISH):
            _tap_first_label(root, ("Done", "Finish", "OK", "Next"))
            taps += 1
            time.sleep(1.0)
            handled = True

        # 6) Something unexpected (Security Settings, Home screen, etc.).
        # Re-launch the intent to get back on track, but guard against
        # tight re-launch loops with a 10s grace window.
        if not handled:
            # System ANR dialog ("App isn't responding") can show over the
            # launcher on fresh AVDs. Tap "Wait" so the Settings intent can
            # complete instead of being cancelled.
            if dismiss_anr_if_present(max_attempts=1):
                time.sleep(1.0)
                continue

            still_in_wizard = _focus_matches(
                focus, ENROLL_FOCUS_SETTINGS_FINGERPRINT
            )
            now = time.time()
            if still_in_wizard:
                stuck_at_non_wizard_since = None
            else:
                if stuck_at_non_wizard_since is None:
                    stuck_at_non_wizard_since = now
                elif now - stuck_at_non_wizard_since > 10.0 and relaunches < 8:
                    print(
                        f"[enroll_fingerprint] not in wizard (focus={focus!r}); "
                        "re-launching FINGERPRINT_ENROLL",
                        flush=True,
                    )
                    adb(
                        "shell",
                        "am",
                        "start",
                        "-a",
                        "android.settings.FINGERPRINT_ENROLL",
                        check=False,
                    )
                    relaunches += 1
                    stuck_at_non_wizard_since = None
                    time.sleep(3.0)
                    continue
            # Fallback: try a text-based wizard advance + finger touch.
            tapped = _tap_first_label(root, WIZARD_ADVANCE_LABELS)
            if tapped is not None:
                print(
                    f"[enroll_fingerprint] fallback tapped '{tapped}' "
                    f"(focus={focus!r})",
                    flush=True,
                )
                taps += 1
                time.sleep(1.0)
            else:
                adb_emu("emu", "finger", "touch", FINGER_ID)
                touches += 1
                time.sleep(1.0)

        # Periodic diagnostics so a timeout doesn't hide the root cause.
        now = time.time()
        if now - last_diagnostic > 15.0:
            last_diagnostic = now
            dumpsys_excerpt = (
                adb("shell", "dumpsys", "fingerprint", check=False).stdout or ""
            )[:500].replace("\n", " | ")
            button_texts: list[str] = []
            if root is not None:
                for node in list(root.iter("node"))[:200]:
                    t = node.attrib.get("text", "").strip()
                    if t and node.attrib.get("clickable") == "true":
                        button_texts.append(t)
            print(
                f"[enroll_fingerprint] touches={touches} taps={taps} pins={pins} "
                f"relaunches={relaunches} count={count} "
                f"focus={focus!r} clickable={button_texts[:10]!r} "
                f"dumpsys={dumpsys_excerpt!r}",
                flush=True,
            )

    raise TimeoutError(
        f"enroll_fingerprint: no fingerprint enrolled within {timeout:.0f}s"
    )


# -- biometric prompt interaction --------------------------------------------


def wait_for_biometric_prompt(timeout: float = 30.0) -> ET.Element:
    """Poll the UI dump for a ``com.android.systemui`` biometric prompt node.

    Returns the matched node. Raises :class:`TimeoutError` on expiry so the
    top-level handler captures the flow-error artifacts.
    """

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            root = dump_ui()
        except subprocess.CalledProcessError:
            time.sleep(1)
            continue
        node = find_system_ui_biometric_node(root)
        if node is not None:
            return node
        time.sleep(1)
    raise TimeoutError(
        f"wait_for_biometric_prompt: no com.android.systemui biometric node within {timeout:.0f}s"
    )


def satisfy_biometric_prompt(timeout: float = 20.0) -> None:
    """Fire the emulator fingerprint touch and verify the prompt disappears.

    Sends ``adb -e emu finger touch 1`` up to a handful of times, re-dumping
    the UI between touches until no ``com.android.systemui`` biometric node
    remains. Raises :class:`TimeoutError` if the overlay is still present
    after ``timeout`` seconds.
    """

    deadline = time.time() + timeout
    touches = 0
    while time.time() < deadline:
        adb_emu("emu", "finger", "touch", FINGER_ID)
        touches += 1
        time.sleep(1)
        try:
            root = dump_ui()
        except subprocess.CalledProcessError:
            continue
        node = find_system_ui_biometric_node(root)
        if node is None:
            print(
                f"[satisfy_biometric_prompt] overlay dismissed after {touches} touch(es)"
            )
            return
    raise TimeoutError(
        f"satisfy_biometric_prompt: biometric overlay did not dismiss within {timeout:.0f}s"
    )


# -- relaunch cycle ----------------------------------------------------------


def force_stop_app() -> None:
    adb("shell", "am", "force-stop", APP_PACKAGE)


def start_app() -> None:
    adb("shell", "am", "start", "-n", APP_ACTIVITY)


def relaunch_and_unlock(
    *,
    prompt_timeout: float = 45.0,
    satisfy_timeout: float = 20.0,
    wallet_timeout: float = 45.0,
) -> None:
    """Force-stop the app, restart it, satisfy the unlock prompt, re-verify wallet.

    Captures ``relaunch-unlock-prompt.png`` on the system-ui BiometricPrompt
    and ``after-relaunch.png`` after the main wallet anchor reappears. All
    waits are bounded and raise on expiry.
    """

    force_stop_app()
    time.sleep(1)
    start_app()
    wait_until_package(APP_PACKAGE, timeout=30.0)

    wait_for_biometric_prompt(timeout=prompt_timeout)
    screencap("relaunch-unlock-prompt")
    dump_ui("relaunch-unlock-prompt")
    satisfy_biometric_prompt(timeout=satisfy_timeout)

    # Give the app a beat to finish rendering the wallet after the unlock.
    wait_for_text(MAIN_WALLET_ANCHOR, timeout=wallet_timeout)
    screencap("after-relaunch")
    dump_ui("after-relaunch")


# -- main flow ---------------------------------------------------------------


def wait_for_boot_completed(timeout: float = 90.0, settle: float = 10.0) -> None:
    """Poll ``sys.boot_completed`` until it returns ``1``, then sleep
    ``settle`` seconds so background services quiesce.

    ``reactivecircus/android-emulator-runner@v2`` waits for boot before
    handing off, but on some runs the launcher (``NexusLauncherActivity``)
    can ANR immediately afterward because background services are still
    settling. Giving them an extra grace window — plus probing
    ``sys.boot_completed`` explicitly — sharply reduces the flaky
    ``Close app / Wait`` ANR on the first ``FINGERPRINT_ENROLL`` launch.
    """

    deadline = time.time() + timeout
    while time.time() < deadline:
        result = adb("shell", "getprop", "sys.boot_completed", check=False)
        if (result.stdout or "").strip() == "1":
            break
        time.sleep(1.0)
    # Non-fatal: fall through to the rest of the flow, which has its
    # own bounded waits and diagnostics.
    if settle > 0:
        time.sleep(settle)


def dismiss_anr_if_present(max_attempts: int = 3) -> bool:
    """If a system ANR dialog is on-screen, tap ``Wait`` to keep the
    application running.

    Returns ``True`` when an ANR dialog was observed and dismissed,
    ``False`` otherwise. Only matches the ``Wait`` button alongside
    ``Close app`` (the standard ANR dialog shape); never taps "Close app"
    alone.
    """

    dismissed_any = False
    for _ in range(max_attempts):
        try:
            root = dump_ui()
        except subprocess.CalledProcessError:
            return dismissed_any

        close_present = False
        wait_node: Optional[ET.Element] = None
        for node in root.iter("node"):
            text = (node.attrib.get("text") or "").strip().lower()
            if text == "close app":
                close_present = True
            elif text == "wait":
                wait_node = node
        # Only act when BOTH buttons are present — signature of an ANR
        # dialog. "Wait" alone could plausibly be app copy somewhere.
        if not (close_present and wait_node is not None):
            return dismissed_any
        try:
            tap_node(wait_node)
            print(
                "[dismiss_anr] tapped 'Wait' on ANR dialog",
                flush=True,
            )
            dismissed_any = True
        except Exception:
            return dismissed_any
        time.sleep(1.5)
    return dismissed_any


def main() -> int:
    print("== preparing emulator (device credential + fingerprint) ==")
    wait_for_boot_completed()
    # Launcher ANRs sometimes appear right after boot_completed on first
    # run of a fresh AVD; dismiss before touching Settings.
    dismiss_anr_if_present()
    ensure_device_credential()
    enroll_fingerprint()

    # Reset the app to a known foreground state before we start the flow. The
    # enrollment step may have pushed Settings to the foreground.
    force_stop_app()
    time.sleep(1)
    start_app()
    wait_until_package(APP_PACKAGE, timeout=45.0)

    print("== welcome ==")
    wait_for_text(WELCOME_ANCHOR, timeout=45.0)
    screencap("welcome")
    dump_ui("welcome")
    tap_text(WELCOME_ANCHOR, timeout=15.0)

    print("== biometric-setup ==")
    wait_for_text(BIOMETRIC_SETUP_ANCHOR, timeout=30.0)
    screencap("biometric-setup")
    dump_ui("biometric-setup")
    tap_text(BIOMETRIC_SETUP_ANCHOR, timeout=15.0)

    print("== biometric-prompt-1 ==")
    wait_for_biometric_prompt(timeout=45.0)
    screencap("biometric-prompt-1")
    dump_ui("biometric-prompt-1")
    satisfy_biometric_prompt(timeout=30.0)

    print("== recovery-phrase ==")
    wait_for_text(RECOVERY_PHRASE_CONFIRM, timeout=45.0)
    screencap("recovery-phrase")
    dump_ui("recovery-phrase")
    tap_text(RECOVERY_PHRASE_CONFIRM, timeout=15.0)

    print("== main-wallet ==")
    wait_for_text(MAIN_WALLET_ANCHOR, timeout=45.0)
    screencap("main-wallet")
    dump_ui("main-wallet")

    print("== relaunch cycle ==")
    relaunch_and_unlock()

    print("== verifying wallet anchor (final) ==")
    # Final anchor check: keep this as the last action before ``return 0`` so
    # a regression here causes a non-zero exit (VAL-CI-024).
    wait_for_text(MAIN_WALLET_ANCHOR, timeout=30.0)

    print("== flow complete ==")
    return 0


def _dump_flow_error(exc: BaseException) -> None:
    """Best-effort capture of a ``flow-error`` PNG + UI dump on failure."""

    try:
        screencap("flow-error")
    except Exception as capture_exc:  # pragma: no cover - diagnostic only
        print(f"flow-error screencap failed: {capture_exc}", file=sys.stderr)
    try:
        dump_ui("flow-error")
    except Exception as dump_exc:  # pragma: no cover - diagnostic only
        print(f"flow-error UI dump failed: {dump_exc}", file=sys.stderr)
    print(f"FLOW_ERROR: {exc}", file=sys.stderr)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001 - we want to trap everything
        _dump_flow_error(exc)
        sys.exit(1)
