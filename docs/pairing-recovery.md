# Pairing recovery rollout

Deploy the server and Node-RED manager/node package together, followed by kiosk
clients and ioBOX firmware. Existing kiosk keys remain usable. Kiosks opt into
secret-protected claims; older clients retain their original claim protocol.
Take a coordinated [PostgreSQL backup](backup-recovery.md) before deployment.

## What changes

- Kiosk confirmation locks the pairing session and commits the device, display,
  encryption keys, labels and claim together. Repeating the same confirmation
  returns the same device. A failed replacement preserves the previous keys.
- Confirmed kiosk credentials remain retrievable for 15 minutes after
  confirmation, even if the original code deadline passes. New clients persist
  the session secret before displaying the code and acknowledge only after
  saving the complete encrypted identity. Acknowledgment removes the delivered
  credentials from the server's session record.
- Network and response errors show retry status. A missing initial bundle or
  an HTTP 401 preserves the saved identity. Explicit device reset/unpair remains
  the way to discard credentials; a revoked device cannot fetch new content.
- Server migrations serialize across processes. Tenant creation commits its
  schema and registration together, including names containing hyphens. Startup
  repairs legacy registrations whose tenant schema was never created.
- Node-RED internal events require manager and tenant runtime credentials;
  public webhook paths cannot access them. One route dispatches to every matching
  trigger node. Standalone Node-RED deployments must configure the equivalent
  trusted forwarding/token arrangement before upgrading these nodes.
- Replaced WebSocket connections cannot delete the current connection or finish
  its requests. Missing heartbeats force reconnects. Requests rejected while a
  kiosk is offline are not queued for unexpected later execution.

## Device prerequisites

New managed images and the source installer install
`/etc/betterframe/managed-image` and a narrow polkit rule allowing `bfkiosk` to
set the timezone via timedated. Existing images need those deployment changes
as well as the new binary to report managed-image support. The service retains
`NoNewPrivileges`; timezone changes no longer invoke sudo from that service.

For ioBOX, configure verified public `BF_IOBOX_TLS_CA_PEM` and
`BF_IOBOX_OTA_PUBLIC_KEY_PEM` repository variables before the release build.
The second must match the server's ioBOX firmware signing key. Release builds
fail when the anchors are missing. See the [firmware guide](../iobox-firmware/README.md)
for provisioning, trust rotation and legacy enrollment recovery. Test firmware
from PR validation contains disposable test trust and must not be deployed.

New ioBOX enrollment binds a persisted random secret to the serial and permits
retrieval of the same credentials until authenticated acknowledgment. This
protects retries; it does not establish factory provenance on first enrollment.
Already-stranded legacy ioBOX credentials cannot safely be recovered by serial
alone: use the documented operator reset/re-enrollment procedure.

## Qualification before fleet rollout

PR validation builds/tests the server against PostgreSQL 18, the native Linux
and Windows clients, and both ioBOX firmware variants. The regression suite
injects malformed responses, failed database writes, concurrent confirmations,
replaced connections and signature tampering.

Qualify a small hardware group before expanding rollout: disconnect networking
at each pairing stage; reboot after confirmation and credential persistence;
test read-only/full device storage; restore connectivity after initial bundle
failure; exercise W5500 HTTPS and OTA; cycle camera streams and layouts; and
verify timezone application on an image with the polkit rule. Validate a complete
backup restoration in an isolated deployment. Automated checks cannot establish
power-loss behavior, TLS memory usage or media stability on physical devices.
