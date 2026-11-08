#!/usr/bin/env python3
"""Drive the exact 13.16 and 13.17 APKs on a hosted emulator and screencap every tab.

No mainnet. The desk is the local gate on 10.0.2.2:8791. Paper buy of GATE is a
local mock so Home is populated the same way on both builds.
"""
from __future__ import annotations

import json
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


def sh(*args: str, timeout: int = 30) -> str:
    proc = subprocess.run(args, capture_output=True, timeout=timeout)
    return (proc.stdout or b"").decode("utf-8", "replace") + (proc.stderr or b"").decode("utf-8", "replace")


def adb(*args: str, timeout: int = 30) -> str:
    return sh("adb", *args, timeout=timeout)


def dismiss_overlay() -> None:
    xml = dump()
    if "isn't responding" in xml or "isn’t responding" in xml:
        node = find(xml, "Wait")
        if node:
            tap(node)
            time.sleep(0.4)
    focus = adb("shell", "dumpsys", "window")
    if "com.android.settings" in focus or "permissioncontroller" in focus:
        adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(0.4)
        adb("shell", "am", "start", "-n", ACTIVITY)
        time.sleep(0.8)


def dump() -> str:
    dismiss_only_anr = False
    adb("shell", "uiautomator", "dump", "/sdcard/uidump.xml", timeout=20)
    xml = adb("shell", "cat", "/sdcard/uidump.xml", timeout=15)
    if "<?xml" not in xml:
        time.sleep(0.5)
        adb("shell", "uiautomator", "dump", "/sdcard/uidump.xml", timeout=20)
        xml = adb("shell", "cat", "/sdcard/uidump.xml", timeout=15)
    return xml


def bounds_of(node: ET.Element) -> tuple[int, int, int, int] | None:
    raw = node.attrib.get("bounds") or ""
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", raw)
    if not m:
        return None
    return tuple(int(x) for x in m.groups())  # type: ignore[return-value]


def nodes(xml: str) -> list[ET.Element]:
    try:
        root = ET.fromstring(xml[xml.find("<?xml") :] if "<?xml" in xml else xml)
    except ET.ParseError:
        return []
    return list(root.iter("node"))


def find(xml: str, text: str, exact: bool = False) -> tuple[int, int, int, int] | None:
    hits = []
    for node in nodes(xml):
        blob = (node.attrib.get("text") or "") + "\n" + (node.attrib.get("content-desc") or "")
        ok = blob == text or blob.startswith(text + "\n") or blob.endswith("\n" + text) if exact else text in blob
        if not ok:
            continue
        b = bounds_of(node)
        if b and b[2] - b[0] > 2 and b[3] - b[1] > 2:
            hits.append(b)
    if not hits:
        return None
    # Prefer a node that is actually on the 2400-tall screen.
    visible = [b for b in hits if 0 <= b[1] < 2300 and b[3] > 40]
    return (visible or hits)[0]


def tap(b: tuple[int, int, int, int]) -> None:
    x = (b[0] + b[2]) // 2
    y = (b[1] + b[3]) // 2
    adb("shell", "input", "tap", str(x), str(y))
    time.sleep(0.6)


def swipe_up() -> None:
    adb("shell", "input", "swipe", "540", "1700", "540", "700", "250")
    time.sleep(0.5)


def swipe_down() -> None:
    adb("shell", "input", "swipe", "540", "700", "540", "1700", "250")
    time.sleep(0.5)


def swipe_nav() -> None:
    adb("shell", "input", "swipe", "980", "2280", "120", "2280", "200")
    time.sleep(0.4)


def wait_for(options: list[str], timeout: float = 25, exact: bool = False) -> tuple[str, tuple[int, int, int, int]] | None:
    end = time.time() + timeout
    while time.time() < end:
        dismiss_overlay()
        xml = dump()
        for opt in options:
            b = find(xml, opt, exact=exact)
            if b:
                return opt, b
        time.sleep(0.8)
    return None


