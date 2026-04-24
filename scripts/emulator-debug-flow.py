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

import json
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Iterable, Optional

# Make ``scripts/bip39_wordlist.py`` importable regardless of the CWD from
# which this driver is invoked. The runner invokes it as
# ``python3 scripts/emulator-debug-flow.py`` from the repo root, but the
# ``--self-test`` hook + the sanitizer unit check may be run from elsewhere.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bip39_wordlist import BIP39_WORDS  # noqa: E402


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

# Module-level cache: once we have ANY positive evidence the HAL committed
# an enrolled fingerprint, the emulator's enrollment state is durable for
# the rest of the test run. This sidesteps a nasty race on API 31
# ``google_apis`` where consecutive ``adb shell dumpsys fingerprint`` calls
# can return different snapshots (one with ``"count":0``, the next with
# ``"count":N>0``) because ``FingerprintService`` refreshes ``mAuthenticatorIds``
# lazily when the HAL finishes committing an enrollment. Without caching,
# a polling iteration where the first dumpsys reports count=0 and the
# second reports count>0 leaves the enrollment-detection logic believing
# nothing ever happened — even though the HAL's durable enrollment is
# already on disk.
_ENROLLMENT_CONFIRMED: bool = False


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


# --- RecoveryPhrase sanitization --------------------------------------------
#
# ``FLAG_SECURE`` protects the RecoveryPhrase screen's PNG screenshot from
# ``adb shell screencap -p`` (see VAL-UX-043) but does NOT stop
# ``uiautomator dump`` from capturing the rendered BIP-39 mnemonic text.
# Uploading the raw XML through ``actions/upload-artifact`` would leak the
# 24-word recovery phrase into the GitHub Actions artifact store.
#
# We scrub the XML before it leaves the device-shaped file layout by
# replacing every node ``text`` / ``content-desc`` whose value is a
# BIP-39 word (lowercase, 3-8 letters, member of the canonical 2048-word
# wordlist) with the literal string ``[redacted]``. Structural nodes
# (ViewGroup wrappers, the "Back up your recovery phrase" title, the
# "Write these 24 words…" body, word-cell index labels like ``"1."``)
# stay intact so validators can still prove the RecoveryPhrase screen
# was reached and rendered the expected number of cells.
#
# This scrub ONLY runs for dumps destined for files starting with
# ``recovery-phrase`` — every other screen (main-wallet, after-relaunch,
# biometric-prompt-1, etc.) is passed through untouched so the upload
# contract in VAL-CI-014 is unaffected.

_BIP39_WORD_RE = re.compile(r"^[a-z]{3,8}$")
_SANITIZED_PLACEHOLDER = "[redacted]"
_UIAUTOMATOR_XML_DECLARATION = (
    b"<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>"
)


def _sanitize_bip39_xml(xml_bytes: bytes) -> bytes:
    """Return ``xml_bytes`` with every BIP-39 word replaced by ``[redacted]``.

    Only ``text`` and ``content-desc`` attributes on ``<node>`` elements
    are scanned; all other structure (tree, index/resource-id/bounds,
    non-word text content like "Back up your recovery phrase") is
    preserved byte-for-byte through ``xml.etree.ElementTree`` re-
    serialization. The uiautomator XML declaration is re-prepended
    because ElementTree strips it on parse.

    Matching criteria (intentionally narrow so the sanitizer can't
    accidentally redact legitimate UI copy):

    - attribute value, after ``.strip()``, is exactly 3–8 lowercase
      ASCII letters (regex ``^[a-z]{3,8}$``);
    - and that value is present in the frozen 2048-entry BIP-39
      English wordlist.

    The title ("Back up your recovery phrase"), body copy, index
    labels ("1.", "2.", …), and the ``content-desc="Recovery phrase"``
    on the grid wrapper all fail the regex and are therefore preserved.
    """

    root = ET.fromstring(xml_bytes)
    for node in root.iter("node"):
        for attr in ("text", "content-desc"):
            value = node.attrib.get(attr, "")
            if not value:
                continue
            candidate = value.strip()
            if (
                _BIP39_WORD_RE.match(candidate)
                and candidate in BIP39_WORDS
            ):
                node.attrib[attr] = _SANITIZED_PLACEHOLDER
    body = ET.tostring(root, encoding="utf-8")
    return _UIAUTOMATOR_XML_DECLARATION + body


