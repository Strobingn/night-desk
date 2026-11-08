#!/usr/bin/env python3
"""Drive the exact 13.16 and 13.17 APKs and screencap every tab.

No mainnet. The desk is the local gate on 10.0.2.2:8791. The paper buy of GATE
is a local mock so Home is populated the same way on both builds. The APKs are
not modified and this script does not look for test tags.
"""
from __future__ import annotations

import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

PKG = "com.dirk.nightdesk"
ACTIVITY = "com.dirk.nightdesk/.MainActivity"
URL = "http://10.0.2.2:8791"
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "shot-raw")
VERSION = sys.argv[2] if len(sys.argv) > 2 else "unknown"
SCREEN = (1080, 2400)


def sh(*args: str, timeout: int = 30) -> str:
    proc = subprocess.run(args, capture_output=True, timeout=timeout)
    return (proc.stdout or b"").decode("utf-8", "replace") + (proc.stderr or b"").decode("utf-8", "replace")


def adb(*args: str, timeout: int = 30) -> str:
    return sh("adb", *args, timeout=timeout)


def read_screen() -> tuple[int, int]:
    raw = adb("shell", "wm", "size")
    match = re.search(r"(\d+)x(\d+)", raw)
    if not match:
        return SCREEN
    return int(match.group(1)), int(match.group(2))


def dump() -> str:
    adb("shell", "uiautomator", "dump", "/sdcard/uidump.xml", timeout=25)
    xml = adb("shell", "cat", "/sdcard/uidump.xml", timeout=15)
    if "<?xml" not in xml:
        time.sleep(0.6)
        adb("shell", "uiautomator", "dump", "/sdcard/uidump.xml", timeout=25)
        xml = adb("shell", "cat", "/sdcard/uidump.xml", timeout=15)
    return xml


def nodes(xml: str) -> list[ET.Element]:
    start = xml.find("<?xml")
    try:
        root = ET.fromstring(xml[start:] if start >= 0 else xml)
    except ET.ParseError:
        return []
    return list(root.iter("node"))


def bounds_of(node: ET.Element) -> tuple[int, int, int, int] | None:
    match = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.attrib.get("bounds") or "")
    if not match:
        return None
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def blob_of(node: ET.Element) -> str:
    return (node.attrib.get("text") or "") + "\n" + (node.attrib.get("content-desc") or "")


def focus_pkg() -> str:
    raw = adb("shell", "dumpsys", "window")
    match = re.search(r"mCurrentFocus=Window\{[^ ]* u0 ([^\s}/]+)", raw)
    if match:
        return match.group(1)
    match = re.search(r"mCurrentFocus=Window\{[^ ]+ ([^\s}/]+)", raw)
    return match.group(1) if match else ""


def on_screen(bounds: tuple[int, int, int, int], height: int | None = None) -> bool:
    _, screen_h = SCREEN if height is None else (SCREEN[0], height)
    top, bottom = bounds[1], bounds[3]
    return bottom > 80 and top < screen_h - 140 and bottom - top > 8


def matches(xml: str, text: str) -> list[tuple[int, int, int, int]]:
    found = []
    for node in nodes(xml):
        if text not in blob_of(node):
            continue
        bounds = bounds_of(node)
        if bounds and bounds[2] - bounds[0] > 2 and bounds[3] - bounds[1] > 2:
            found.append(bounds)
    return found


def find(xml: str, text: str) -> tuple[int, int, int, int] | None:
    hits = matches(xml, text)
    visible = [bounds for bounds in hits if on_screen(bounds)]
    return (visible or hits or [None])[0]


def shot(name: str) -> None:
    """Raw framebuffer. Never presses Back or restarts the app."""
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{VERSION}-{name}.png"
    data = subprocess.run(["adb", "exec-out", "screencap", "-p"], capture_output=True, timeout=20).stdout
    data = data.replace(b"\r\n", b"\n")
    path.write_bytes(data)
    print(f"shot {path} {len(data)}", flush=True)


