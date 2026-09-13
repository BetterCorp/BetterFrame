#!/usr/bin/env bash
set -euo pipefail
android_dir="$(cd "$(dirname "$0")/.." && pwd)"
# Keep visual evidence even on failure; the test exit status still fails CI.
collect_screenshots() {
  mkdir -p "$android_dir/app/build/reports/kiosk-screenshots"
  adb pull /sdcard/Android/data/cloud.betterportal.frame/files/screenshots/. \
    "$android_dir/app/build/reports/kiosk-screenshots" || true
}
trap collect_screenshots EXIT
cd "$android_dir"
./gradlew --no-daemon connectedDebugAndroidTest