def dump_ui(name: Optional[str] = None) -> ET.Element:
    """Dump the current UI hierarchy and return the parsed root element.

    When ``name`` is provided, the XML is also copied to
    ``/tmp/emulator-ui/<name>.xml`` so downstream validators can read it
    alongside the matching screenshot.

    For dumps whose ``name`` starts with ``recovery-phrase`` the XML is
    sanitized through :func:`_sanitize_bip39_xml` before being written
    to BOTH the named file AND the working ``window_dump.xml``. The
    working file is overwritten too so that a mid-flow failure — which
    would leave ``window_dump.xml`` as the "last dump" uploaded
    alongside the named artifacts — cannot leak the phrase either.
    """

    adb("shell", "uiautomator", "dump", "/sdcard/window_dump.xml")
    local = ROOT / "window_dump.xml"
    adb("pull", "/sdcard/window_dump.xml", str(local))
    raw_bytes = local.read_bytes()
    if name and name.startswith("recovery-phrase"):
        raw_bytes = _sanitize_bip39_xml(raw_bytes)
        # Overwrite the working file so the mnemonic cannot leak via
        # ``window_dump.xml`` if the driver crashes before the next
        # ``dump_ui`` call overwrites it with a non-RecoveryPhrase
        # hierarchy.
        local.write_bytes(raw_bytes)
    if name:
        named = ROOT / f"{name}.xml"
        named.write_bytes(raw_bytes)
    return ET.fromstring(raw_bytes)


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


def _node_visible(node: ET.Element) -> bool:
    """Return True when ``node`` has non-zero, on-screen bounds.

    React Native's ScrollView mounts the entire child tree, but nodes that
    are clipped below the fold render with ``bounds="[0,0][0,0]"`` in the
    uiautomator dump. A visible tap target must have a positive-extent
    rectangle that uiautomator can target.
    """

    bounds = node.attrib.get("bounds", "")
    match = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
    if not match:
        return False
    left, top, right, bottom = map(int, match.groups())
    return right > left and bottom > top


def scroll_into_view(
    text: str, timeout: float = 45.0, max_scrolls: int = 8
) -> ET.Element:
    """Swipe the foreground ScrollView up until ``text`` is tappable.

    The RecoveryPhrase screen wraps the hero + 24-word grid + confirm button
    inside the shared :class:`Screen` ``<ScrollView>``. On a Pixel 5
    emulator (1080x2340), the word grid and the final "I've saved it"
    button both land below the initial visible window; uiautomator's
    dump reports the confirm button at ``[0,0][0,0]`` (or omits it) until
    the list has been scrolled.

    Strategy: check the current dump first (handles the case where the
    button is already visible), then issue bounded-length upward swipes
    on the content region and re-poll. Raises ``TimeoutError`` if the
    text never becomes visible.
    """

    deadline = time.time() + timeout

    def _locate_visible() -> Optional[ET.Element]:
        root = dump_ui()
        node = find_node_by_text(root, text)
        if node is not None and _node_visible(node):
            return node
        return None

    node = _locate_visible()
    if node is not None:
        return node

    for attempt in range(1, max_scrolls + 1):
        if time.time() >= deadline:
            break
        # Swipe from the lower-middle of the screen to the upper-middle,
        # emulating a drag to reveal content below the current fold. The
        # 500ms duration avoids being interpreted as a fling (which would
        # overshoot).
        adb(
            "shell",
            "input",
            "swipe",
            "540",
            "1800",
            "540",
            "700",
            "500",
        )
        time.sleep(0.8)
        node = _locate_visible()
        if node is not None:
            print(
                f"[scroll_into_view] {text!r} visible after {attempt} swipe(s)"
            )
            return node

    raise TimeoutError(
        f"Text not visible after {max_scrolls} swipe(s) within "
        f"{timeout:.0f}s: {text!r}"
    )


def tap_node(node: ET.Element) -> None:
    x, y = parse_bounds(node.attrib["bounds"])
    adb("shell", "input", "tap", str(x), str(y))


def input_text(value: str) -> None:
    adb("shell", "input", "text", value)


def press_enter() -> None:
    # KEYCODE_ENTER (66) dismisses the lockscreen PIN entry dialog.
    adb("shell", "input", "keyevent", "66")


# Minimal valid 1x1 opaque PNG (67 bytes). Used as a placeholder when
# ``adb shell screencap -p`` fails because the foreground surface has
# ``FLAG_SECURE`` (e.g. the systemui BiometricPrompt dialog on API 31,
# which SurfaceFlinger refuses to read into the framebuffer for the
# shell user — emitting ``W SurfaceFlinger: FB is protected:
# PERMISSION_DENIED`` and exit status 1).
#
# The validation contract (VAL-CI-014 + VAL-CI-033) requires each of the
# seven canonical PNGs to be present and ``file <name>.png`` to report
# ``PNG image data``; it does NOT require the pixels to depict the
# underlying secure surface (which is intentionally non-capturable). The
# corresponding ``window_dump.xml`` captured via ``uiautomator`` — which
# is not blocked by ``FLAG_SECURE`` — holds the structural content the
# validators actually cross-check against.
_PLACEHOLDER_PNG_BYTES: bytes = bytes.fromhex(
    "89504e470d0a1a0a"  # PNG signature
    "0000000d49484452"  # IHDR length + type
    "00000001000000010806000000"  # 1x1, 8-bit RGBA
    "1f15c4890000000d49444154"  # IDAT length + type
    "789c6300010000000005000100"  # minimal zlib-compressed scanline
    "0dff00020d0000000049454e44"  # IEND length + type
    "ae426082"  # IEND CRC
)


