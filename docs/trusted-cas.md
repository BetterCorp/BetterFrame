# Trusted CA provisioning

Implementation plan

1. Add an administrator-only, tenant-scoped certificate library. Accept a single
   PEM/DER self-signed CA certificate, validate its signature and current validity,
   reject private keys/leaf certificates, and display SHA-256 fingerprints.
2. Assign up to 32 CAs to each kiosk. Include the sorted complete assignment in
   the authenticated, cached bundle and its version hash. Also deliver the complete
   desired set in heartbeat responses, independent of display/layout assignments. An empty assignment
   removes only certificates BetterFrame installed. Existing roots stay intact.
3. Apply and report the desired trust set on Linux, Windows and Android. Keep
   ownership journals before changing trust so interrupted installs can converge.
   Retain standard TLS chain, hostname and validity verification.
4. Show pending, applied, manual-action and error states on the certificate page.
   Exercise validation, authorization, tenant isolation, deterministic bundles,
   idempotent installation/removal, recovery and platform builds where available.

Platform behavior

- Linux: a root systemd service consumes a bounded request from the player, checks
  every certificate again with OpenSSL, maintains only its own CA files, and runs
  update-ca-certificates. A path unit permits requests from the unprivileged,
  NoNewPrivileges player without sudo. Trust affects the system. The player is
  restarted after a changed trust set, so WebKit discards existing TLS sessions.
  The persisted desired set is restored before the kiosk starts after an OS update.
- Windows: the elevated agent provisions the machine Root store, journals only
  roots it adds, and restarts the renderer after changes. Trust affects all users
  and applications on that machine. Unelevated agents report manual action.
- Android: device/profile owners install and remove user CAs through
  DevicePolicyManager. The app opts into user-root trust. Unmanaged devices need
  manual installation/removal through Android Settings; the admin page provides
  certificate downloads. No SSL-error proceed handler is used.

Provisioning uses an already authenticated BF connection. It cannot bootstrap
trust in the BF server itself: provision that server's root before enrollment.
Clients must reconnect to receive removals; offline cached assignments remain in
force. Browser trust extends to subresources and redirects, not just the page URL.
Back up the PostgreSQL database and client ownership state with normal fleet backups.

Heartbeats are authoritative for trust. Each client persists that assignment apart
from its content cache; a stale content bundle cannot reintroduce a removed root.
The bundle's trust list is only an offline/bootstrap fallback before the first
trust-aware heartbeat. Unassigning layouts does not prevent certificate removals.
