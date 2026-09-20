# BetterFrame Android display viewer

Experimental Android/Android TV client for assigned camera, webpage, HTML and
web signage layouts. Uses the canonical Rust client core through JNI, native
Media3 camera players, and Android System WebView. Administration remains in BF;
the app hosts no local API or device-management service.

Application ID and Kotlin namespace: `cloud.betterportal.frame`.
See [application identity](../../docs/application-identity.md) for domain
conventions and migration from the initial experimental Android package.

## Kiosk presentation

Startup and pairing use the full desktop BetterFrame wordmark on black, a large
pairing code, approval instructions, and small server/IP/firmware/device details.
Connection messages do not replace the pairing code. The screen adapts to TV,
landscape and portrait displays; no server form is shown during normal startup.

Assigned content fills the window. Open the small bottom-right kiosk menu by
touch or with the remote Menu key for layouts, assigned content actions, reload,
refresh and settings. Web, HTML and signage have no native header and accept touch,
remote and keyboard input immediately. Back restores expanded content; otherwise
it opens the menu. Camera connection/retry screens show only a spinner on black.
Empty displays/layouts retain the BF logo on black with assignment instructions.

Configured idle timeouts restore expanded content independently of network retries.
The selected layout's timeout overrides the display timeout; zero disables idle.
Sticky layouts retain their selection while collapsing expanded content. Touch,
remote input and web text editing renew inactivity. Idle also closes open kiosk
menus and Settings; input within those dialogs renews the same timer. Multiple
web tiles are identified by their current row and column in the content picker.
Settings contains server selection and confirmed enrollment reset. Changing the
server confirms a reset, clears saved enrollment/browser sessions, and connects
to the selected server. The application ID and signing key remain unchanged.

## Build

Requires JDK 17, Android SDK 35, NDK 27.2.12479018, and stable Rust. Linux and
macOS builds are supported by the native bridge script.

```sh
rustup target add armv7-linux-androideabi aarch64-linux-android x86_64-linux-android
sdkmanager 'platforms;android-36' 'build-tools;36.0.0' 'ndk;27.2.12479018'
cd client/android
./gradlew assembleDebug testDebugUnitTest lintDebug
```

Set `ANDROID_HOME` to the SDK installation or use local.properties with
`sdk.dir=...`. Gradle builds the Rust library for armeabi-v7a, arm64-v8a and x86_64;
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
2. The app automatically connects to `https://frame.betterportal.net` on first
   launch, discovers its regional server, and saves that origin for subsequent
   requests and launches. A saved custom server takes precedence. To change
   servers, reset enrollment and enter the other BF server origin. Remote
   servers require HTTPS; explicit local HTTP servers are supported for LAN deployments.
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

Connection failures before pairing now report that pairing could not start;
paired devices without a downloaded display report that no configuration is
saved yet. Only devices with a verified cached bundle report that they are
retaining saved display configuration. Retries happen automatically.

The public entrypoint can redirect to a regional BF origin, such as
`https://frame-eu.betterportal.net`. Before pairing, Android follows up to five
redirects using anonymous `GET /healthz` requests. Redirect destinations must
use HTTPS, have no credentials/query/fragment, and keep `/healthz` or `/` as the
path. Loops and cleartext redirects are rejected. The final origin is saved in
encrypted enrollment before any pairing requests; subsequent traffic and
restarts use it directly. Existing saved enrollments discover their origin once
when upgrading to this behavior. Direct local HTTP servers remain supported,
including older API listeners that return 404 for `/healthz`.

The resolved regional origin must serve `/api/**` and `/ws/**` directly. Android
continues refusing redirects for pairing and device requests, so those requests
cannot forward polling secrets or device credentials to another origin.

## Web rendering performance

The application window already enables Android hardware acceleration. WebView
uses its normal compositor (`LAYER_TYPE_NONE`); this does not disable GPU
rendering. Forcing every page into an additional hardware layer can allocate
large textures and increase memory pressure, especially with many visible tiles.
Geometry-only layout changes preserve existing browsers and camera decoders;
changed URLs, HTML, storage settings or actions still replace their tile.
Network retries replace the failed browser and return to the original assigned
page, so stale callbacks cannot cancel the next attempt's watchdog. Menu reloads
reuse a completed browser, but replace failed or still-loading browsers; renderer
crashes also recreate it. Persistent cookies and web storage are retained. A successful page recovery
cancels queued retries, and app-initiated reloads discard obsolete navigation
history after loading. Normal page navigation keeps its own history.
Hidden/replaced content is released before replacement content is allocated, and
all players/browsers are released when the screen turns off or the app stops.