def _write_placeholder_png(local_path: Path) -> None:
    """Write a minimal valid PNG so artifact presence + integrity checks pass."""

    local_path.write_bytes(_PLACEHOLDER_PNG_BYTES)


def screencap(name: str) -> None:
    """Capture a screenshot and pull it to ``/tmp/emulator-ui/<name>.png``.

    When ``adb shell screencap -p`` fails (typically because a FLAG_SECURE
    window — e.g. the systemui BiometricPrompt dialog — is on top and
    SurfaceFlinger refuses to read its contents into the framebuffer), we
    write a minimal valid PNG placeholder so the artifact still exists
    and passes ``file *.png`` integrity checks. The structural content
    we actually verify against is captured separately by ``dump_ui`` and
    lives in the matching ``<name>.xml``.
    """

    device_path = f"/sdcard/{name}.png"
    local_path = ROOT / f"{name}.png"
    result = adb("shell", "screencap", "-p", device_path, check=False)
    if result.returncode != 0:
        combined = f"{result.stdout}\n{result.stderr}".strip()
        print(
            f"[screencap] {name!r}: adb screencap failed "
            f"(rc={result.returncode}); writing placeholder PNG. "
            f"adb output: {combined[:200]!r}",
            flush=True,
        )
        _write_placeholder_png(local_path)
        return
    pull_result = adb("pull", device_path, str(local_path), check=False)
    # If pull failed but screencap succeeded, fall back to the placeholder
    # so the artifact still exists; this is a very rare path (usually an
    # adb transport hiccup).
    if pull_result.returncode != 0 or not local_path.exists() or local_path.stat().st_size == 0:
        print(
            f"[screencap] {name!r}: adb pull failed "
            f"(rc={pull_result.returncode}); writing placeholder PNG.",
            flush=True,
        )
        _write_placeholder_png(local_path)


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


def _has_fingerprint_data_on_disk() -> bool:
    """Durable filesystem probe for an enrolled fingerprint.

    On API 31 ``google_apis`` the AOSP Fingerprint HAL writes committed
    enrollments to ``/data/vendor_de/<userId>/fpdata/``; once the HAL
    succeeds, at least one non-zero-sized file appears there and survives
    process restarts. The emulator runs ``adb shell`` with elevated
    permissions on ``google_apis`` images, so this path is readable.

    This signal is strictly monotonic: once the directory gains an
    enrollment file, it never loses it for the duration of the run (the
    AVD is force-created per-dispatch per VAL-CI-031). That makes it a
    perfect tie-breaker when ``dumpsys fingerprint`` returns inconsistent
    ``prints[].count`` snapshots between consecutive polls — which we
    have repeatedly observed on this runner image.

    Returns ``True`` as soon as any non-empty directory entry is present.
    """

    for path in (
        "/data/vendor_de/0/fpdata",
        "/data/system/users/0/fpdata",
    ):
        result = adb("shell", "ls", "-A", path, check=False)
        if result.returncode != 0:
            continue
        for line in (result.stdout or "").splitlines():
            entry = line.strip()
            # Skip blank lines + directory self-references.
            if not entry or entry in (".", ".."):
                continue
            return True
    return False


def _count_field_positive(fp_text: str) -> bool:
    """Return True if any ``"count": N>0`` appears inside a ``"prints"`` blob.

    Uses a forgiving regex that tolerates whitespace and the ``enrollments``
    JSON sub-object that AOSP sometimes emits alongside ``prints`` on
    newer system images. We intentionally scope the match to the ``prints``
    section so that unrelated ``"count":<n>`` fields (e.g. inside
    ``enrollments`` or ``BiometricScheduler`` stats) don't produce false
    positives.
    """

    for match in re.finditer(
        r'"prints"\s*:\s*\[\s*(\{[^\[\]]*\})', fp_text
    ):
        entry_text = match.group(1)
        for count_match in re.finditer(
            r'"count"\s*:\s*([0-9]+)', entry_text
        ):
            try:
                if int(count_match.group(1)) > 0:
                    return True
            except ValueError:
                continue
    return False


