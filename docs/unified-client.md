# Unified BetterFrame client

Status: implemented source-tree cutover; Windows remains experimental pending runtime acceptance
Source of truth: the working Linux kiosk
Supersedes: the standalone Windows client implementation

## Decision

BetterFrame will have one client runtime with platform adapters, not separate
Linux and Windows application implementations.

Linux and Windows will still produce separate native artifacts because GTK,
WebKitGTK, Win32, WebView2, and their GStreamer sinks cannot be linked into one
portable binary. They must share behavior, wire models, state transitions, and
tests.

The current Linux kiosk defines expected behavior. The current Windows client
may be used as API/platform reference code, but no Windows behavior is assumed
correct until it passes the runtime acceptance tests in this document.

## Goals

- One implementation of pairing, authentication, server discovery, heartbeat,
  bundle fetch/cache, WebSocket commands, interactions, layout state, and
  offline startup.
- One canonical Rust model for every server payload.
- The same layout and stream-selection decisions on Linux and Windows.
- Native renderers and native host integration on each platform.
- Preserve Linux behavior throughout the migration.
- Make Windows runtime health testable; compilation and MSI creation alone do
  not count as a working client.

## Non-goals

- A single cross-platform executable artifact.
- Replacing GTK/WebKitGTK or Win32/WebView2 with Electron, Tauri, or a new UI
  framework.
- Making unsupported host controls appear available on either platform.
- Rewriting the server protocol during this migration.
- Preserving the internal structure of the current Windows monolith.

## Current problems

The deleted `windows-client/src/main.rs` was a platform-specific monolith which
duplicated and had already drifted from the Linux kiosk:

- bundle, display, layout, cell, camera, and stream models;
- pairing and credential state;
- bundle fetch and caching;
- heartbeat payloads;
- WebSocket parsing and command routing;
- active-layout selection;
- interaction reporting;
- camera credential decryption;
- local state persistence.

The Windows bundle model is already smaller than the Linux model and omits
fields used by current layouts and camera behavior. Its CI job proves that the
code compiles and an MSI can be assembled; it does not prove that the installed
application starts, pairs, renders, reconnects, or survives reboot.

## Target structure

Source ownership is:

```text
client/
  core/src/
    bundle.rs          canonical server wire models
    protocol.rs        shared wire responses and WebSocket endpoint construction
    commands.rs        typed server command decoding
    layout.rs          active/default layout and interaction logic
    state.rs           canonical persisted client state
  src/
    main.rs              thin target-selected bootstrap
    platform/linux/    GTK/WebKitGTK renderer, protected storage, host controls,
                       GPIO, app updates, and RAUC A/B OS updates
    platform/windows/
      renderer.rs      Win32 windows, WebView2 and d3d11videosink
      storage.rs       machine-scope DPAPI
      host.rs          monitor, audio, restart and reboot policy
```

The existing Linux executable name, install path, systemd unit, firmware
target, and RAUC behavior remain stable during migration. The Windows MSI may
keep its existing executable name. Packaging names do not define code
ownership.

## Core/platform boundary

The shared runtime communicates with the active platform through two typed
message streams. It does not import GTK, WRY, Win32, CEC, GPIO, RAUC, or DPAPI.

Core to platform commands:

- show startup status or pairing code;
- render a cached or current bundle;
- switch/revert a display layout;
- update cell geometry and visibility;
- open, warm, cool, restart, or close a camera stream;
- open, update, hide, or close web content;
- apply display power, audio, restart, or reboot commands;
- apply an available platform update;
- show update progress or a terminal/debug overlay.

Platform to core events:

- display inventory changed;
- pointer, keyboard, web, or GPIO interaction;
- stream started, stalled, failed, or recovered;
- renderer is healthy;
- host-control result;
- update progress, completion, or failure;
- shutdown requested.

Use the channel/event patterns already present in the Linux kiosk. Do not add a
general plugin system or dependency-injection framework.

## Ownership

### Shared core

The core owns:

