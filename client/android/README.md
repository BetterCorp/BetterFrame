# BetterFrame Android display viewer

Experimental Android/Android TV client for assigned camera, webpage, HTML and
web signage layouts. Uses the canonical Rust client core through JNI, native
Media3 camera players, and Android System WebView. Administration remains in BF;
the app hosts no local API or device-management service.

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
with `adb install -r`. Release builds are minified and unsigned; production
signing material must be provisioned outside the repository.

Run shared policy/credential tests independently:

```sh
cargo test --manifest-path client/Cargo.toml -p betterframe-client-core -p betterframe-android-bridge --locked
```

The Android workflow builds debug/release APKs and runs host policy tests,
Android unit tests, lint, and emulator smoke tests for JNI, enrollment UI,
Keystore storage and offline HTML rendering. APK artifacts are available on the workflow run.
Compilation does not qualify a device or signage provider for unattended use.

## Setup and operation

1. Open BetterFrame from the Android launcher or TV launcher.
2. Enter the BF server origin. Remote servers require HTTPS; explicit local
   HTTP servers are supported for existing LAN deployments.
3. Approve the displayed pairing code in BF and assign one enabled display.
4. Assign normal BF camera/web/HTML/AbleSign content. The server recognizes
   `android-viewer` and filters the bundle to the first enabled assigned display.
5. Tap/select a camera to expand it. Restore or Back returns to the layout.
   Web cells have separate Interact/Expand controls so page clicks remain usable.

Pairing identity and cached bundles are stored together atomically, encrypted
with an Android Keystore key, outside Android backup. Offline startup restores
cached layout/HTML; live cameras and remote websites still require their own
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