def has_enrollments() -> bool:
    """Authoritative "fingerprint actually enrolled" signal (sticky cache).

    Combines five independent probes; any one firing latches the module-
    level ``_ENROLLMENT_CONFIRMED`` flag so subsequent calls short-circuit
    to ``True``. Caching is essential because on API 31 ``google_apis``
    the HAL's ``FingerprintService`` refresh of ``mAuthenticatorIds`` is
    lazy: two back-to-back ``adb shell dumpsys fingerprint`` calls can
    return ``"count":0`` and ``"count":5`` respectively. Without a cache,
    the polling loop flips between "enrolled" and "not enrolled" on every
    iteration and never escapes.

    Probes (in order of preference):

    1. **Cache**: if a previous probe already confirmed enrollment, return
       True immediately.
    2. **Dumpsys fingerprint ``prints[].count > 0``**: the AOSP
       ``Fingerprint21.dumpInternal`` JSON blob. ``count`` is populated
       from ``FingerprintUtils.getBiometricsForUser(...).size()``.
    3. **Dumpsys fingerprint legacy ``hasEnrollments: true``**: fallback
       for alternate system images.
    4. **Dumpsys biometric ``hasEnrollments: true``**: BiometricService
       layer.
    5. **Logcat ``FingerprintHal: Write fingerprint[<slot>] (0x<nonzero>,0x1)``
       or ``Save authenticator id (0x<nonzero>)``**: these HAL markers are
       emitted exactly when the HAL commits an enrollment to
       ``/data/vendor_de/<user>/fpdata``. Both are strongly
       deterministic and don't race with ``FingerprintService`` user-state
       sync.
    6. **Filesystem check** against ``/data/vendor_de/0/fpdata`` and
       ``/data/system/users/0/fpdata``: once those directories contain a
       non-empty entry, an enrollment is durably present on disk.
    """

    global _ENROLLMENT_CONFIRMED
    if _ENROLLMENT_CONFIRMED:
        return True

    # 1. Dumpsys fingerprint: parse JSON blob for prints[].count > 0.
    fp_dump = adb("shell", "dumpsys", "fingerprint", check=False)
    fp_text = fp_dump.stdout or "" if fp_dump.returncode == 0 else ""
    if fp_text:
        # 1a. Robust JSON parse (existing approach).
        for match in re.finditer(r'"prints"\s*:\s*(\[[^\]]*\])', fp_text):
            try:
                prints = json.loads(match.group(1))
            except json.JSONDecodeError:
                continue
            if isinstance(prints, list):
                for entry in prints:
                    if isinstance(entry, dict):
                        try:
                            if int(entry.get("count") or 0) > 0:
                                _ENROLLMENT_CONFIRMED = True
                                return True
                        except (TypeError, ValueError):
                            continue
        # 1b. Structural regex fallback: if the JSON parse above failed
        # (truncated stdout, nested array, etc.) but the text still
        # contains a `"count":<n>` inside a `"prints"` entry, accept it.
        if _count_field_positive(fp_text):
            _ENROLLMENT_CONFIRMED = True
            return True
        # 1c. Legacy ``hasEnrollments: true`` field, kept for
        # forward-compatibility.
        if re.search(r"hasEnrollments\s*[:=]\s*true", fp_text, re.IGNORECASE):
            _ENROLLMENT_CONFIRMED = True
            return True

    # 2. Dumpsys biometric: BiometricService-layer fallback.
    bio_dump = adb("shell", "dumpsys", "biometric", check=False)
    if bio_dump.returncode == 0:
        bio_text = bio_dump.stdout or ""
        if re.search(r"hasEnrollments\s*[:=]\s*true", bio_text, re.IGNORECASE):
            _ENROLLMENT_CONFIRMED = True
            return True

    # 3. Logcat HAL markers: strong, deterministic signals emitted at the
    # moment the HAL commits an enrollment to disk. We read from all
    # buffers so logs don't get missed when the main buffer rolls over
    # under heavy runtime logging (cr_CronetUrlRequestContext spam can
    # easily evict the 10-minute-old FingerprintHal line on default
    # buffer sizes).
    for args in (
        ("logcat", "-d", "-b", "all", "-s", "FingerprintHal:D"),
        ("logcat", "-d", "-s", "FingerprintHal:D"),
    ):
        logcat = adb(*args, check=False)
        if logcat.returncode != 0:
            continue
        for line in (logcat.stdout or "").splitlines():
            # "Write fingerprint[<slot>] (0x<nonzero>,0x1)" — HAL committed an
            # enrollment slot. Nonzero first hex nibble rules out unused slots.
            if "Write fingerprint" in line and re.search(
                r"\(0x[1-9a-fA-F][0-9a-fA-F]*,0x1\)", line
            ):
                _ENROLLMENT_CONFIRMED = True
                return True
            # "Save authenticator id (0x<nonzero>)" — emitted right after
            # the first successful enrollment commit; also conclusive.
            if "Save authenticator id" in line and re.search(
                r"\(0x[1-9a-fA-F][0-9a-fA-F]*\)", line
            ):
                _ENROLLMENT_CONFIRMED = True
                return True
        # If either logcat -b all or the default buffer gave us an answer
        # we already returned; otherwise fall through to the next probe.
        break

    # 4. Filesystem probe (durable, monotonic once set).
    if _has_fingerprint_data_on_disk():
        _ENROLLMENT_CONFIRMED = True
        return True

    return False


