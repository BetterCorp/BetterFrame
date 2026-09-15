#!/usr/bin/env bash
set -euo pipefail
android_dir="$(cd "$(dirname "$0")/.." && pwd)"
# Keep visual evidence even on failure; the test exit status still fails CI.
collect_screenshots() {
  mkdir -p "$android_dir/app/build/reports/kiosk-screenshots"
  adb pull /sdcard/Download/betterframe-kiosk-screenshots/. \
    "$android_dir/app/build/reports/kiosk-screenshots" || true
}
trap collect_screenshots EXIT
adb shell rm -rf /sdcard/Download/betterframe-kiosk-screenshots
cd "$android_dir"
./gradlew --no-daemon connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.notClass=cloud.betterportal.frame.ManagedKioskDeviceTest
