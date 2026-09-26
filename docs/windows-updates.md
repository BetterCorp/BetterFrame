# Windows installation, updates and recovery

The MSI installs an automatic **BetterFrameUpdater** LocalSystem service, independent
of the signed-in desktop agent. The service starts at boot and polls BF every two
minutes. The desktop still starts at sign-in; the service can update an installation
when the desktop is broken, stopped, unpaired or has invalid credentials.

## Publication and trust

Windows release builds embed the existing vendor Ed25519 public key in the updater.
CI signs the completed MSI and uploads it directly to the authenticated BF firmware
import endpoint as target `windows-x64`. The server verifies the signature and stores
immutable, digest-addressed bytes before registering the release. BF publication is
required before the Windows asset is advertised on GitHub. GitHub remains a build
and optional distribution source, never a device download dependency.

The service checks `/api/kiosk/firmware/check` and downloads from the corresponding
BF artifact endpoint. No HTTP redirects are followed. Download metadata cannot
select another origin. Before executing an MSI, the updater verifies bounded size,
SHA-256 and the embedded vendor signature, then checks the signed MSI's UpgradeCode,
`BF_UPDATE_TARGET` and `BF_RELEASE_VERSION`. A signature alone is insufficient to
install a different product, platform, or release. Forward updates must increase
the semantic version.

## Saved policy and authentication recovery

Authenticated checks return the schedule, server IANA timezone, channel and pin even
when already up to date. The service persists them in its own protected storage;
it does not depend on desktop heartbeats. Missing or corrupt policy never opens a
window. DST-aware evaluation uses the saved timezone.

Rejected, unavailable or malformed authenticated checks fall back to
`/api/firmware/public/check` on the same BF origin, using the saved channel and pin.
A valid up-to-date response is authoritative. Artifact downloads first use the
normal authenticated route, then the public route if control authentication fails.
HTTP 429 uses Retry-After plus jitter without consuming an installation attempt.
Previously saved identity/origin remains available if the enrollment file cannot
be read. Demo mode disables updates.

An explicit admin push is recorded on BF for the selected version and exact current
policy, expires after 30 minutes, and is returned only by authenticated checks.
It can bypass the time window. Public responses cannot authorize that override.
A changed policy invalidates the push. Desktop cancellation records suspend cached
recovery until the service receives replacement policy; cancellation acknowledgments
are persisted without deleting potentially newer cancellation records. Selection
and the maintenance window are checked again after downloads.

## Installation and rollback

Before updating, the service fetches and verifies the full installer for the
currently installed version. If BF cannot supply it, the update is deferred;
Windows Installer's stripped LocalPackage cache is not used as a rollback source.
Retain previously published Windows releases on BF.

The service stages installers, attempt history and an atomic recovery journal in
`<installation directory>\updates`, restricted to SYSTEM and administrators. A
standalone copy of the updater handles installation so MSI can replace the service
itself. It stops only processes whose executable path matches the installed client,
installs silently without rebooting, and restarts the client in its users' desktop
sessions with their existing Windows tokens.

The new package must pass an installation probe. A painted native display window
then records local health, including its build version and timestamp. This does not
require pairing or a working network; the renderer starts before server discovery.
A candidate that does not confirm within five minutes of an active desktop session
is rolled back to the retained verified MSI. With no signed-in session, display
confirmation waits for sign-in. A surviving journal lets the service recover an
interrupted installation or resume health evaluation after reboot. MSI transaction
rollback also protects failed package installations.

Failed versions are limited to three installation attempts, at least 30 minutes
apart. A newer version or a new explicit admin push resets that version's retry
budget. The service is restarted after installer failure and rollback, and SCM
restarts it after service crashes. A failure that prevents Windows itself or both
retained updater/installer copies from running still requires machine recovery.

## First deployment

Deploy the BF server migration and import-endpoint proxy limit before publishing
Windows installers. Install the first updater-enabled MSI once using an administrator
account; older Windows builds cannot acquire this service automatically. Let it
receive one valid authenticated policy. Subsequent recovery can then operate without
working enrollment. The vendor signing key and BF import URL/API key must be present
in the release environment; an unsigned build cannot auto-install updates.

Do not remove the current installed release from BF until devices have moved on.
Use a dedicated Windows kiosk account. Uninstall removes the service and sign-in
entry; protected recovery installers/logs are retained in the installation's `updates`
directory for diagnosis and can be removed by an administrator after uninstall.

## Validation

Updater tests cover signature/hash/size rejection, origin restrictions, no redirects,
authentication recovery, saved pins, DST windows, rate-limit deferral and interrupted
downloads. Native Windows CI runs the real SYSTEM service against a local BF fixture:
it saves policy, loses enrollment and authentication, installs a signed upgrade, then
rejects a broken candidate and restores the previously working MSI and client. It
also restarts with an unfinished transaction journal and a stopped desktop to verify
recovery before any further update checks.
