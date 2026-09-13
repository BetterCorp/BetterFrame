# BetterFrame Android viewer proposal

Status: implementation authorized on 2026-09-13. This document records the design; see `client/android/README.md` for implemented behavior, build instructions and current qualification limits.

Build a small Android display client for Android TV, tablets, touch panels, and phones. Pair it with BF, render assigned mixed layouts of cameras, webpages, HTML and signage, and support local touch/remote interactions such as camera expansion. Administration stays in BF.

**Scope and assumptions**

The user requested basic display/camera viewing, touch interactions, and a lean implementation without the control/management API. This proposal interprets that as no management service hosted by the Android app and no privileged device-control features. The app still needs outbound BF pairing, configuration, and health connections.

Confirmed scope correction on 2026-09-13: webpages, HTML and signage are required in the initial release alongside cameras. One logical display per app instance. Phones can use a compact assigned layout; external displays and independent multi-monitor output are deferred. Initial camera access is on the same LAN or an already configured VPN. BF server connectivity alone does not make private camera RTSP addresses remotely reachable.

| Include in first release | Defer |
| --- | --- |
| Existing BF pairing and persistent device identity | Local control/management HTTP API |
| Assigned default layout and a simple assigned-layout picker | Layout editor, camera administration, discovery |
| Camera, webpage, HTML and existing BF signage cells; labels, placeholders, spans and fit modes | Smart URL scripted login/navigation automation |
| Mixed camera/web layouts and fullscreen signage; existing BF dashboard/AbleSign web-player integration | New signage authoring, playlist-management or scheduling service |
| One to four visible live cameras on qualified hardware | Unqualified nine/sixteen-camera layouts |
| Touch expand, visible restore button, Android Back restore | PTZ, joystick, ONVIF actions/events, IOBOX/GPIO |
| TV remote navigation, Select expand, Back restore | Operator console, recording, playback/export |
| Local interactions while BF is unreachable | CEC, shell/debug access, OS/firmware updates |
| Cached configuration, independent stream recovery, small health reports | Embedded VPN, new cloud relay or transcoding service |

Default to muted video. Allow configured signage audio from at most one designated active cell; validate autoplay and audio focus with the actual signage player. Optional audio for the expanded camera can follow once required camera audio formats are validated. Never mix grid audio or let hidden pages keep playing audio.

**Interaction contract**

1. First launch shows BF server setup and the existing pairing code flow. Pairing approval and display assignment happen in BF.
2. Subsequent launches load the last valid layout immediately, then reconcile with BF. Cached configuration permits live camera playback only while the camera network remains reachable; it is not a recording cache.
3. Tapping a camera expands it. On TV, a clear focus outline moves spatially with the D-pad and Select expands the focused camera. No essential action requires a gesture or long press. This follows Android's [TV navigation guidance](https://developer.android.com/training/tv/get-started/navigation).
4. Expansion is a temporary local override, retaining the base layout and focused cell. Back or the visible restore action returns to that layout. At the root, Back follows normal Android navigation. Optional idle restore is configurable, disabled by default in the proposal.
5. Try the camera's compatible main stream when expanded. Keep the existing substream if the main stream is incompatible or fails. Restore substreams on returning to the grid.
6. A changed server layout becomes the new base layout. Preserve expansion only if the camera remains authorized in the new assignment; otherwise close it immediately. Back restores the current base layout, not a stale copy.
7. A failed camera affects its own tile. A visibly stale or unavailable indicator must replace any impression that a frozen frame is live. BF server loss gets a quiet status indication while reachable cameras continue playing.
8. Touch inside interactive web/HTML cells operates the page. A separate cell control expands/restores web content so links, forms and scrolling do not accidentally trigger expansion. Passive signage cells can disable page interaction. On TV, Select enters an interactive web cell and Back first leaves page-interaction mode, then restores an expanded cell, then follows root navigation. Keep an app-owned exit control reachable; arbitrary third-party pages may need touch, so qualify essential page controls for D-pad use.