def scroll_to(options: list[str], swipes: int = 6) -> tuple[str, tuple[int, int, int, int]] | None:
    for _ in range(swipes):
        xml = dump()
        for opt in options:
            b = find(xml, opt)
            if b and b[1] < 2100:
                return opt, b
        swipe_up()
    return None


def shot(name: str) -> None:
    dismiss_overlay()
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{VERSION}-{name}.png"
    data = subprocess.run(["adb", "exec-out", "screencap", "-p"], capture_output=True, timeout=20).stdout
    # adb on Windows adds CR; GitHub's adb usually does not. Drop a stray CR before LF.
    data = data.replace(b"\r\n", b"\n")
    path.write_bytes(data)
    print(f"shot {path} {len(data)}", flush=True)


def open_tab(names: list[str]) -> None:
    for _ in range(4):
        xml = dump()
        for name in names:
            b = find(xml, name)
            if b and b[1] > 1800:
                tap(b)
                time.sleep(0.4)
                return
        swipe_nav()
    raise SystemExit(f"tab not found: {names}")


def ime_open() -> bool:
    return "mInputShown=true" in adb("shell", "dumpsys", "input_method")


def hide_ime() -> None:
    if ime_open():
        adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(0.4)


def clear_and_type(text: str) -> None:
    adb("shell", "input", "keycombination", "113", "29")  # CTRL+A
    time.sleep(0.1)
    for _ in range(8):
        adb("shell", "input", "keyevent", "KEYCODE_DEL")
    adb("shell", "cmd", "clipboard", "set-text", text)
    time.sleep(0.3)
    adb("shell", "input", "keycombination", "113", "50")  # CTRL+V
    time.sleep(0.5)


def connect() -> None:
    adb("shell", "am", "start", "-n", ACTIVITY)
    time.sleep(2)
    for _ in range(8):
        dismiss_overlay()
        xml = dump()
        if find(xml, "Night"):
            break
        adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(0.3)
        adb("shell", "am", "start", "-n", ACTIVITY)
        time.sleep(1)
    open_tab(["Link"])
    found = wait_for(["Override URL"], 20)
    if not found:
        raise SystemExit("link screen did not open")
    time.sleep(2.2)  # the screen reloads the saved URL after the first frame
    tap(found[1])
    time.sleep(0.4)
    clear_and_type(URL)
    held = scroll_to(["Hold this URL instead of the beacon"])
    if not held:
        raise SystemExit("hold switch not found")
    row = held[1]
    # The switch is the right-hand control on a 1080-wide phone.
    tap((900, row[1], 1040, row[3]))
    time.sleep(0.5)
    saved = scroll_to(["Save and hold this URL"])
    if not saved:
        # Toggle may have missed. Tap the row text itself, which is not the switch,
        # then look again. Fall back to the beacon button only if the hold label never appears.
        raise SystemExit("save-and-hold button not found")
    tap(saved[1])
    if not wait_for(["10.0.2.2"], 40):
        raise SystemExit("desk URL was not held")


def paper_fill_gate() -> None:
    open_tab(["Tape"])
    found = scroll_to(["GATE"], swipes=8)
    if not found:
        # The first connect waits out the blocked beacon.
        found = wait_for(["GATE"], 70)
        if found:
            found = (found[0], found[1])
    if not found:
        shot("tape-missing-gate")
        raise SystemExit("GATE never appeared")
    buy = None
    for _ in range(6):
        xml = dump()
        candidates = []
        for node in nodes(xml):
            blob = (node.attrib.get("text") or "") + (node.attrib.get("content-desc") or "")
            if "LIVE" in blob or "Sell" in blob or "Buy" not in blob:
                continue
            b = bounds_of(node)
            if b and b[2] - b[0] > 40:
                candidates.append(b)
        if candidates:
            buy = candidates[0]
            break
        swipe_up()
    if not buy:
        shot("tape-no-buy")
        raise SystemExit("paper buy button missing")
    tap(buy)
    if wait_for(["Dismiss", "paper"], 20):
        xml = dump()
        b = find(xml, "Dismiss")
        if b:
            tap(b)