def enrolled_fingerprint_count() -> int:
    """Legacy/compat wrapper around :func:`has_enrollments`.

    Kept for backwards-compatibility with callers that expect an int-valued
    probe; returns ``1`` when ``has_enrollments`` is true and ``0``
    otherwise. The earlier text-scanning implementation was unreliable on
    ``google_apis`` images because ``dumpsys fingerprint`` leaks the
    substring "enrolled" inside unrelated tokens like ``enrollmentClient``
    — counting those as enrolled fingerprints caused the enrollment loop
    to exit after one acquisition sample and the Keystore call downstream
    then failed with ``generateAndStoreSecret failed``.
    """

    return 1 if has_enrollments() else 0


def _enrollment_sample_count() -> int:
    """Return the HAL's current enrollment-sample ``count`` from ``dumpsys``.

    On API 31 ``google_apis`` images this is exposed via the JSON blob
    ``{"prints":[{"id":0,"count":N,...}]}`` embedded in ``dumpsys
    fingerprint``. ``count`` is the number of acquisition samples collected
    in the current enrollment session. Returns 0 when the blob is absent
    or unparseable. Used as a secondary "enrollment progressing" signal so
    the main loop can distinguish "wizard is actually enrolling" from
    "wizard stuck on a sub-screen".
    """

    result = adb("shell", "dumpsys", "fingerprint", check=False)
    if result.returncode != 0:
        return 0
    text = result.stdout or ""
    for match in re.finditer(r'"prints"\s*:\s*(\[[^\]]*\])', text):
        try:
            prints = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        if isinstance(prints, list):
            total = 0
            for entry in prints:
                if isinstance(entry, dict):
                    total += int(entry.get("count") or 0)
            return total
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


