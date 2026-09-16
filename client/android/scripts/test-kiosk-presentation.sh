#!/usr/bin/env bash
set -euo pipefail
android_dir="$(cd "$(dirname "$0")/.." && pwd)"
immersive_confirmation=$(adb shell settings get secure immersive_mode_confirmations | tr -d '\r')
# Keep visual evidence even on failure; the test exit status still fails CI.
collect_screenshots() {
  local test_status=$?
  mkdir -p "$android_dir/app/build/reports/kiosk-screenshots"
  if (( test_status != 0 )); then
    adb logcat -d -t 3000 > "$android_dir/app/build/reports/kiosk-screenshots/test-failure-logcat.txt" 2>&1 || true
    adb shell dumpsys window > "$android_dir/app/build/reports/kiosk-screenshots/test-failure-windows.txt" 2>&1 || true
  fi
  adb pull /sdcard/Download/betterframe-kiosk-screenshots/. \
    "$android_dir/app/build/reports/kiosk-screenshots" || true
  if [[ "$immersive_confirmation" == null ]]; then
    adb shell settings delete secure immersive_mode_confirmations || true
  else
    adb shell settings put secure immersive_mode_confirmations "$immersive_confirmation" || true
  fi
}
trap collect_screenshots EXIT
# Like Android's own window-manager tests, acknowledge the first-use system
# tutorial so it cannot take focus from the app's menus and idle assertions.
adb shell settings put secure immersive_mode_confirmations confirmed
adb shell rm -rf /sdcard/Download/betterframe-kiosk-screenshots
cd "$android_dir"
./gradlew --no-daemon connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.notClass=cloud.betterportal.frame.ManagedKioskDeviceTest