WebView chooses web-video decoding based on its provider, the codec and device
capabilities. The native camera decoder policy cannot force third-party web
video into hardware decoding. Keep Android System WebView current; use device-
appropriate video resolution/frame rate and reduce simultaneous heavy pages if
needed. The 32-view ceiling does not guarantee smooth playback on every device.

See [Android hardware acceleration](https://developer.android.com/topic/performance/hardware-accel)
and [WebView rendering layers](https://developer.android.com/reference/android/webkit/WebView#setLayerType(int,%20android.graphics.Paint)).

## Sleep and wake

### Ordinary APKs and managed devices

Open the kiosk menu (bottom-right ⋮ or the remote Menu key) and select **Standby**.
The viewer releases cameras and WebViews, shows pure black and dims its window.
The screen remains on so the authenticated BF connection can receive **Wake**.
Touch, a remote key, mouse click/scroll or an accessibility click wakes the display;
the waking gesture is consumed so it cannot activate the restored content.
Bundle refreshes and layout commands update saved content without waking playback.

The display's **sleep timeout** now enters the same standby automatically after
inactivity; `0` disables it. It runs locally even while a network request is blocked.
The separate **idle timeout** still restores the assigned default layout.
A local or server wake restarts the inactivity period. Heartbeats report
`standby` or `awake`; ordinary standby does not stop synchronization.

Updated viewers advertise `android-standby-v1`. BetterFrame enables its existing
Standby/Wake controls only for these viewers and validates the assigned display.
Remote Wake also works after all layouts are removed, provided the display remains
assigned. Revoked or ambiguous assignments reject remote power commands.
BF waits for the Android app to acknowledge the change before reporting success;
a viewer still refreshing a reassignment rejects power until it knows the new display.
Session/revision metadata orders heartbeats against acknowledged power changes so
a delayed earlier report cannot restore stale state in BF. Local power changes
still report through HTTP when the WebSocket connection is unavailable.
Both the updated server and APK are needed for remote controls. Older viewer APKs
remain blocked from power commands. Other device-management commands stay unsupported.

Standby is software blanking: an LCD backlight may remain on even at minimum
brightness. Use the device power button for true screen-off. Actual screen-off
stops playback and networking; power-button wake/unlock resumes BF when its activity
is visible. BF cannot remotely wake itself through a connection Android has suspended.
It cannot bypass a secure lock screen, wake a fully powered-off TV or guarantee
background relaunch on an ordinary installation. Android activity-state restoration
preserves standby; a fresh launch without saved activity state starts awake.

### Dedicated managed kiosks

An existing EMM can allowlist `cloud.betterportal.frame` for lock task and launch
`cloud.betterportal.frame/.MainActivity`. BF enters lock task only when already
permitted by management; ordinary installs never invoke screen pinning automatically.
The device manager continues to control startup and lock-screen policy.

Alternatively, provision BF's optional device-owner receiver on a clean dedicated
Android device with no existing owner/accounts, following Android's provisioning
requirements. For development/deployment with authorized ADB access:

```sh
adb install betterframe-android.apk
adb shell dpm set-device-owner cloud.betterportal.frame/.KioskAdminReceiver
```

Then open **Power and kiosk → Enable managed kiosk**. This enables BF's Home alias,
makes it the persistent Home application and allowlists it for lock task. Android
launches Home after boot/unlock, and returning Home reuses the existing BF activity.
The Home alias is disabled by default on normal installations.

**Power and kiosk → Turn screen off (power button to wake)** uses the device-owner
lock API for genuine screen-off. Use the physical power/remote controls to wake;
unlock is still required if a secure screen lock is configured. Keep using BF's
soft Standby/Wake for remote control. Scheduled hardware wake/TV power via OEM,
HDMI-CEC or EMM is outside this APK and must be qualified on the target hardware.

**Disable managed kiosk** removes BF's Home/lock-task policy but retains device-owner
provisioning. It does not change other allowlisted packages or wipe enrollment.
The kiosk menu and Settings remain accessible; this mode supplies dedicated launch
and power behavior, not an administrator-PIN protection scheme.

CI checks ordinary standby/media release and input consumption, independent timeout
and network behavior, then provisions a disposable emulator to test device-owner
Home/lock-task, screen-off/wake and policy cleanup before the signed-upgrade tests.
The managed test script refuses non-CI and physical-device execution.

See [Android dedicated devices](https://developer.android.com/work/dpc/dedicated-devices),
[Home/kiosk provisioning](https://developer.android.com/work/dpc/dedicated-devices/cookbook),
[device-owner lock](https://developer.android.com/reference/android/app/admin/DevicePolicyManager#lockNow())
and [background activity restrictions](https://developer.android.com/guide/components/activities/background-starts).

## Initial limits

- Android 9/API 28 minimum; armeabi-v7a, arm64-v8a and x86_64. A working System WebView is
  required for web content. AbleSign storage initialization needs WebView's
  document-start script feature. Initial navigation displays a dark loading spinner;
  after the first page paint it becomes a compact, noninteractive loading note so
  the provider's own caching progress and controls remain visible. Documents that
  never paint retry after 90 seconds using network backoff. Visible pages are not
  restarted while caching; browser page completion cannot identify when a
  third-party player has finished downloading its media.
- Up to 32 visible camera streams and 32 web/HTML/signage cells, within the
  64-cell layout limit. Fullscreen expansion releases hidden media. Excess cells
  display a limit message and can be expanded individually. Tune camera count,
  substream resolution, frame rate and bitrate to the device and page workload;
  32 is the application ceiling, not a guaranteed hardware capacity. Hardware
  decoders are preferred; when initialization fails, Media3 can try remaining
  platform decoders, including software. Software fallback costs CPU and cannot
  guarantee 32 streams. Exhausted/unsupported decoders show a retry message with
  advice to reduce stream quality or camera count.
- RTSP H.264 over TCP. Known H.265 streams are rejected; untagged streams are
  attempted and may fail. Expanded cameras prefer main streams and fall back to
  substreams. Camera audio is muted.
- Web cells sharing an origin must have matching assigned browser-storage
  settings. The first visible configuration wins; a conflicting cell shows a
  session-configuration message and can be expanded individually. Compatible
  cells and independent origins can render together. Conflicting or unavailable
  pages do not consume the 32-view budget; later compatible cells fill those slots.
  Assigned storage is
  initialized only on its player origin. External top-level navigation/SSO,
  scripted smart-URL login and native JavaScript bridges are unsupported.
- Raw HTML uses a unique unprivileged synthetic origin. Self-contained markup
  and absolute asset URLs work; BF does not yet supply an Android local-asset
  package/base contract. Web cache is not guaranteed offline signage playback.
- BF dashboard cookies are separate from the kiosk API credential and limited
  to assigned dashboard pages. Dynamic FlowFuse Socket.IO is denied until the
  provider can authorize individual dashboard channels; ordinary external
  webpages and signage players use their own sessions.
- No PTZ/recording/operator console, inbound API, remote reboot/OS controls, or automatic
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

## Google Play

See [publishing setup](../../docs/android-play-publishing.md) and the [store kit](play/README.md) for AAB delivery, testing/production tracks, languages and listing assets.

### Camera failure diagnostics

Retained app diagnostics include the camera ID, primary/fallback selection, TCP
transport, retry count and whether a first frame was rendered. Playback errors
include the Media3 code and up to eight nested exception types with their first
stack location. Known network exception categories and exact RTSP method/status
messages (for example `DESCRIBE 401`) are retained. Arbitrary exception messages,
stream URLs and camera labels are omitted to avoid exposing credentials or server
response contents. Startup failures, stalled/ended streams, reconnect delays and
recovery after retry are also recorded. Retry entries describe the next stream.
These diagnostics identify failure categories; device logcat may still be needed
for failures whose details cannot safely be included in retained logs.