- the canonical `KioskBundle` model currently in `kiosk/src/bundle.rs`;
- flexible ID deserialization and backward-compatible bundle normalization;
- pairing initiation, retryable claim polling, and credential state;
- public pre-pair update ordering;
- cached-first offline startup;
- authenticated bundle, heartbeat, event, and WebSocket protocol;
- unauthorized-key recovery;
- active/default layout state per display;
- cell action resolution and interaction payloads;
- camera stream selection;
- hot/warm/cooling/cold stream intent;
- reconnect, retry, and stall-recovery policy;
- update eligibility, scheduling, and failure guard state.

### Platform adapters

Platform code owns only operations which require an OS, UI toolkit, or native
runtime:

| Area | Linux | Windows |
|---|---|---|
| Windows | GTK4 | Win32 |
| Web content | WebKitGTK | WebView2 via WRY |
| Video sink | `gtk4paintablesink` | `d3d11videosink` |
| Secret protection | TPM/hardware-derived AES-GCM | machine-scope DPAPI |
| Display power | CEC, Wayland DPMS, X11 DPMS | supported Win32 monitor controls |
| Audio | PipeWire, then ALSA | Windows audio APIs |
| GPIO | `gpiod` | unsupported |
| OS update | RAUC A/B | unsupported until explicitly implemented |
| Process supervision | systemd/cage | Windows service and user session |

Unsupported operations return a typed `unsupported` result. They must not be
silently reported as successful.

## Startup contract

Both platforms follow the same state machine:

1. Initialize logging and platform diagnostics.
2. Open the platform state store.
3. Discover or load the saved server URL.
4. If unpaired, check an enabled public app/OS update before pairing.
5. If paired, load credentials and the cached bundle.
6. Render cached content immediately without waiting for the server.
7. Connect to the server and reconcile the current bundle.
8. Start heartbeat and WebSocket reconnect loops.
9. Apply live commands through the platform adapter.
10. Report renderer health before an update is considered successful.

Pairing, server downtime, or WebSocket loss must not blank already cached
content.

## Rendering contract

The core supplies a normalized display/layout/cell plan. The renderer must:

- create one fullscreen surface per selected display;
- preserve display identity across enumeration-order changes;
- render camera, web, HTML, empty, and placeholder cells;
- obey row/column spans and cell fit mode;
- preserve warm camera/web resources across layout changes;
- apply local layout switches without a server round trip;
- report clicks, double-clicks, holds, and web navigation consistently;
- expose stream start, frame, stall, restart, and error state;
- avoid showing raw camera credentials in logs.

Linux remains the reference for layout semantics and pool behavior. Windows
must implement the same contract with native sinks; it must not carry a second
layout engine.

## Security requirements

- Use the shared server wire models and authentication paths.
- Persist kiosk credentials and cached bundles only through the platform's
  protected store.
- Keep retryable pairing credentials encrypted on the server.
- Attach kiosk authentication only to the configured server origin.
- Keep camera passwords encrypted until the media adapter needs them.
- Redact credentials, tokens, and authenticated RTSP URLs from logs.
- Retain the current Windows policy gates for host-affecting controls.
- Never downgrade an unsupported privileged operation into an unguarded shell
  command.

## Migration plan

Each phase must leave the Linux release buildable and runnable. Avoid a
big-bang directory move.

### Phase 0: establish executable runtime checks

- Add a Windows `self-test` command which checks DPAPI round-trip, GStreamer
  initialization, required plugins, `d3d11videosink`, WebView2 availability,
  state-directory access, and display enumeration.
- Run `self-test` after MSI installation in CI.
- Preserve logs and return a non-zero exit code on failure.
- Record the current installed-client failure before replacing code.

Exit gate: Windows failure is reproducible and CI can detect the same class of
missing-runtime failure.

### Phase 1: canonical models and pure logic

- Move `kiosk/src/bundle.rs` into the shared core without changing its wire
  behavior.
- Move flexible IDs, bundle normalization, stream selection, URL-origin rules,
  and cell-action resolution into the core.
- Make Linux consume the moved code first.
- Replace the reduced Windows bundle types with the canonical models.
- Add fixture tests using a real server-generated multi-display bundle.

Exit gate: both targets compile against one bundle model; Linux bundle tests
and Windows model tests pass.

