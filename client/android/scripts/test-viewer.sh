#!/usr/bin/env bash
set -euo pipefail
android_dir="$(cd "$(dirname "$0")/.." && pwd)"

# Collect screenshots before the upgrade suite uninstalls the debug application.
# Run both suites even if the first fails, and preserve either failure for CI.
presentation_status=0
bash "$android_dir/scripts/test-kiosk-presentation.sh" || presentation_status=$?
managed_status=0
bash "$android_dir/scripts/test-managed-kiosk.sh" || managed_status=$?
upgrade_status=0
bash "$android_dir/upgrade-test/run.sh" || upgrade_status=$?

if (( presentation_status != 0 )); then
  exit "$presentation_status"
fi
if (( managed_status != 0 )); then
  exit "$managed_status"
fi
exit "$upgrade_status"