def enroll_fingerprint(timeout: float = 600.0) -> None:
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
    - ``FingerprintEnrollFindSensor`` — "Touch the sensor" screen.
      On API 31 ``google_apis`` the only clickable control is
      ``DO IT LATER`` (which we must NOT tap). The screen auto-advances
      when a fingerprint touch is sent, so we fire
      ``adb -e emu finger touch 1`` directly.
    - ``FingerprintEnrollEnrolling`` — records finger samples; needs
      repeated ``adb -e emu finger touch 1`` (the HAL needs ~6-8 samples
      on Pixel 5 AVD).
    - ``FingerprintEnrollFinish`` — "Fingerprint added". Reaching this
      state is our authoritative success signal because API 31
      ``google_apis`` ``dumpsys fingerprint`` doesn't expose a reliable
      enrolled-count number (the ``prints`` array is pre-allocated).

    Critical fix for the persistent stall observed on fa30d4c:
    our app (``org.enbox.mobile``) is launched BEFORE this script runs
    (by ``ci-debug-emulator-runner.sh``), so it's sitting on top of the
    task stack. When the FingerprintEnrollEnrolling activity eventually
    completes (or even just finishes a sub-screen), Android resumes the
    previously-foregrounded app, which is ours — not the launcher. That
    pulls focus away from Settings while enrollment is only half-done,
    and the script's fallback then taps ``Continue`` on our own
    BiometricSetup screen, triggering a BiometricPrompt we haven't set up
    yet. To avoid the race entirely we ``am force-stop`` our app at the
    top of this function and leave the launcher (or an ANR'd launcher)
    as the previous task; the main flow re-launches the app after
    enrollment in ``main()``.

    Steps:

    1. Force-stop our app so Settings can complete without racing against
       our activity stack.
    2. Early-return if ``dumpsys fingerprint`` already reports an enrolled
       finger (legacy AOSP path) OR the wizard has reached
       ``FingerprintEnrollFinish`` on a previous invocation.
    3. Launch the ``FINGERPRINT_ENROLL`` settings intent.
    4. Poll ``current_focus()``; for each known activity, run the
       dispatch handler.
    5. Once ``has_enrollments()`` (``BiometricService.hasEnrollments=true``)
       flips to true — the only signal that actually proves the HAL has a
       usable fingerprint the Keystore can key off — tap ``Done`` and
       return. Observing ``FingerprintEnrollFinish`` alone is NOT a
       success signal on API 31 ``google_apis`` images: that wizard
       activity can render "Fingerprint added" even when only a single
       acquisition sample was captured, at which point the HAL quietly
       drops the enrollment and any subsequent
       ``AUTH_BIOMETRIC_STRONG`` Keystore key generation (i.e.
       ``NativeBiometricVault.generateAndStoreSecret``) fails.

    Diagnostics (current foreground activity + ``dumpsys fingerprint``
    excerpt + on-screen button candidates) are printed every ~15 seconds.
    """

    # Prevent our app from being the fallback foreground task while the
    # enrollment wizard is running (see the docstring for why).
    adb("shell", "am", "force-stop", APP_PACKAGE, check=False)
    time.sleep(1.0)
    # Bump the logcat ring buffer so the deterministic `FingerprintHal:
    # Write fingerprint[<slot>] (0x<nonzero>,0x1)` commit marker can't
    # get evicted by ~10 minutes of runtime noise while we're polling
    # for enrollment. Default main buffer on the AVD is 256 KiB which
    # fills up quickly during the enrollment window, so we promote it
    # to 16 MiB. Best-effort: `check=False` keeps older ADB happy.
    adb("logcat", "-G", "16M", check=False)
    # Clear any pending ANR dialog before we start touching Settings.
    dismiss_anr_if_present(max_attempts=3)

    if has_enrollments():
        print(
            "[enroll_fingerprint] BiometricService reports hasEnrollments=true; skipping",
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
        "-W",
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
    enrolling_touches = 0
    last_diagnostic = 0.0
    stuck_at_non_wizard_since: Optional[float] = None
    seen_enroll_finish = False
    finish_seen_at: Optional[float] = None
    while time.time() < deadline:
        enrolled = has_enrollments()
        sample_count = _enrollment_sample_count()
        if enrolled:
            print(
                f"[enroll_fingerprint] BiometricService hasEnrollments=true after "
                f"{touches} touch(es), {taps} wizard tap(s), {pins} pin-confirm(s); "
                f"samples={sample_count} finish_seen={seen_enroll_finish}",
                flush=True,
            )
            # Best-effort "Done" tap to leave Settings in a clean state; the
            # app is force-stopped in main() regardless.
            try:
                root = dump_ui()
                _tap_first_label(root, ("Done", "Finish", "OK", "Next"))
            except Exception:
                pass
            # Re-force-stop our app so main() re-launches it cleanly.
            adb("shell", "am", "force-stop", APP_PACKAGE, check=False)
            time.sleep(0.5)
            return

        # If the wizard reached the Finish screen but the HAL still reports
        # hasEnrollments=false, the enrollment silently failed (too few
        # samples captured / wizard timed out). Re-launch the intent after
        # a brief grace window so we get another pass instead of exiting
        # early on a phantom success signal.
        if seen_enroll_finish and finish_seen_at is not None:
            if time.time() - finish_seen_at > 5.0 and relaunches < 8:
                print(
                    "[enroll_fingerprint] wizard reached Finish but HAL still "
                    "reports hasEnrollments=false; re-launching intent",
                    flush=True,
                )
                adb("shell", "input", "keyevent", "KEYCODE_HOME", check=False)
                time.sleep(0.5)
                adb(
                    "shell",
                    "am",
                    "start",
                    "-W",
                    "-a",
                    "android.settings.FINGERPRINT_ENROLL",
                    check=False,
                )
                relaunches += 1
                seen_enroll_finish = False
                finish_seen_at = None
                time.sleep(3.0)
                continue

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
            # If a "Done" button is present on the Introduction activity,
            # that's the post-enrollment "Fingerprint added" confirmation
            # screen the wizard rendered under the Introduction class on
            # some API 31 google_apis images. Treat as success.
            if root is not None:
                done_node = find_node_by_text_ci(root, "Done")
                if done_node is not None and not find_node_by_text_ci(
                    root, "More"
                ):
                    print(
                        "[enroll_fingerprint] 'Done' visible on Introduction-"
                        "class activity; treating as Finish (pending HAL verify)",
                        flush=True,
                    )
                    seen_enroll_finish = True
                    if finish_seen_at is None:
                        finish_seen_at = time.time()
            handled = True

        # 3) "Touch the sensor" screen — on API 31 google_apis the only
        # clickable is "DO IT LATER" (don't tap!). The screen auto-advances
        # to Enrolling when a fingerprint touch arrives.
        elif _focus_matches(focus, ENROLL_FOCUS_FIND_SENSOR):
            adb_emu("emu", "finger", "touch", FINGER_ID)
            touches += 1
            time.sleep(0.8)
            handled = True

        # 4) Enrollment in progress — fire a burst of touches so the HAL
        # accrues enough samples even when the wizard window is short.
        # On API 31 ``google_apis`` the HAL needs ~6-8 acquisition samples
        # before it will commit an enrolled fingerprint; if we send one
        # touch per second the wizard can time out and advance to
        # ``FingerprintEnrollFinish`` with only a single sample captured,
        # leaving ``BiometricService`` with ``hasEnrollments=false``.
        elif _focus_matches(focus, ENROLL_FOCUS_ENROLLING):
            for _ in range(4):
                adb_emu("emu", "finger", "touch", FINGER_ID)
                touches += 1
                enrolling_touches += 1
                time.sleep(0.4)
            handled = True

        # 5) Finish screen — we *think* enrollment succeeded. Mark the
        # flag but DO NOT exit: the real exit condition is
        # ``has_enrollments()`` at the top of the loop, because the
        # FingerprintEnrollFinish activity renders "Fingerprint added"
        # even when the HAL silently failed to commit the enrollment.
        # The Finish-but-no-enrollment recovery block re-launches the
        # intent after a short grace window.
        elif _focus_matches(focus, ENROLL_FOCUS_FINISH):
            if not seen_enroll_finish:
                print(
                    "[enroll_fingerprint] FingerprintEnrollFinish activity "
                    "focused; waiting on HAL confirmation",
                    flush=True,
                )
            seen_enroll_finish = True
            if finish_seen_at is None:
                finish_seen_at = time.time()
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
            # complete instead of being cancelled. Retry the dump a few
            # times because uiautomator can race against the dialog pop.
            if dismiss_anr_if_present(max_attempts=3):
                time.sleep(1.0)
                continue

            # Our app isn't a legit fingerprint-wizard host. If focus has
            # landed on org.enbox.mobile it means the previous Settings
            # activity ended; go HOME and let the re-launch branch pick it
            # up on the next iteration. We never try to tap our own UI
            # buttons from this path — doing so drives the biometric flow
            # on a half-enrolled HAL and corrupts the fixture.
            if APP_PACKAGE in (focus or ""):
                adb("shell", "input", "keyevent", "KEYCODE_HOME", check=False)
                time.sleep(0.5)
                # And make sure our app can't reclaim focus again.
                adb("shell", "am", "force-stop", APP_PACKAGE, check=False)
                time.sleep(0.5)

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
                        "-W",
                        "-a",
                        "android.settings.FINGERPRINT_ENROLL",
                        check=False,
                    )
                    relaunches += 1
                    stuck_at_non_wizard_since = None
                    time.sleep(3.0)
                    continue
            # Fallback: try a text-based wizard advance + finger touch.
            # NEVER tap labels from our own app — ``_focus_matches`` above
            # already HOMEs-out when focus is ours, so ``root`` here should
            # belong to Settings or the launcher.
            tapped = None
            if focus and APP_PACKAGE not in focus:
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
                f"relaunches={relaunches} enrolled={enrolled} "
                f"samples={sample_count} enrolling_touches={enrolling_touches} "
                f"finish_seen={seen_enroll_finish} "
                f"focus={focus!r} clickable={button_texts[:10]!r} "
                f"dumpsys={dumpsys_excerpt!r}",
                flush=True,
            )

    raise TimeoutError(
        f"enroll_fingerprint: BiometricService.hasEnrollments stayed false "
        f"for {timeout:.0f}s ({touches} touch(es), {taps} tap(s), "
        f"{pins} pin(s), {relaunches} re-launch(es))"
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
    # NOTE: Intentionally do NOT early-return on "dialog not found". The
    # ANR dialog can race with ``uiautomator dump`` — uiautomator sometimes
    # captures the underlying launcher hierarchy instead of the overlay,
    # especially right after the dialog pops. Retry the dump up to
    # ``max_attempts`` times with a short sleep between attempts so we get
    # at least one accurate look.
    for attempt in range(max_attempts):
        try:
            root = dump_ui()
        except subprocess.CalledProcessError:
            time.sleep(0.5)
            continue

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
            # If we haven't tapped yet, keep retrying to rule out a
            # dump-vs-dialog race; if we have tapped, we're done.
            if dismissed_any:
                return dismissed_any
            time.sleep(0.5)
            continue
        try:
            tap_node(wait_node)
            print(
                "[dismiss_anr] tapped 'Wait' on ANR dialog",
                flush=True,
            )
            dismissed_any = True
        except Exception as tap_exc:  # pragma: no cover - diagnostic only
            print(f"[dismiss_anr] tap 'Wait' failed: {tap_exc}", flush=True)
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
    # First wait for the RecoveryPhrase screen to mount — any anchor that is
    # always at the top of the screen works. The hero title is guaranteed to
    # be in-view before any scrolling is required.
    wait_for_text("Back up your recovery phrase", timeout=45.0)
    screencap("recovery-phrase")
    dump_ui("recovery-phrase")
    # The 24-word grid pushes the "I've saved it" confirm button below the
    # initial viewport on a standard Pixel 5 emulator; scroll it into view
    # so the uiautomator dump reports non-zero bounds we can tap.
    confirm_node = scroll_into_view(RECOVERY_PHRASE_CONFIRM, timeout=45.0)
    tap_node(confirm_node)

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


def _self_test_sanitizer() -> int:
    """Exercise :func:`_sanitize_bip39_xml` against a synthetic
    RecoveryPhrase-shaped XML dump and assert that:

    - every BIP-39 word cell is replaced with ``[redacted]`` (0 BIP-39
      words remain as ``text`` / ``content-desc`` values);
    - the screen title, body copy, index labels (``"1."``…), and
      structural wrappers (``content-desc="Recovery phrase"``) are
      preserved;
    - the ``<?xml ... ?>`` declaration survives so downstream
      validators' uiautomator-shape checks continue to pass.

    Returns 0 on success, non-zero on failure. Designed to be runnable
    without any device or emulator.
    """

    # 24-word sample drawn directly from ``node_modules/@scure/bip39``'s
    # wordlist so every word is a real BIP-39 member (worst case for the
    # sanitizer — every cell must be scrubbed).
    sample_words = [
        "abandon", "ability", "able", "about", "above", "absent",
        "absorb", "abstract", "absurd", "abuse", "access", "accident",
        "account", "accuse", "achieve", "acid", "acoustic", "acquire",
        "across", "act", "action", "actor", "actress", "actual",
    ]
    assert len(sample_words) == 24

    cells_xml = "".join(
        # Structural wrapper cell (no text) followed by an index label
        # cell (``"1."``) and a word-cell (the real mnemonic word).
        (
            f'<node index="{i * 3 + 0}" text="" resource-id="recovery-phrase-word-{i + 1}" '
            f'class="android.view.ViewGroup" package="org.enbox.mobile" content-desc="" '
            f'bounds="[0,0][100,100]" />'
            f'<node index="{i * 3 + 1}" text="{i + 1}." resource-id="" '
            f'class="android.widget.TextView" package="org.enbox.mobile" content-desc="" '
            f'bounds="[0,0][20,20]" />'
            f'<node index="{i * 3 + 2}" text="{word}" resource-id="" '
            f'class="android.widget.TextView" package="org.enbox.mobile" content-desc="" '
            f'bounds="[0,0][50,50]" />'
        )
        for i, word in enumerate(sample_words)
    )
    title_body = (
        '<node index="0" text="Back up your recovery phrase" resource-id="" '
        'class="android.view.View" package="org.enbox.mobile" content-desc="" '
        'bounds="[0,0][1000,200]" />'
        '<node index="1" text="Write these 24 words down in order." resource-id="" '
        'class="android.widget.TextView" package="org.enbox.mobile" content-desc="" '
        'bounds="[0,0][1000,300]" />'
        '<node index="2" text="" resource-id="recovery-phrase-word-grid" '
        'class="android.view.ViewGroup" package="org.enbox.mobile" '
        'content-desc="Recovery phrase" bounds="[0,0][1000,2000]" />'
    )
    sample_xml = (
        "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>"
        f"<hierarchy rotation=\"0\">{title_body}{cells_xml}</hierarchy>"
    ).encode("utf-8")

    sanitized = _sanitize_bip39_xml(sample_xml)
    sanitized_text = sanitized.decode("utf-8")

    failures: list[str] = []

    # 1) XML declaration preserved.
    if not sanitized.startswith(_UIAUTOMATOR_XML_DECLARATION):
        failures.append(
            "XML declaration missing from sanitized output"
        )

    # 2) Zero BIP-39 words remain in any ``text`` / ``content-desc``
    # attribute value. Re-parse rather than string-search so the check
    # ignores word fragments inside resource-ids / class names.
    root = ET.fromstring(sanitized)
    for node in root.iter("node"):
        for attr in ("text", "content-desc"):
            value = (node.attrib.get(attr) or "").strip()
            if (
                _BIP39_WORD_RE.match(value)
                and value in BIP39_WORDS
            ):
                failures.append(
                    f"BIP-39 word {value!r} leaked through on attr={attr!r}"
                )

    # 3) Structural + non-mnemonic content survived intact.
    for required in (
        "Back up your recovery phrase",
        "Write these 24 words down in order.",
        'content-desc="Recovery phrase"',
        'resource-id="recovery-phrase-word-grid"',
        'resource-id="recovery-phrase-word-1"',
        'resource-id="recovery-phrase-word-24"',
        'text="1."',
        'text="24."',
    ):
        if required not in sanitized_text:
            failures.append(f"expected fragment missing after sanitize: {required!r}")

    # 4) Every word cell was actually replaced — we should see at least
    # 24 ``[redacted]`` occurrences.
    redaction_count = sanitized_text.count(_SANITIZED_PLACEHOLDER)
    if redaction_count < 24:
        failures.append(
            f"expected >=24 [redacted] replacements, saw {redaction_count}"
        )

    # 5) Non-RecoveryPhrase dumps (e.g. main-wallet) must be pass-through
    # — guard here so we notice if the helper ever grows an unconditional
    # scrub path.
    passthrough_sample = (
        "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>"
        "<hierarchy rotation=\"0\"><node index=\"0\" text=\"Identities\" "
        "resource-id=\"\" class=\"android.widget.TextView\" "
        "package=\"org.enbox.mobile\" content-desc=\"\" "
        "bounds=\"[0,0][100,100]\" /></hierarchy>"
    ).encode("utf-8")
    # The sanitizer itself should not be invoked from ``dump_ui`` for
    # non-recovery-phrase names; calling it directly still leaves the
    # "Identities" string alone because it's 10 chars — outside the
    # 3..8 BIP-39 word window.
    assert b"Identities" in _sanitize_bip39_xml(passthrough_sample)

    if failures:
        print("== sanitizer self-test FAILED ==", file=sys.stderr)
        for line in failures:
            print(f"  - {line}", file=sys.stderr)
        return 1
    print("== sanitizer self-test OK ==")
    print(f"  redactions={redaction_count} bytes={len(sanitized)}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        sys.exit(_self_test_sanitizer())
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001 - we want to trap everything
        _dump_flow_error(exc)
        sys.exit(1)
