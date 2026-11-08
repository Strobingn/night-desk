#!/usr/bin/env bash
# Hosted emulator only. Installs the exact 13.16 and 13.17 merge APKs.
set -euo pipefail
cd "${GITHUB_WORKSPACE:-/agent/repos/night-desk}"
mkdir -p shot-out/raw shot-out/pairs
adb root
adb wait-for-device
adb shell settings put system font_scale 1.0
adb shell settings put secure font_scale 1.0 || true
adb shell cmd uimode night yes || true
adb shell settings put global hide_error_dialogs 1 || true
adb shell settings put global heads_up_notifications_enabled 0 || true
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0

capture_one() {
  local version="$1"
  local apk="$2"
  adb uninstall com.dirk.nightdesk || true
  adb install -r "$apk"
  adb shell pm grant com.dirk.nightdesk android.permission.POST_NOTIFICATIONS || true
  local uid
  uid="$(adb shell stat -c %u /data/data/com.dirk.nightdesk | tr -d '\r')"
  adb shell iptables -D OUTPUT -m owner --uid-owner "$uid" -p tcp -j REJECT || true
  adb shell iptables -D OUTPUT -m owner --uid-owner "$uid" -d 10.0.2.2/32 -j ACCEPT || true
  adb shell iptables -I OUTPUT 1 -m owner --uid-owner "$uid" -p tcp -j REJECT
  adb shell iptables -I OUTPUT 1 -m owner --uid-owner "$uid" -d 10.0.2.2/32 -j ACCEPT
  python3 scripts/screenshot_audit.py shot-out/raw "$version"
}

APK16="$(find apks/1316 -name '*.apk' | head -n 1)"
APK17="$(find apks/1317 -name '*.apk' | head -n 1)"
test -n "$APK16"
test -n "$APK17"
set +e
capture_one 13.16 "$APK16"
code16=$?
capture_one 13.17 "$APK17"
code17=$?
set -e
python3 scripts/screenshot_audit.py --stitch shot-out/raw shot-out/pairs
python3 - << 'PY'
from pathlib import Path
from PIL import Image
bad = []
for path in sorted(Path("shot-out").rglob("*.png")):
    try:
        image = Image.open(path)
        image.load()
    except Exception as exc:
        bad.append(f"{path}: {exc}")
if bad:
    print("\n".join(bad))
    raise SystemExit(f"{len(bad)} screenshots are not readable PNGs")
print(f"readable pngs {len(list(Path('shot-out').rglob('*.png')))}")
PY
find shot-out -type f -printf '%p %s\n' | sort
test "$code16" = 0
test "$code17" = 0
test -s shot-out/pairs/home-top.png
test -s shot-out/pairs/home-position.png
test -s shot-out/pairs/tape.png
test -s shot-out/pairs/search-result.png
test -s shot-out/pairs/settings.png
test -s shot-out/pairs/pump.png
