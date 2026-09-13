#!/usr/bin/env bash
# Build a framework-only test APK and exercise actual signed release replacements.
set -euo pipefail
test_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$test_dir/../../.." && pwd)
build_tools="${ANDROID_HOME:?}/build-tools/35.0.0"
android_jar="$ANDROID_HOME/platforms/android-35/android.jar"
upgrade_dir="${RUNNER_TEMP:?}/android-upgrade"
probe_dir="$upgrade_dir/probe"
mkdir -p "$probe_dir/classes" "$probe_dir/dex"
javac --release 8 -classpath "$android_jar" -d "$probe_dir/classes" "$test_dir/UpgradeProbe.java"
"$build_tools/d8" --lib "$android_jar" --min-api 28 --output "$probe_dir/dex" \
  "$probe_dir/classes/cloud/betterportal/frame/upgradetest/UpgradeProbe.class"
"$build_tools/aapt" package -f -M "$test_dir/AndroidManifest.xml" -I "$android_jar" -F "$probe_dir/unsigned.apk"
(cd "$probe_dir/dex" && "$build_tools/aapt" add "$probe_dir/unsigned.apk" classes.dex)
"$build_tools/zipalign" -f 4 "$probe_dir/unsigned.apk" "$probe_dir/aligned.apk"
"$build_tools/apksigner" sign --ks "${BF_ANDROID_KEYSTORE_PATH:?}" \
  --ks-key-alias "${BF_ANDROID_KEY_ALIAS:?}" --ks-pass env:BF_ANDROID_KEYSTORE_PASSWORD \
  --key-pass env:BF_ANDROID_KEY_PASSWORD --out "$probe_dir/probe.apk" "$probe_dir/aligned.apk"

# The existing smoke suite installs a debug-signed app with the same application ID.
# Remove it once before seeding; there must be no uninstall/clear between the two releases.
adb uninstall cloud.betterportal.frame >/dev/null 2>&1 || true
adb install "$upgrade_dir/base.apk"
adb install "$probe_dir/probe.apk"
probe() {
  local phase=$1 version=$2 output
  output=$(adb shell am instrument -w -r -e phase "$phase" -e version "$version" \
    cloud.betterportal.frame.upgradetest/cloud.betterportal.frame.upgradetest.UpgradeProbe)
  printf '%s\n' "$output"
  [[ "$output" == *"BF_UPGRADE_OK:$phase:$version"* && "$output" == *"INSTRUMENTATION_CODE: -1"* ]]
}
probe seed 1001

# A correctly formed update signed by a different key must be rejected by Android itself.
bash "$repo_dir/scripts/gen-android-signing-key.sh" "$probe_dir/foreign-key"
"$build_tools/apksigner" sign --ks "$probe_dir/foreign-key/release.p12" \
  --ks-key-alias "$(cat "$probe_dir/foreign-key/key-alias.txt")" \
  --ks-pass "file:$probe_dir/foreign-key/store-password.txt" \
  --key-pass "file:$probe_dir/foreign-key/key-password.txt" \
  --out "$probe_dir/wrong-signer.apk" "$upgrade_dir/update.apk"
if output=$(adb install -r "$probe_dir/wrong-signer.apk" 2>&1); then
  printf '%s\n' 'Android unexpectedly accepted a different signing key' >&2
  exit 1
fi
printf '%s\n' "$output"
[[ "$output" == *INSTALL_FAILED_UPDATE_INCOMPATIBLE* ]]
probe verify 1001

adb install -r "$upgrade_dir/update.apk"
probe verify 1002
