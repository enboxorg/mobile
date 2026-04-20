#!/usr/bin/env python3

import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path("/tmp/emulator-ui")
ROOT.mkdir(parents=True, exist_ok=True)


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=check, text=True, capture_output=True)


def adb(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run("adb", *args, check=check)


def dump_ui() -> ET.Element:
    adb("shell", "uiautomator", "dump", "/sdcard/window_dump.xml")
    adb("pull", "/sdcard/window_dump.xml", str(ROOT / "window_dump.xml"))
    return ET.parse(ROOT / "window_dump.xml").getroot()


def parse_bounds(bounds: str) -> tuple[int, int]:
    match = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
    if not match:
        raise ValueError(f"Invalid bounds: {bounds}")
    left, top, right, bottom = map(int, match.groups())
    return (left + right) // 2, (top + bottom) // 2


def find_node_by_text(root: ET.Element, text: str) -> ET.Element | None:
    for node in root.iter("node"):
        if node.attrib.get("text") == text or node.attrib.get("content-desc") == text:
            return node
    for node in root.iter("node"):
        node_text = node.attrib.get("text", "")
        if text in node_text:
            return node
    return None


def wait_for_text(text: str, timeout: float = 25.0) -> ET.Element:
    deadline = time.time() + timeout
    while time.time() < deadline:
        root = dump_ui()
        node = find_node_by_text(root, text)
        if node is not None:
            return node
        time.sleep(1)
    raise RuntimeError(f"Text not found within timeout: {text}")


def tap_text(text: str, timeout: float = 25.0) -> None:
    node = wait_for_text(text, timeout)
    x, y = parse_bounds(node.attrib["bounds"])
    adb("shell", "input", "tap", str(x), str(y))


def tap_center() -> None:
    adb("shell", "wm", "size")
    # Good default for portrait phone emulator.
    adb("shell", "input", "tap", "540", "980")


def input_text(value: str) -> None:
    adb("shell", "input", "text", value)


def screencap(name: str) -> None:
    device_path = f"/sdcard/{name}.png"
    adb("shell", "screencap", "-p", device_path)
    adb("pull", device_path, str(ROOT / f"{name}.png"), check=False)


def main() -> int:
    print("== waiting for welcome ==")
    wait_for_text("Get started", timeout=40)
    screencap("welcome")

    print("== tapping Get started ==")
    tap_text("Get started")

    print("== waiting for create PIN ==")
    wait_for_text("Create a PIN", timeout=20)
    screencap("create-pin")

    print("== entering first PIN ==")
    tap_center()
    time.sleep(1)
    input_text("1234")
    time.sleep(1)
    tap_text("Next")

    print("== waiting for confirm PIN ==")
    wait_for_text("Confirm your PIN", timeout=20)
    screencap("confirm-pin")

    print("== entering confirm PIN ==")
    tap_center()
    time.sleep(1)
    input_text("1234")
    time.sleep(1)
    tap_text("Set PIN")

    print("== waiting for post-PIN state ==")
    # We don't know if success lands on Identities or an error screen; just give it time.
    time.sleep(35)
    screencap("after-pin")
    dump_ui()

    print("== attempting unlock cycle if unlock screen appears ==")
    try:
        wait_for_text("Unlock wallet", timeout=5)
        screencap("unlock")
        tap_center()
        time.sleep(1)
        input_text("1234")
        time.sleep(1)
        tap_text("Unlock")
        time.sleep(20)
        screencap("after-unlock")
        dump_ui()
    except Exception:
        pass

    print("== flow complete ==")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"FLOW_ERROR: {exc}", file=sys.stderr)
        screencap("flow-error")
        raise
