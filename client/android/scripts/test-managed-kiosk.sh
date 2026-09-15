#!/usr/bin/env bash
# Device-owner policy is destructive to device management: disposable CI emulator only.
set -euo pipefail
android_dir="$(cd "$(dirname "$0")/.." && pwd)"
[[ "${CI:-}" == true ]] || { echo 'Managed kiosk tests require CI=true.' >&2; exit 1; }
[[ "$(adb shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]] || {
  echo 'Refusing device-owner provisioning on a physical device.' >&2; exit 1;
}
report_dir="$android_dir/app/build/reports/managed-kiosk"
mkdir -p "$report_dir"
# connectedDebugAndroidTest has built these; install explicitly in case Gradle removed them.
adb install -r -t "$android_dir/app/build/outputs/apk/debug/app-debug.apk"
adb install -r -t "$android_dir/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
run_test() {
  local method=$1 output
  output=$(timeout 180s adb shell am instrument -w -r -e bfManagedCi true \
    -e class "cloud.betterportal.frame.ManagedKioskDeviceTest#$method" \
    cloud.betterportal.frame.test/androidx.test.runner.AndroidJUnitRunner)
  printf '%s\n' "$output" | tee "$report_dir/$method.txt"
  [[ "$output" == *"OK (1 test)"* && "$output" == *"INSTRUMENTATION_CODE: -1"* ]]
}
cleanup() {
  local status=$?
  trap - EXIT
  # The test has its own finally; this second instrumentation handles crashes/timeouts.
  if ! run_test clearOwnerAfterInterruptedRun; then
    echo 'Failed to clear the temporary emulator device owner.' >&2
    exit 1
  fi
  exit "$status"
}
trap cleanup EXIT
adb shell dpm set-device-owner cloud.betterportal.frame/.KioskAdminReceiver
run_test ownerPolicySleepsAndRestoresTheKiosk
