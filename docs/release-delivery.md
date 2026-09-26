# BetterFrame release delivery

## Requirement

Devices obtain BetterFrame update metadata and artifacts from the configured BF origin or BF-managed origin pool. Customer firewalls must not need GitHub/CDN addresses for updates. Previously published releases remain available during an upstream GitHub outage. Update delivery must continue when kiosk enrollment authentication fails, while honoring locally saved windows, channels, and pins. Authenticated administrative pushes may bypass the maintenance window.

## Current implementation

Linux app, Linux RAUC OS, and ioBOX OTA already serve stored bytes from BF. Firmware imports upload signed bytes directly. OS imports currently ask BF to fetch a release URL once and store its content; device downloads do not proxy or redirect to that upstream. Linux API clients reject redirects, and ioBOX verifies the configured HTTPS origin.

Remaining gaps are Linux installer downloads (including MediaMTX), OS release ingestion tied to GitHub download URLs, and a unified catalog across all artifact types and Android APK installers. Windows now has a native independent updater service and direct signed-MSI publication to BF; see [Windows updates](windows-updates.md). Android release installs are manual or Google Play; ordinary installations cannot silently replace the package without platform authorization.

## Delivery service

Extend the existing BF artifact storage into one release catalog and delivery layer rather than an on-demand GitHub proxy:

1. A publisher uploads immutable artifact bytes and metadata to BF directly. GitHub Actions can be one publisher; the upload protocol must also work from another trusted builder or an operator's machine.
2. BF verifies the artifact digest and publisher signature before making the release discoverable. Interrupted uploads are private staging files. Publication is atomic and idempotent; an existing version/target/digest cannot be silently overwritten.
3. Publish per-platform manifests for Linux binaries, RAUC bundles, ioBOX images, Windows MSIs, Android APKs, bootstrap installers, and required bundled release dependencies. Keep signing identity, architecture/compatibility, size, digest, version, channel, and supported installation mechanism explicit.
4. Serve manifests and blobs from BF. Do not redirect customer devices to GitHub or an external object-store hostname. Use internal storage replication or an internal reverse proxy behind the BF endpoint. All advertised origins must belong to the operator's documented allowlist.
5. Separate device-specific rollout commands from public recovery discovery. Healthy fleet downloads use their authenticated routes. Public recovery downloads use the saved channel/pin, with retry deferral and jitter that never marks a deferred download as an installation failure.
6. Persist rollout policy locally and retain existing signature, upgrade-only, platform eligibility, and rollback checks. BF stages/publishes the release and notifies clients; clients choose the installation time unless an authenticated explicit push overrides the window.

## Availability and rollout

Replicate both immutable blobs and catalog metadata across the BF serving pool before announcing a release. A manifest must never select an artifact absent from that serving origin. Keep prior releases for rollback/recovery and expose availability separately from build success. Missing artifacts produce retryable delivery errors, not an upstream download/redirect on the device's critical path.

Deploy the BF publication/delivery API first, import the current signed releases, verify downloads with GitHub access blocked, then update installers and clients. Add Windows/Android installation mechanisms explicitly as a separate platform capability; serving a signed MSI/APK is not equivalent to unattended installation. BF server deployment itself is a separate scope from device release delivery and may require its container images, source bundles, and dependencies to be mirrored too.