### Phase 2: state and server protocol

- Move pairing, claim polling, heartbeat payload construction, bundle fetch,
  event reporting, WebSocket command decoding, and reconnect policy into the
  core.
- Define the common persisted `ClientState` shape.
- Keep encryption and filesystem location in platform storage adapters.
- Ensure both platforms render cached content before network reconciliation.
- Delete the corresponding Windows implementations when each shared path is
  active.

Exit gate: Linux and Windows use the same protocol/runtime tests, including
pairing retry, unauthorized recovery, offline boot, and reconnect.

### Phase 3: common layout and stream orchestration

- Move active-layout selection, default reversion, interaction mapping, and
  hot/warm/cooling/cold intent into the core.
- Define the native media adapter around stream lifecycle and geometry, not
  around GStreamer implementation details.
- Keep decoder/source construction shared where it is genuinely identical;
  supply only the native video sink from the platform adapter.
- Port Windows to the Linux stream-pool behavior instead of preserving its
  current renderer logic.

Exit gate: the same bundle and command sequence produces the same render plan
and stream-state transitions on both platforms.

### Phase 4: native Windows renderer

- Implement the render contract with Win32, WebView2, and
  `d3d11videosink`.
- Support multiple displays and stable display matching.
- Implement camera, web, HTML, placeholder, and interaction behavior.
- Keep Windows host controls behind `windows-policy.json`.
- Do not implement Linux-only GPIO, CEC, or RAUC shims.

Exit gate: the Windows runtime acceptance suite passes on an interactive
Windows machine.

### Phase 5: packaging cutover and deletion

- Point Linux and Windows release jobs at the unified source tree.
- Keep separate target jobs, native dependencies, and artifacts.
- Install the MSI and execute `self-test` in CI.
- Run Linux image/RAUC builds unchanged.
- Delete `windows-client/src/main.rs` once no production behavior depends on
  it.
- Remove duplicate models, protocol code, and tests; do not keep a fallback
  implementation.

Exit gate: both release artifacts come from the unified client commit and the
old Windows implementation is gone.

## Verification matrix

### Shared automated tests

- current and legacy bundle deserialization;
- multi-display normalization and stable display matching;
- pairing pending, claimed, retry, expiry, and unauthorized recovery;
- cached-first startup with an unavailable server;
- reconnect after server restart;
- command decoding and invalid payload rejection;
- active/default layout selection;
- stream selection and hot/warm/cooling transitions;
- interaction payload equivalence;
- credential and authenticated-origin guards.

### Linux regression checks

- ARM64 and x86_64 release builds;
- Pi and x86 full-image builds;
- RAUC bundle build/sign/verify;
- pairing survives reboot;
- cached content starts while the server is down;
- camera, web, HTML, ONVIF, operator, audio, CEC/DPMS, and GPIO behavior;
- layout swap and stalled-stream recovery.

### Windows runtime acceptance

- MSI installs on a clean supported Windows host;
- `self-test` passes after installation;
- visible app starts in an interactive user session;
- pairing code appears and pairing persists across reboot;
- cached content renders with the server unavailable;
- H.264 and H.265 RTSP render through the expected decoder/sink;
- web and HTML cells render through WebView2;
- layout pushes and local interactions work;
- server restart reconnects without blanking content;
- multi-display selection and identity survive display reorder;
- app/service restart and uninstall are clean;
- logs contain actionable startup stages and no secrets.

## Release policy

- Do not label Windows supported merely because `cargo test` and MSI packaging
  pass.
- Keep Windows experimental until every Windows runtime acceptance item passes
  on a clean machine.
- Do not release a shared-core change if Linux image/runtime regression checks
  fail.
- During migration, a phase may ship only when it removes its replaced
  duplicate code or explicitly leaves deletion for the immediately following
  phase.

## Definition of done

- Pairing, protocol, state, layout, and stream policy exist only once.
- Linux and Windows adapters contain only native integration code.
- The standalone Windows monolith is deleted.
- Both artifacts are produced from one shared runtime revision.
- Linux retains current production behavior.
- Windows passes runtime acceptance on a clean installed machine, not only CI
  compilation.
