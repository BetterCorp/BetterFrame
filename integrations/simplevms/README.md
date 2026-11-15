# Native SimpleVMS integration

SimpleVMS owns cameras, names, profiles, recording policies and display-group membership. BetterFrame owns layouts authored by operators and the list of kiosks permitted to use each recorder. No camera/recording configuration is pushed from BetterFrame to SimpleVMS. MediaMTX is not part of this integration.

## Build and install

Build against **the same SimpleVMS source used by the target recorder**. The host must expose `PluginContext.CameraRegistry`, `EventBus`, `StreamTap` and the native H.264/H.265 format contracts. Browser media uses that source tree's Fmp4 muxer; recording export also requires `RecordingAccess` and `ffmpeg` on the recorder. The extended control-room host in the simpleVMS workspace supplies these APIs; this is not a claim of compatibility with an unmodified upstream release.

```sh
dotnet publish integrations/simplevms/BetterFrame/BetterFrame.csproj \
  -p:SimpleVmsSource=/absolute/path/to/simple-vms -c Release -o /tmp/bf-vms-plugin
dotnet test integrations/simplevms/BetterFrame.Tests/BetterFrame.Tests.csproj \
  -p:SimpleVmsSource=/absolute/path/to/simple-vms
```

Install the published output as a `BetterFrame` plugin directory using the recorder's normal plugin deployment process, then enable the plugin. The optional overlay Dockerfile copies a prepared `plugin/` directory into the existing recorder image. Keep the recorder's existing data volume and single writer. Do not replace or initialize its databases.

## Configure

1. In SimpleVMS **Settings → Plugins → BetterFrame**, note the persistent instance ID. Set its NVR name, integration token (at least 32 characters), viewer username and viewer password (at least 16 characters). The instance ID and durable delivery state live under the recorder's `betterframe/` data directory; preserve them on upgrades and backups.
2. In BetterFrame, open the owning kiosk's **SimpleVMS connection** page. Enable the connection and optional auto-sync, enter the instance ID and matching credentials, and save. The connection appears as an NVR with imported child cameras.
3. Copy the displayed HTTPS callback URL into the SimpleVMS plugin. Saving its settings triggers an initial snapshot. Camera lifecycle events and group changes subsequently trigger snapshots; healthy operation does not poll the catalog. Failed delivery retries the durable outbox. A newer complete snapshot can replace an unsent older snapshot without losing deletions.
4. Create named **Display groups** in the SimpleVMS plugin settings. Each camera's BetterFrame settings expose membership toggles. Renames retain stable group IDs. Groups do not change recording policies. Ungrouped cameras are imported too, for custom BF layouts.
5. To add linked kiosks, configure a media address reachable from those kiosks, select them in BF and save. An external address can be a property LAN address. The owning kiosk uses its local address; linked kiosks use the external address. Generated layouts automatically attach to their displays; other kiosks cannot be assigned those layouts.

The RTSP listener defaults to `127.0.0.1:8554` and supports H.264/H.265 over interleaved TCP. Configure a private bind address for remote kiosks. For RTSPS, configure the certificate/key PEM paths and use `rtsps://` in BF. The browser media listener defaults to `http://127.0.0.1:8555`. Remote browser media requires HTTPS, using the configured certificate or a private HTTPS reverse proxy. Kiosks must trust the issuer; certificate verification remains enabled.

Managed images allow TCP 8554 and 8555 only from private/link-local IPv4 and IPv6 networks. When changing native listener or reverse-proxy ports, update `/etc/nftables.conf` to allow those ports for the same trusted source networks, then reload it with `sudo nft -f /etc/nftables.conf`. Binding a listener and configuring its external BF address do not change the firewall automatically.

Each owning kiosk can use its own localhost recorder address; SimpleVMS identity is scoped by instance, not by that local endpoint. To correct an instance ID or disconnect a recorder, use **Remove SimpleVMS connection** on its kiosk connection page. This atomically removes BF's imported NVR/cameras/generated layouts and clears references while preserving custom layouts. Deleting the owning kiosk performs the same cleanup. Neither operation deletes native cameras, recording policies or recorder history.

Native camera labels are retained where unique in BF. Duplicate labels are qualified by recorder name, with an external-reference suffix only when still ambiguous. Renames and name swaps retain camera IDs and layout references.

When the recorder uses the ControlRoom policy plugin, configure its service URL/key in the BetterFrame plugin. Missing policy configuration on a recorder with an existing ControlRoom policy database fails closed. Incident-only `alarm_review` cameras are excluded from ordinary exports. This integration does not issue incident grants or change incident/evidence policy.

## Synchronization and access

- Tenant-local mappings use instance/camera/group external IDs. Camera and group renames preserve BF IDs and assignments. No upstream camera address or password enters the catalog or BF bundle.
- Each snapshot is validated and applied in one transaction, serialized per recorder. Duplicate/older revisions are acknowledged without applying them. A network failure never implies deletion. Snapshot requests have a 4 MiB limit.
- Imported NVRs/cameras and generated layouts are read-only in BF; repository guards also reject direct mutation requests. An empty/deleted group removes its generated layout and clears default-layout references. Camera deletion uses the existing cleanup for custom layouts and leaves those layouts intact.
- The kiosk catalog includes imported cameras before layout assignment. The NVR/camera/layout pages show owning and linked kiosks. Source presence is separate from successful camera playback: no camera-health claim is inferred from a catalog entry.
- BF distributes separate derived reader credentials per kiosk and camera. The plugin checks the kiosk's current owner/link authorization with BF at connection time and during streaming (approximately every ten seconds). Linked Android viewers retain their assigned-camera scope; ungrouped cameras remain available to native desktop kiosks for custom layouts. Disabling a source or removing a link withdraws access as well as generated assignments while BF is reachable. These checks are not camera-catalog polling.
- A private, durable cache retains the last known reader grants across recorder restarts and BF outages. Catalog acknowledgements seed authorized scopes, and successful reader checks update individual grants/denials. Previously authorized cameras remain playable while BF is unavailable; unknown readers remain denied. Explicit denials are retained. BF changes made during an outage take effect once connectivity returns. Camera policy checks remain local to SimpleVMS/ControlRoom.
- Each RTSP viewer owns a native StreamTap subscription, disposed on teardown/disconnect. Slow writes time out. Recording and other native consumers retain their own demand. Browser live preview remuxes native frames to fMP4 without transcoding. Recording export remuxes up to ten minutes of native segments, reports missing coverage, limits temporary data, and cleans up on cancellation.

## Migration and validation

The old BF camera recording JSON editor, MediaMTX recording synchronization, WebRTC gateway and bundled gateway installation are removed. The standalone installer retires an existing gateway service after the new app confirms healthy startup, while retaining its recordings and configuration. Until then, the legacy service stays available for binary rollback, including deferred desktop startup. For a deferred installation, rerun setup after the app starts successfully to retire that service; native BF does not use it. Existing MediaMTX files are **not** converted into native SimpleVMS history. Before running that migration on a recorder, retain/export old history and qualify the native recording/playback path. Do not claim historical cutover from a successful catalog sync.

Run the server suite with `BF_TEST_PG_URL` set to a disposable PostgreSQL administrator connection; tests create and remove isolated databases. Native plugin tests cover catalog generation, grouping controls, durable delivery/retries, lack of healthy catalog polling, RTP fragmentation, authentication and subscription cleanup. The regular client CI compiles the Rust changes. Physical-kiosk acceptance still requires actual H.264/H.265 playback, hot/warm/cold transitions, reconnects and profile changes, continued recording during viewer changes, linked-kiosk reachability and certificate trust, and browser playback/export against native recordings.
