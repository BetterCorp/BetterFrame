# BetterFrame Android display viewer

Experimental Android/Android TV client for assigned camera, webpage, HTML and
web signage layouts. Uses the canonical Rust client core through JNI, native
Media3 camera players, and Android System WebView. Administration remains in BF;
the app hosts no local API or device-management service.

Application ID and Kotlin namespace: `cloud.betterportal.frame`.
See [application identity](../../docs/application-identity.md) for domain
conventions and migration from the initial experimental Android package.

## Build

Requires JDK 17, Android SDK 35, NDK 27.2.12479018, and stable Rust. Linux and
macOS builds are supported by the native bridge script.

```sh
rustup target add aarch64-linux-android x86_64-linux-android
sdkmanager 'platforms;android-35' 'build-tools;35.0.0' 'ndk;27.2.12479018'
cd client/android
./gradlew assembleDebug testDebugUnitTest lintDebug
```

Set `ANDROID_HOME` to the SDK installation or use local.properties with
`sdk.dir=...`. Gradle builds the Rust library for both arm64-v8a and x86_64;
no desktop GStreamer/GTK dependencies are linked into the APK. Native libraries
use 16 KiB page alignment. Install `app/build/outputs/apk/debug/app-debug.apk`
with `adb install -r`. Release builds are minified. Local release builds are
unsigned unless signing inputs are configured; the release pipeline requires
the permanent production key. See [release signing](#release-signing-and-updates).

Run shared policy/credential tests independently:

```sh
cargo test --manifest-path client/Cargo.toml -p betterframe-client-core -p betterframe-android-bridge --locked
```

The Android workflow builds debug/release APKs and runs host policy tests,
Android unit tests, lint, and emulator smoke tests for JNI, enrollment UI,
Keystore storage and offline HTML rendering. APK artifacts are available on the workflow run.
Compilation does not qualify a device or signage provider for unattended use.

## Release signing and updates

The existing `release.yml` entrypoint calls `android-release.yml` on trusted
master/tag releases. It publishes `betterframe-android.apk` and public
`betterframe-android.json` metadata (application ID, version, signing-certificate
fingerprint and APK SHA-256). Before publication, `apksigner` verifies the APK,
and the verifier requires the sole signer to match the pinned certificate,
application ID `cloud.betterportal.frame`, and expected version.

Every production update must reuse this application ID and signing key. Install
with `adb install -r betterframe-android.apk`, or open the APK on the device and
approve Android's installer. An accepted in-place update retains app data and
Keystore access. Signing enables update compatibility; it does not implement
automatic download, unattended installation, or device-management permissions.
Debug APKs use a different key and cannot update a production installation.
Changing from the original experimental package requires a fresh installation.

`versionName` comes from the release version. `versionCode` is the single
`release.yml` run number plus repository variable `BF_ANDROID_VERSION_CODE_OFFSET`
(default `0`), validated in `1..2100000000`. A rerun keeps its original code.
Keep this entrypoint and counter stable; never reduce the offset. If migrating
workflows/repositories, increase the offset so the next code exceeds every
published code. All channels share this sequence. Compare version codes when
choosing updates: jobs for different refs can finish out of order. A channel
switch to a lower code requires a newly built release with a higher code.

### One-time key provisioning

Generate a key only for the first production release, using JDK 17 `keytool`:

```sh
bash scripts/gen-android-signing-key.sh /secure/path/betterframe-android-signing
```

The generator refuses to overwrite an existing nonempty directory. It creates a
3072-bit RSA key in `release.p12`, with alias `betterframe-release` and a 100-year
certificate. The directory has mode `0700`, files `0600`. Back up **all six
files** in 1Password: the keystore, store password, key password, alias, public
certificate, and certificate SHA-256. Keep an independent secure recovery copy.
Do not regenerate the key to fix a build or put signing material in Git.
GitHub secrets cannot be downloaded later as a recovery backup.

Configure these repository Actions secrets from that same saved key:

| Secret | Source |
| --- | --- |
| `BF_ANDROID_KEYSTORE_BASE64` | Base64 encoding of `release.p12` |
| `BF_ANDROID_KEYSTORE_PASSWORD` | Contents of `store-password.txt` |
| `BF_ANDROID_KEY_ALIAS` | Contents of `key-alias.txt` |
| `BF_ANDROID_KEY_PASSWORD` | Contents of `key-password.txt` |

Set repository variable `BF_ANDROID_CERT_SHA256` to the 64 hexadecimal characters
in `certificate-sha256.txt`. The keystore format is PKCS12. Firmware/RAUC/Git
signing keys serve different purposes and must not be substituted.

For a local signed build, securely supply `BF_ANDROID_KEYSTORE_PATH` and the
three password/alias variables above, plus `BF_ANDROID_VERSION_CODE`,
`BF_ANDROID_VERSION_NAME`, and `BF_ANDROID_REQUIRE_SIGNING=true`, then run
`./gradlew --no-daemon assembleRelease` from `client/android`. Partial signing
configuration is an error; required-signing mode also requires explicit versions.
`BF_ANDROID_KEYSTORE_TYPE` defaults to `PKCS12`. The release workflow exposes
credentials only to its build step and deletes the temporary keystore afterward.

PR CI uses disposable keys. It verifies signed release identity, rejects a
mismatched signer, and installs successive minified release APKs in an emulator
to check that private files, preferences, and an Android Keystore key survive.
It also checks Android rejects an update signed by a different key. This tests
Android update continuity; existing smoke tests cover actual pairing storage,
and real-device qualification remains necessary.

## Setup and operation

1. Open BetterFrame from the Android launcher or TV launcher.
2. Enter the BF server origin. Remote servers require HTTPS; explicit local
   HTTP servers are supported for existing LAN deployments.
3. Approve the displayed pairing code in BF and assign one enabled display.
4. Assign normal BF camera/web/HTML/AbleSign content. The server recognizes
   `android-viewer` and filters the bundle to the first enabled assigned display.
   Its heartbeat must confirm `android-viewer-v1` before the app fetches a bundle
   or opens its command socket. Upgrade older BF servers before using the app.
5. Tap/select a camera to expand it. Restore or Back returns to the layout.
   Web cells have separate page-interaction and assigned-action controls
   (Expand, Restore, or Switch layout) so page clicks remain usable.

Pairing identity and cached bundles are stored together atomically, encrypted
with an Android Keystore key, outside Android backup. Offline startup restores
previously profile-verified layout/HTML; older unverified caches are discarded.
Live cameras and remote websites still require their own
network paths. Failed authorization blanks content while preserving identity
for administrator recovery. Unpair clears local enrollment and browser sessions.

## Initial limits

- Android 9/API 28 minimum; arm64 and x86_64 only. A working System WebView is
  required for web content. AbleSign storage initialization needs WebView's
  document-start script feature.
- Four camera substreams, or two cameras plus one web/HTML/signage cell.
  Fullscreen expansion releases hidden media. Additional cells display a limit
  message and can be expanded individually. Actual capacity depends on hardware
  and page complexity; these ceilings are not a performance certification.
- RTSP H.264 over TCP. Known H.265 streams are rejected; untagged streams are
  attempted and may fail. Expanded cameras prefer main streams and fall back to
  substreams. Camera audio is muted.
- One active web cell bounds resource usage and prevents simultaneous AbleSign
  screen identities from overwriting shared browser storage. Assigned storage is
  initialized only on its player origin. External top-level navigation/SSO,
  scripted smart-URL login and native JavaScript bridges are unsupported.
- Raw HTML uses a unique unprivileged synthetic origin. Self-contained markup
  and absolute asset URLs work; BF does not yet supply an Android local-asset
  package/base contract. Web cache is not guaranteed offline signage playback.
- BF dashboard cookies are separate from the kiosk API credential and limited
  to assigned dashboard pages. Dynamic FlowFuse Socket.IO is denied until the
  provider can authorize individual dashboard channels; ordinary external
  webpages and signage players use their own sessions.
- No PTZ/recording/operator console, inbound API, power/OS controls, or automatic
  boot/locked kiosk deployment. Only bundle reload and assigned layout switching
  are accepted over the server WebSocket; HTTP polling also reconciles bundles.

## Real-device acceptance before promotion

Test representative TV and touch hardware with actual cameras and signage:
24-hour camera-only, mixed camera/web-video, and fullscreen signage runs; repeated
expand/restore; interrupted pairing; BF/camera network loss; process death;
sleep/resume; renderer crash; token expiry; image/video playlist rotation and
autoplay; D-pad page escape; and invalid/over-budget assignments. Record memory,
heat, frame drops, first-frame latency and recovery times. The app remains
experimental until these checks pass on named devices.
