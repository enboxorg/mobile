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
    """Best-effort check: does the device already have a lockscreen PIN?"""

    result = adb(
        "shell",
        "locksettings",
        "get-disabled",
        check=False,
    )
    # ``locksettings get-disabled`` prints ``true`` when the keyguard is
    # disabled (no credential set) and ``false`` otherwise.
    if result.returncode == 0 and result.stdout.strip().lower() == "false":
        return True
    # Fallback heuristic: attempt a set without --old and look for the
    # "already set" failure.
    probe = adb(
        "shell",
        "locksettings",
        "set-pin",
        DEVICE_PIN,
        check=False,
    )
    combined = f"{probe.stdout}\n{probe.stderr}".lower()
    if probe.returncode != 0 and (
        "already set" in combined
        or "existing" in combined
        or "old password" in combined
    ):
        return True
    if probe.returncode == 0:
        # We just set it to DEVICE_PIN, so it is now set.
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


def enroll_fingerprint(timeout: float = 120.0) -> None:
    """Enroll a fingerprint on the running emulator (idempotent).

    Steps:

    1. Early-return when ``dumpsys fingerprint`` already reports an
       enrolled finger (cached AVD). This satisfies VAL-CI-037.
    2. Launch the ``FINGERPRINT_ENROLL`` settings intent.
    3. If the keyguard asks for the device PIN, type ``0000``.
    4. Loop ``adb -e emu finger touch 1`` with a bounded retry budget
       until ``dumpsys fingerprint`` reports ``enrolled >= 1``.

    Raises :class:`TimeoutError` when enrollment cannot be verified within
    ``timeout`` seconds.
    """

    if enrolled_fingerprint_count() >= 1:
        print("[enroll_fingerprint] fingerprint already enrolled; skipping")
        return

    # Prefer the explicit FINGERPRINT_ENROLL intent; fall back to SECURITY_SETTINGS.
    adb(
        "shell",
        "am",
        "start",
        "-a",
        "android.settings.FINGERPRINT_ENROLL",
        check=False,
    )
    time.sleep(2)
    if _enter_device_pin_if_prompted(timeout=8.0):
        time.sleep(1.5)

    # Some OEM settings fall back to SECURITY_SETTINGS when the direct
    # FINGERPRINT_ENROLL intent is unavailable.
    if enrolled_fingerprint_count() < 1:
        adb(
            "shell",
            "am",
            "start",
            "-a",
            "android.settings.SECURITY_SETTINGS",
            check=False,
        )
        time.sleep(2)
        _enter_device_pin_if_prompted(timeout=5.0)

    deadline = time.time() + timeout
    touches = 0
    while time.time() < deadline:
        adb_emu("emu", "finger", "touch", FINGER_ID)
        touches += 1
        time.sleep(1)
        # Click "Next"/"Done" if the enrollment wizard is done.
        try:
            root = dump_ui()
        except subprocess.CalledProcessError:
            root = None
        if root is not None:
            for label in ("Done", "Next", "Fingerprint added", "Continue"):
                node = find_node_by_text(root, label)
                if node is not None:
                    tap_node(node)
                    time.sleep(1)
                    break
        if enrolled_fingerprint_count() >= 1:
            print(
                f"[enroll_fingerprint] enrolled after {touches} finger touch(es)"
            )
            return
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


def main() -> int:
    print("== preparing emulator (device credential + fingerprint) ==")
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