def save_dump(name: str, xml: str | None = None) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    text = xml if xml is not None else dump()
    (OUT / f"{VERSION}-{name}.xml").write_text(text, encoding="utf-8")


def fail(message: str) -> None:
    print(message, flush=True)
    slug = re.sub(r"[^a-z0-9]+", "-", message.lower()).strip("-")[:48]
    try:
        shot(f"setup-failure-{slug}")
        save_dump(f"setup-failure-{slug}")
    except Exception as exc:  # noqa: BLE001
        print(f"failure capture failed: {exc}", flush=True)
    raise SystemExit(message)


def tap(bounds: tuple[int, int, int, int]) -> None:
    adb("shell", "input", "tap", str((bounds[0] + bounds[2]) // 2), str((bounds[1] + bounds[3]) // 2))
    time.sleep(0.5)


def swipe(x1: int, y1: int, x2: int, y2: int) -> None:
    adb("shell", "input", "swipe", str(x1), str(y1), str(x2), str(y2), "280")
    time.sleep(0.45)


def swipe_up() -> None:
    width, height = SCREEN
    swipe(width // 2, int(height * 0.72), width // 2, int(height * 0.38))


def swipe_down() -> None:
    width, height = SCREEN
    swipe(width // 2, int(height * 0.38), width // 2, int(height * 0.72))


def ime_open() -> bool:
    return "mInputShown=true" in adb("shell", "dumpsys", "input_method")


def hide_ime() -> None:
    if ime_open():
        adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(0.5)


def dismiss_anr(xml: str) -> str:
    if "isn't responding" not in xml and "isn’t responding" not in xml:
        return xml
    button = find(xml, "Wait")
    if button:
        tap(button)
        time.sleep(0.4)
    return dump()


def ensure_app() -> None:
    for _ in range(8):
        xml = dismiss_anr(dump())
        pkg = focus_pkg()
        if PKG in pkg and (find(xml, "Night") or find(xml, "Home")):
            return
        if pkg and PKG not in pkg:
            adb("shell", "input", "keyevent", "KEYCODE_BACK")
            time.sleep(0.4)
        adb("shell", "am", "start", "-n", ACTIVITY)
        time.sleep(1.2)
    fail(f"Night Desk was not in front. Focus was {focus_pkg() or 'unknown'}")


def open_tab(names: list[str]) -> None:
    _, height = SCREEN
    for _ in range(4):
        xml = dismiss_anr(dump())
        for name in names:
            for bounds in matches(xml, name):
                if bounds[1] > height * 0.75:
                    tap(bounds)
                    time.sleep(0.4)
                    return
        # Link is the 6th of 7 labels on both releases. Swipe the bar, then try a fixed tap.
        swipe(int(SCREEN[0] * 0.9), height - 80, int(SCREEN[0] * 0.1), height - 80)
    # Last resort: both releases use the same seven-tab order.
    index = {"Home": 0, "Tape": 1, "Search": 2, "Add coin": 2, "Add": 2, "Recap": 3, "Settings": 4, "Link": 5, "Pump": 6}
    slot = next((index[name] for name in names if name in index), None)
    if slot is None:
        fail(f"tab not found: {names}")
    x = int(SCREEN[0] * (slot + 0.5) / 7)
    adb("shell", "input", "tap", str(x), str(height - 90))
    time.sleep(0.6)
    xml = dump()
    if not any(find(xml, name) for name in names):
        fail(f"tab not found: {names}")


def wait_for(options: list[str], timeout: float = 25) -> tuple[str, tuple[int, int, int, int]] | None:
    end = time.time() + timeout
    while time.time() < end:
        xml = dismiss_anr(dump())
        for option in options:
            bounds = find(xml, option)
            if bounds and on_screen(bounds):
                return option, bounds
        time.sleep(0.7)
    return None


def scroll_to(options: list[str], swipes: int = 6) -> tuple[str, tuple[int, int, int, int]] | None:
    for attempt in range(swipes):
        xml = dismiss_anr(dump())
        for option in options:
            visible = [bounds for bounds in matches(xml, option) if on_screen(bounds)]
            if visible:
                return option, visible[0]
            below = [bounds for bounds in matches(xml, option) if bounds[1] >= SCREEN[1] - 140]
            if below:
                swipe_up()
                break
        else:
            if attempt % 2 == 0:
                swipe_up()
            else:
                swipe_down()
    return None


def clear_and_type(text: str) -> None:
    adb("shell", "input", "keycombination", "113", "29")
    time.sleep(0.15)
    for _ in range(40):
        adb("shell", "input", "keyevent", "KEYCODE_DEL")
    adb("shell", "cmd", "clipboard", "set-text", text)
    time.sleep(0.2)
    adb("shell", "input", "keycombination", "113", "50")
    time.sleep(0.4)


def connect() -> None:
    ensure_app()
    hide_ime()
    # Home before the desk is linked. This frame is the disconnected app, not the fixture.
    open_tab(["Home"])
    time.sleep(0.6)
    shot("home-top-disconnected")
    save_dump("home-top-disconnected")

    open_tab(["Link"])
    found = wait_for(["Override URL", "Desk link"], 20)
    if not found:
        fail("link screen did not open")
    time.sleep(2.2)  # the screen replaces the field from storage after the first frame
    hide_ime()
    shot("link-before-type")
    field = find(dump(), "Override URL")
    if not field:
        fail("override field missing")
    tap(field)
    time.sleep(0.3)
    clear_and_type(URL)
    hide_ime()
    typed = dump()
    if "10.0.2.2" not in typed:
        field = find(typed, "Override URL") or field
        tap(field)
        time.sleep(0.2)
        adb("shell", "input", "text", URL)
        time.sleep(0.4)
        hide_ime()
    shot("link-typed")

    held = scroll_to(["instead of the beacon", "Hold this URL"])
    if not held:
        fail("hold switch not found")
    row = held[1]
    xml = dump()
    switch = None
    for node in nodes(xml):
        if node.attrib.get("checkable") != "true":
            continue
        bounds = bounds_of(node)
        if not bounds:
            continue
        same_row = abs(((bounds[1] + bounds[3]) / 2) - ((row[1] + row[3]) / 2)) < 90
        if same_row:
            switch = bounds
            break
    tap(switch or (max(row[2] - 20, SCREEN[0] - 180), row[1], SCREEN[0] - 24, row[3]))
    time.sleep(0.4)
    saved = scroll_to(["Save and hold this URL"])
    if not saved:
        fail("save-and-hold button not found")
    tap(saved[1])
    if not wait_for(["10.0.2.2"], 40):
        fail("desk URL was not held")
    shot("link-held")


def paper_fill_gate() -> None:
    open_tab(["Tape"])
    found = scroll_to(["GATE"], swipes=4)
    if not found:
        found = wait_for(["GATE"], 70)
    if not found:
        fail("GATE never appeared")
    buy = None
    for _ in range(5):
        xml = dump()
        candidates = []
        for node in nodes(xml):
            text = blob_of(node)
            if "LIVE" in text or "Sell" in text:
                continue
            if "⚡" not in text and "Buy $" not in text:
                continue
            bounds = bounds_of(node)
            if bounds and on_screen(bounds) and bounds[2] - bounds[0] > 80:
                candidates.append(bounds)
        if candidates:
            buy = candidates[0]
            break
        swipe_up()
    if not buy:
        fail("paper buy button missing")
    tap(buy)
    if wait_for(["Dismiss"], 20):
        button = find(dump(), "Dismiss")
        if button:
            tap(button)


def capture() -> None:
    open_tab(["Home"])
    time.sleep(0.8)
    for _ in range(3):
        swipe_down()
    shot("home-top")
    scroll_to(["Sell 25%", "Sell now"])
    shot("home-position")
    scroll_to(["Take profit", "Orders"])
    shot("home-orders")
    take_profit = scroll_to(["▲ Take profit", "Take profit"])
    if take_profit:
        tap(take_profit[1])
        time.sleep(0.5)
        shot("dialog-take-profit")
        adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(0.3)
    stop = scroll_to(["▼ Stop"])
    if stop:
        tap(stop[1])
        time.sleep(0.5)
        shot("dialog-stop")
        adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(0.3)

    open_tab(["Tape"])
    time.sleep(0.6)
    shot("tape")

    open_tab(["Search", "Add coin"])
    time.sleep(0.5)
    shot("search-empty")
    field = wait_for(["Name, symbol, mint or link", "Ticker, name, mint or link"], 12)
    if not field:
        fail("search field missing")
    tap(field[1])
    time.sleep(0.3)
    clear_and_type("SEEK")
    hide_ime()
    if "SEEK" not in dump():
        tap(field[1])
        adb("shell", "input", "text", "SEEK")
        hide_ime()
    look = scroll_to(["Look up"])
    if not look:
        fail("look up button missing")
    tap(look[1])
    wait_for(["2HNb", "Seek Coin", "No Solana", "rate limited", "LOOKUP", "DexScreener"], 25)
    hide_ime()
    time.sleep(0.6)
    shot("search-result")
    swipe_up()
    shot("search-result-lower")

    open_tab(["Recap"])
    time.sleep(0.5)
    shot("recap")
    open_tab(["Settings"])
    time.sleep(0.5)
    shot("settings")
    swipe_up()
    shot("settings-lower")
    open_tab(["Link"])
    time.sleep(0.4)
    shot("link")
    open_tab(["Pump"])
    time.sleep(0.6)
    shot("pump")
    scroll_to(["Bonding curve", "Mint", "Watch"])
    shot("pump-curve")


def stitch(raw: Path, dest: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont

    dest.mkdir(parents=True, exist_ok=True)
    names = sorted({path.name.split("-", 1)[1] for path in raw.glob("*.png") if "-" in path.name})
    font = ImageFont.load_default()
    for name in names:
        left = raw / f"13.16-{name}"
        right = raw / f"13.17-{name}"
        if not left.exists() or not right.exists():
            print(f"missing pair {name}", flush=True)
            continue
        first = Image.open(left).convert("RGB")
        second = Image.open(right).convert("RGB")
        if first.width < 200 or second.width < 200:
            print(f"skip tiny capture {name}", flush=True)
            continue
        canvas = Image.new("RGB", (first.width + second.width + 24, max(first.height, second.height) + 72), (12, 12, 12))
        canvas.paste(first, (0, 72))
        canvas.paste(second, (first.width + 24, 72))
        draw = ImageDraw.Draw(canvas)
        label = name.replace(".png", "").replace("-", " ")
        draw.text((16, 12), f"13.16  {label}", fill=(255, 255, 255), font=font)
        draw.text((16, 36), "exact APK 80fe13b", fill=(180, 180, 180), font=font)
        draw.text((first.width + 40, 12), f"13.17  {label}", fill=(255, 255, 255), font=font)
        draw.text((first.width + 40, 36), "exact APK ed4c200", fill=(180, 180, 180), font=font)
        out = dest / name
        canvas.save(out)
        print(f"pair {out}", flush=True)


def main() -> None:
    global SCREEN
    OUT.mkdir(parents=True, exist_ok=True)
    SCREEN = read_screen()
    print(f"screen {SCREEN[0]}x{SCREEN[1]}", flush=True)
    version_name = "unknown"
    version_code = "unknown"
    for line in adb("shell", "dumpsys", "package", PKG).splitlines():
        if "versionName=" in line:
            version_name = line.strip().split("versionName=")[-1]
        if "versionCode=" in line:
            version_code = line.strip().split("versionCode=")[-1].split()[0]
    (OUT / f"{VERSION}-version.txt").write_text(f"{version_name} {version_code}\n", encoding="utf-8")
    print(f"installed {version_name} {version_code}", flush=True)
    if version_name != VERSION:
        fail(f"installed {version_name} but expected {VERSION}")
    try:
        connect()
        paper_fill_gate()
        capture()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        fail(f"capture crashed: {exc}")
    print("capture done", flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--stitch":
        stitch(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        main()