Existing BF cell actions need an explicit supported subset: expand, restore, and switch to an assigned layout. Normalize touch/remote activation to those actions. Do not run arbitrary configured actions or forward unsupported controls into another subsystem.

**Architecture**

Use one Kotlin Android application with native camera video surfaces, Android System WebView for webpages/HTML/signage, and a small native UI. Start with Android Views and SurfaceView-backed players; use one shared action/state model for touch and TV navigation. Keep the app Activity responsible for lifecycle and presentation. Verify WebView availability, provider version and required features on each target TV/box before qualifying it.

Reuse `client/core` through a narrow Rust/JNI bridge for canonical bundle parsing, IDs, protocol rules, layout selection, camera stream selection, and state transitions. Pass control/state messages across the bridge, never decoded video frames. Package only the core and bridge, not the desktop executable or its GTK/WebKit/GStreamer dependencies.

The existing `docs/unified-client.md` establishes shared behavior with platform adapters. Actual source currently shares models and several pure helpers, but pairing and heartbeat execution still live in `client/src/platform/linux/server.rs`; do not assume a complete portable runtime already exists. Extract only the policy needed by Android into the shared core, with regression coverage. Android owns asynchronous HTTP/WebSocket transport, secure storage, lifecycle, Media3 players and WebView instances; shared logic determines actions and retry/state decisions. Avoid creating another handwritten canonical bundle model in Kotlin.

Suggested ownership:

```text
client/core/                  shared wire models and platform-free policy
client/android-bridge/        small Rust library exposing core to Android
client/android/               Gradle application, Kotlin UI, media/network/storage adapters
server/                       Android capability and assignment validation
```