def capture() -> None:
    # Top of Home: hero and header.
    open_tab(["Home"])
    time.sleep(1)
    for _ in range(3):
        swipe_down()
    shot("home-top")
    scroll_to(["Sell 25%", "Sell now"])
    shot("home-position")
    scroll_to(["Take profit", "ORDERS", "Orders"])
    shot("home-orders")
    tp = scroll_to(["Take profit"])
    if tp:
        tap(tp[1])
        time.sleep(0.6)
        shot("dialog-take-profit")
        adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(0.4)
    stop = scroll_to(["▼ Stop", "Stop"])
    if stop:
        tap(stop[1])
        time.sleep(0.6)
        shot("dialog-stop")
        adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(0.4)

    open_tab(["Tape"])
    time.sleep(0.8)
    shot("tape")

    open_tab(["Search", "Add coin", "Add"])
    time.sleep(0.6)
    shot("search-empty")
    field = wait_for(["Name, symbol, mint or link", "Ticker, name, mint or link"], 10)
    if field:
        tap(field[1])
        time.sleep(0.3)
        clear_and_type("SEEK")
        hide_ime()
        look = scroll_to(["Look up"])
        if look:
            tap(look[1])
            wait_for(["2HNb", "Seek Coin", "No Solana", "rate limited", "LOOKUP", "DexScreener"], 25)
            time.sleep(0.8)
            hide_ime()
    shot("search-result")
    swipe_up()
    shot("search-result-lower")

    open_tab(["Recap"])
    time.sleep(0.6)
    shot("recap")
    open_tab(["Settings"])
    time.sleep(0.6)
    shot("settings")
    swipe_up()
    shot("settings-lower")
    open_tab(["Link"])
    time.sleep(0.5)
    shot("link")
    open_tab(["Pump"])
    time.sleep(0.8)
    shot("pump")
    scroll_to(["Bonding curve", "Mint", "Watch"])
    shot("pump-curve")


def stitch(raw: Path, dest: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont

    dest.mkdir(parents=True, exist_ok=True)
    names = sorted({p.name.split("-", 1)[1] for p in raw.glob("*.png") if "-" in p.name})
    font = ImageFont.load_default()
    for name in names:
        left = raw / f"13.16-{name}"
        right = raw / f"13.17-{name}"
        if not left.exists() or not right.exists():
            print(f"missing pair {name}", flush=True)
            continue
        a = Image.open(left).convert("RGB")
        b = Image.open(right).convert("RGB")
        # Keep the phone pixels. Do not scale one build to hide a size difference.
        height = max(a.height, b.height) + 64
        canvas = Image.new("RGB", (a.width + b.width + 24, height), (12, 12, 12))
        canvas.paste(a, (0, 64))
        canvas.paste(b, (a.width + 24, 64))
        draw = ImageDraw.Draw(canvas)
        draw.text((16, 16), f"13.16  {name.replace('.png','')}  exact 80fe13b", fill=(255, 255, 255), font=font)
        draw.text((a.width + 40, 16), f"13.17  {name.replace('.png','')}  exact ed4c200", fill=(255, 255, 255), font=font)
        out = dest / name
        canvas.save(out)
        print(f"pair {out}", flush=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    ver = adb("shell", "dumpsys", "package", PKG)
    name = "unknown"
    code = "unknown"
    for line in ver.splitlines():
        if "versionName=" in line:
            name = line.strip().split("versionName=")[-1]
        if "versionCode=" in line:
            code = line.strip().split("versionCode=")[-1].split()[0]
    (OUT / f"{VERSION}-version.txt").write_text(f"{name} {code}\n", encoding="utf-8")
    print(f"installed {name} {code}", flush=True)
    connect()
    paper_fill_gate()
    capture()
    print("capture done", flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--stitch":
        stitch(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        main()
