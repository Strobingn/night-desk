#!/usr/bin/env bash
# Runs on the GitHub-hosted emulator runner, after the emulator is booted.
set -euo pipefail
cd "${GITHUB_WORKSPACE:-/agent/repos/night-desk}"
copy_logs() {
  mkdir -p "${GITHUB_WORKSPACE:-.}/gate-logs"
  cp /tmp/nd-gate/http.jsonl /tmp/nd-gate/swaps.jsonl /tmp/nd-gate/server.log "${GITHUB_WORKSPACE:-.}/gate-logs/" 2>/dev/null || true
}
trap copy_logs EXIT
for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:8791/api/health" >/dev/null && break
  sleep 2
done
curl -sf "http://127.0.0.1:8791/api/health" >/dev/null
cd android
chmod +x ./gradlew
./gradlew installDebug installDebugAndroidTest --stacktrace
adb root
adb wait-for-device
uid="$(adb shell stat -c %u /data/data/com.dirk.nightdesk | tr -d '\r')"
test -n "$uid"
adb shell iptables -I OUTPUT 1 -m owner --uid-owner "$uid" -p tcp -j REJECT
adb shell iptables -I OUTPUT 1 -m owner --uid-owner "$uid" -d 10.0.2.2/32 -j ACCEPT
adb shell pm grant com.dirk.nightdesk android.permission.POST_NOTIFICATIONS || true
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
# Pixel Launcher "isn't responding" is an emulator overlay. Hide those dialogs
# so they cannot cover Night Desk. The test still has to click the real controls.
adb shell settings put global hide_error_dialogs 1 || true
adb shell settings put secure anr_show_background 0 || true
mkdir -p "${GITHUB_WORKSPACE:-.}/gate-logs"
set +e
adb shell am instrument -w -r com.dirk.nightdesk.test/androidx.test.runner.AndroidJUnitRunner | tee "${GITHUB_WORKSPACE:-.}/gate-logs/instrument.txt"
set -e
adb pull /data/data/com.dirk.nightdesk/files/home-collapsed.png "${GITHUB_WORKSPACE:-.}/gate-logs/home-collapsed-13.24.png" || true
adb pull /data/data/com.dirk.nightdesk/files/home-expanded.png "${GITHUB_WORKSPACE:-.}/gate-logs/home-expanded-13.24.png" || true
adb pull /data/data/com.dirk.nightdesk/files/settings-onetap.png "${GITHUB_WORKSPACE:-.}/gate-logs/settings-onetap-13.24.png" || true
adb pull /data/data/com.dirk.nightdesk/files/search.png "${GITHUB_WORKSPACE:-.}/gate-logs/search-13.24.png" || true
adb pull /data/data/com.dirk.nightdesk/files/pump-watch.png "${GITHUB_WORKSPACE:-.}/gate-logs/pump-watch-13.24.png" || true
if grep -q "FAILURES!!!" "${GITHUB_WORKSPACE:-.}/gate-logs/instrument.txt"; then
  exit 1
fi
test -s "${GITHUB_WORKSPACE:-.}/gate-logs/home-collapsed-13.24.png"
test -s "${GITHUB_WORKSPACE:-.}/gate-logs/home-expanded-13.24.png"
test -s "${GITHUB_WORKSPACE:-.}/gate-logs/settings-onetap-13.24.png"
test -s "${GITHUB_WORKSPACE:-.}/gate-logs/search-13.24.png"
test -s "${GITHUB_WORKSPACE:-.}/gate-logs/pump-watch-13.24.png"
node "${GITHUB_WORKSPACE:-/agent/repos/night-desk}/scripts/apk-gate-assert.mjs" /tmp/nd-gate/http.jsonl /tmp/nd-gate/swaps.jsonl