Start the media prototype with Media3 ExoPlayer RTSP and hardware video decoding. Android recommends [SurfaceView for power efficiency and video rendering](https://developer.android.com/media/media3/ui/surface). Avoid frame copies to bitmaps, software compositing, and heavyweight animations over live video.

**Web, HTML and signage contract — first release**

- Render assigned URLs in WebView with the JavaScript, DOM storage, cookies and HTML5 media needed by qualified content. Render BF-provided HTML/CSS/JavaScript with an isolated local origin and declared asset base; do not give arbitrary HTML the authenticated BF origin. Android documents [loading local web content](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content). Test relative asset paths, fonts, video, resize and orientation.
- Reuse BF's actual bundle representation: `server/src/shared/bundle.ts` normalizes dashboards and AbleSign entities to `web` cells; dashboards use relative `/dash/...` URLs, while AbleSign adds `screenId` and potentially a sensitive `screenToken` through `local_storage`. Support this integration explicitly, including storage initialization before the player starts, token changes and persisted sessions. Preserve only required assigned-content settings in the filtered bundle.
- Scope signage storage initialization to the configured trusted top-level player origin; never inject tokens into redirected third-party pages or child frames. WebViews can share same-origin browser storage, so test multiple signage cells with distinct screen identities. Use supported isolated profiles where needed; otherwise report the device's one-identity-per-origin limit before assignment instead of overwriting another screen's session.
- Resolve BF-relative URLs through the shared core. Prove dashboard authentication across initial load, subresources, fetches and redirects; a header on the first navigation alone is not an end-to-end session solution. Use a restricted display session if needed, with server work included in the integration phase. Do not expose the kiosk API key to page JavaScript or external signage origins.
- Initial signage playback covers existing BF HTML/web content and its AbleSign integration, including image/video playlists and scheduling performed by that existing player. Validate the real player's login, autoplay, rotation and storage behavior; generic WebView support alone does not prove signage compatibility. Native image/video cell types or a new Android playlist engine are separate future work.
- Cache BF-provided HTML with its configuration. Self-contained HTML can render offline; external assets and dynamic pages remain network-dependent unless explicitly cached by a qualified signage player. Verify provider offline playback where available. Show unavailable content honestly; WebView cache is not a guaranteed offline signage package.
- Keep navigation within approved content origins and required identity-provider flows; handle popups and external schemes explicitly. Disable file/content access and native JavaScript bridges unless a narrowly scoped integration needs them. Clear content sessions and tokens on unpair or reassignment to another tenant.
- Handle web renderer termination by recreating affected views with bounded retries. Several WebViews may share a renderer; recover all affected cells while native camera playback continues where resources permit. Follow Android's [WebView termination handling](https://developer.android.com/develop/ui/views/layout/webapps/handle-termination), rather than assuming one isolated browser process per cell.

**Codec decision before product implementation**

Media3's [documented RTSP formats](https://developer.android.com/media/media3/exoplayer/rtsp) list H.264 video, AAC and AC3 audio, with UDP unicast and interleaved TCP transport. Do not infer H.265 RTSP support from an Android device's HEVC decoder. H.264 camera SDP must supply the initialization data required by the player.

The lean default is H.264 RTSP on qualified cameras, with TCP as the initial transport policy and UDP evaluated where needed. Before committing, sample the actual BF camera fleet, including main/substream codecs, credentials/authentication, SDP, resolution and frame rates. If H.265-only cameras are required, evaluate a constrained GStreamer Android media adapter as a separate spike, including APK size, hardware decode and long-run stability. Select one production playback engine from evidence. Do not ship two engines or add a cloud transcode service by default.

**Performance policy**

- Start with a tested ceiling of four visible substreams, typically 360p–720p at 10–15 fps where the camera provides them. These are requested stream profiles, not a promise that the app can reduce camera encoding cost itself.
- Qualify separate initial profiles: four camera substreams; two camera substreams plus one active web/HTML/signage cell; and fullscreen signage. These are starting test cases, not fixed product limits or a guarantee that arbitrary pages fit. Expand supported combinations from measurements. Count video inside WebView against the same device decoder budget as native camera streams.
- Expanded view uses one compatible main stream, initially targeting up to 1080p on baseline hardware. Higher resolutions require separate qualification.
- Treat decoder count, total pixels per second, bitrate, memory and heat as a combined budget. Android's [maximum concurrent codec instance count is only an upper-bound hint](https://developer.android.com/reference/android/media/MediaCodecInfo.CodecCapabilities#getMaxSupportedInstances()); actual capacity must be measured.
- Maintain players for visible streams only. During expansion release hidden players; reuse the selected player/surface where practical. Warm/preloaded desktop stream behavior must be disabled or capped by the Android resource policy. Returning to the grid may require reconnection.
- Bound player transitions so opening a new layout never temporarily doubles decoder demand. Unsupported layouts must be flagged in BF before assignment, with a clear device-side fallback for legacy assignments.
- When decoder allocation or sustained performance fails, step down stream quality or switch to a supported layout/one-camera view with a visible explanation. Avoid silent missing tiles and software-decoder fallback storms.
- Release camera playback when the app is backgrounded or the screen is off. Restore cleanly on resume. Keep the display awake only during active display use; do not implement background video playback for v1.
- Use a bounded WebView pool for visible cells. Preserve unchanged visible pages across bundle refreshes; stop hidden media and destroy hidden views when their short retention budget expires or memory is tight. WebView pause alone is not a guarantee that JavaScript/media stops; test the player and destroy hidden views if necessary. Avoid global timer controls while another page is visible. Account for renderer memory as well as the app heap, following Android's [WebView memory guidance](https://developer.android.com/develop/ui/views/layout/webapps/manage-webview-memory).
- Use bounded buffers and per-camera reconnect backoff with jitter. BF reconnection must not restart healthy camera players. Cap logs and health/event queues.

Provisional acceptance targets, to be calibrated on the chosen hardware: cached layout UI within two seconds of launch; first live frame within five seconds on a healthy LAN with short camera keyframe intervals; tap/Select acknowledgement within 100 ms; healthy feeds unaffected by one failed stream. Require 24-hour runs for camera-only, mixed camera/web and fullscreen signage profiles, with no app crashes, persistent stalls, unbounded memory growth, or sustained thermal degradation. Include actual image/video signage rotation and dashboard refreshes; measure page load, renderer recovery and hidden-page audio alongside glass-to-glass latency, frame drops, memory, temperature and reconnect times. These are targets, not measured results.

**BF integration and security**

Reuse `/api/pair/initiate`, `/api/pair/claim`, `/api/kiosk/bundle`, and `/api/kiosk/heartbeat`, plus the authenticated server WebSocket. Initially allow only bundle reload and assigned-layout switch commands. All other decoded commands return/report unsupported where the protocol permits; never acknowledge successful execution.

Advertise a versioned Android viewer capability profile at pairing/heartbeat: single display, supported cell/actions, input modes, codec/transport support, WebView availability/features and qualified mixed-content budget. This is proposed server work, not an existing complete capability-negotiation contract. Hide inapplicable BF controls and enforce command/assignment restrictions on the server as well as the client. Do not classify Android as a managed Linux image or a Windows client to obtain existing features.

Generate a capability-filtered bundle containing assigned layouts and only their authorized cameras/playback material. Current bundle generation also includes operator-related cameras/settings, ONVIF fields and GPIO; those should not be distributed to a viewer without a need for them. Continue parsing current wire versions safely during rollout, but reject unsupported content visibly. Test server/client rollout order and older-server behavior explicitly.

Store device identity and cached configuration atomically in app-private storage encrypted with a key protected by Android Keystore, excluding secrets from backup. Preserve identity through transient network or bundle failures. Redact camera credentials and authenticated URLs. BF authentication attaches only to the configured server origin, including redirect handling. Prefer HTTPS; an intentionally configured HTTP LAN server needs an explicit narrow transport policy. RTSP transport encryption is a separate camera/network concern.

**Delivery sequence and release gates**

1. **Hardware and playback spike:** choose representative TV/box and touch device; prove one/four streams, mixed camera/WebView rendering, BF HTML, authenticated dashboard and actual signage-player playback. Exercise expand/restore, main/substream changes, auth, network failure and decoding alongside signage video. Resolve H.265 and WebView-provider requirements here. Output a measured device/codec/content support matrix and production media-engine decision.
2. **Shared logic and BF contract:** core/bridge build, fixture compatibility, persistent pairing, secure cache, capability profile, filtered assignments, dashboard sessions, signage storage initialization and unsupported-command handling. Verify extraction leaves Linux/Windows behavior intact.
3. **Display MVP:** paired single-display mixed layouts, camera/web/HTML/signage cells, touch/remote interaction modes, expand/restore, assigned-layout switching and camera/web recovery. Validate against BF-generated bundles and real signage content rather than handcrafted examples alone.
4. **Hardening and pilot:** interrupted pairing, server outage/restart, camera loss, Wi-Fi changes, revocation, process death, orientation/activity recreation, sleep/resume, corrupt cache, bad assignments and decoder exhaustion. Add WebView renderer termination, expired web/signage sessions, redirects, multiple screen identities, media autoplay/audio ownership and missing web assets. Run all three 24-hour profiles and repeated interaction/lifecycle cycles on real devices. Use signed APKs for the pilot; decide store distribution after it.

A normal Android/TV installation should launch from its icon and obey system navigation. Guaranteed unattended boot, locked kiosk operation and silent updates require a separately qualified managed-device deployment. Android documents [dedicated-device management](https://developer.android.com/work/dpc/dedicated-devices); do not promise those facilities on arbitrary consumer TVs or build a device-management subsystem into this viewer.

**Open decisions**

- Representative webpages, HTML and signage playlists to qualify, and whether guaranteed offline signage playback is required beyond the existing player's cache behavior. Inclusion of these content types in v1 is confirmed.
- Actual TV/box/panel models and Android versions; choose minimum SDK and supported hardware after the spike, and current target SDK at implementation.
- Whether H.264 is available for every required camera, especially expanded view.
- Required mixed layouts and concurrent web/video workload; whether four live feeds is sufficient for camera-only layouts.
- Ordinary launch versus a requirement for unattended restart after power loss.

Implementation is tracked in the Android viewer PR. Performance targets above remain unmeasured until real-device qualification; `client/android/README.md` records the implemented subset and current limits.
