# Kiosk diagnostic logging

Diagnostics upload automatically to the existing authenticated `POST /api/kiosk/logs`
endpoint and tenant-local `kiosk_logs` table. They are independent of Axiom and update
channel. **Logs** in the sidebar opens `/admin/logs` for the current tenant;
**Open log viewer** on a kiosk opens `/admin/kiosks/:id/diagnostics`. Both use the
same viewer with kiosk, severity, source, receipt-time and text/context filters.
Indexed cursor pagination keeps each page to 50–200 summary rows without a full
history count. Messages and JSON context load only when an entry is expanded;
copy/download, line wrapping and explicit refresh work without replacing open details.
Event and receipt timestamps remain separate; time-range inputs use UTC. Full images can
report the same app message through both app tracing and the OS journal.

- **Full Pi/x86 OS images:** `betterframe-log-upload.service` runs separately from the
  UI, using `betterframe-kiosk --upload-journal` without initializing GTK/GStreamer.
  It reads the system journal (syslog, kernel, compositor, services and app output),
  at info priority and above, including previous boots. Entries include boot ID,
  unit, process, PID, host and the original event time. Persistent journald storage
  lives on the shared data partition, so A/B OS updates preserve diagnostics.
- **Linux/Windows apps:** an app tracing layer sends BetterFrame info/warn/error
  messages. Windows agent and renderer have separate protected spools.
- **Android:** app lifecycle/status, synchronization/connection failures, camera
  playback errors, WebView renderer failures and uncaught exceptions. It collects
  app-owned diagnostics, not other apps' logcat or Android's system logs.

## Retention

`BF_KIOSK_LOG_RETENTION_HOURS` defaults to **24** in Docker. Native server installs
set `service-admin-http.config.kioskLogRetentionHours` (1–8760) in their BSB config.
Cleanup runs on startup and every five minutes, including inactive tenants. Age is
measured from server receipt time so incorrect kiosk clocks cannot evade cleanup.
There is no longer a silent 500-row cut-off. Deleting a kiosk still cascades to logs.
The server needs its admin service running for scheduled cleanup.

Local OS journals retain up to one day / 64 MiB, leave 128 MiB free, rate-limit noisy
services, and flush every five seconds. Tune `deploy/journald/betterframe.conf` for
image defaults. Increasing server retention does not increase the local offline window.
App spools retain up to 1,000 events and upload up to 100 every five seconds. Oldest
buffered app events are evicted when full. A sudden app/process/power failure can
lose events not yet flushed locally; this is why full images also collect the journal.
Android's uncaught-exception and Rust's panic handlers additionally attempt an
immediate protected write once a paired destination is known.

## Delivery and diagnostics

Uploads use the saved kiosk identity and original server; they do not initiate
pairing or follow HTTP redirects. Existing device encryption protects app spools
and the journal cursor. No bearer tokens are written into log envelopes. Multiline whitespace is preserved;
messages are capped at 16,384 UTF-16 units and flagged in context when truncated. Messages
scrub common credential forms and URLs; arbitrary Rust structured tracing fields
are deliberately not collected. This is best-effort redaction, not a guarantee
that third-party OS services never print a secret.

The journal cursor advances only after acknowledgment. Stable per-event IDs make
retries safe after lost HTTP responses, partial migrations, reboot or cursor replay.
A vacuumed cursor replays the retained 24-hour window within the current enrollment. Journal upload failures back
off to one minute and never reboot the device. The existing kiosk restart/reboot
policy is unchanged; this change provides evidence to diagnose its failures.

Deploy the server migration first, then updated apps and OS images. Existing OS
images need the new systemd units/journald configuration (an OS update or the Pi
setup script); a firmware-only update adds application logs but cannot install the
independent OS collector. Nothing in this change accesses or deploys to a kiosk.
