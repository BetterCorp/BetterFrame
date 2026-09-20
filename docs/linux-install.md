# Standalone Linux app installation

## One-line installation

Run this as a regular desktop user with sudo access. It installs the download
tools and BF prerequisites and fetches the self-contained installer automatically:

```sh
sudo bash -c 'set -eu; if command -v apt-get >/dev/null; then apt-get update; apt-get install -y ca-certificates curl util-linux; elif command -v dnf >/dev/null; then dnf install -y ca-certificates curl util-linux; else echo "Ubuntu/Debian or Fedora required" >&2; exit 1; fi; f=$(mktemp /tmp/bf-setup.XXXXXXXX); trap "rm -f -- $f" EXIT; curl -fsSL --retry 3 --connect-timeout 15 --max-time 120 --proto =https --proto-redir =https https://raw.githubusercontent.com/BetterCorp/BetterFrame/master/setup.sh -o "$f"; bash "$f" "$@"' bf-setup
```

No Git checkout, manual dependency installation, or manual download is required.
The installer runs from a private temporary file only after curl succeeds, keeps
standard input available for prompts, and removes the file when finished. The
same command repairs and updates an existing installation. Append options after
`bf-setup`, for example `--yes --channel dev`.

The commands below use `sudo ./setup.sh` for people who already have a local copy;
all those options also work with the one-line installer.

On the first run, the installer asks for the runtime user, desktop/dedicated
startup, and stable/beta/dev release channel. Subsequent runs reuse these saved
choices and download the latest signed app for that channel. It installs runtime prerequisites
using apt on Ubuntu/Debian or dnf on Fedora-family distributions. It requires
systemd and a regular user account with a home directory.

Desktop mode is the default: BetterFrame starts on graphical login and systemd
restarts it after a crash or app update. Automatic retries continue with a short
delay between attempts, without rebooting the OS. It does not enable automatic OS login. Dedicated
mode replaces graphical login with a fullscreen Cage session;
select it explicitly at the prompt or with `--mode dedicated`. The installer
never reboots the machine or disables SSH. An existing dedicated kiosk restarts
immediately; if a display manager is active, setup preserves it and schedules
dedicated startup for the next boot.

## Repeatable repair and update

Run the same command whenever the app needs updating or repairing:

```sh
sudo ./setup.sh --yes
```

Each run reapplies BF's managed configuration and permissions, downloads and
verifies the selected release, atomically replaces the executable, unmasks the
managed services, resets their failed-start limits, and restarts BF where a
graphical session is available. Missing/corrupted app binaries do not prevent
downloading a replacement. Hung BF processes are stopped with a bounded wait,
then killed within their service if necessary; setup refuses replacement if the
service still cannot be stopped. Desktop startup without an active graphical
session is deferred until login.

Interrupted app-update markers and app retry counters are backed up and cleared.
The prior rollback binary is preserved when the current candidate is unconfirmed
or its service has failed. If the new service immediately fails to stay running,
setup restores that previous executable when available, tries to start it, and
returns a failure for diagnosis. This is a short process-start check, not a camera
or server-heartbeat acceptance test.

Pairing, camera keys, cached bundles, and OS-update state are retained. Managed
files are replaced atomically; unchanged content creates no extra backup. A
process lock rejects concurrent setup runs. Custom server settings can stay in
`override.conf`; setup owns `zz-betterframe-setup.conf` for executable, update,
restart and stop settings. Avoid later overrides of those managed settings.

To change the channel for future reruns:

```sh
sudo ./setup.sh --yes --channel dev
```

An explicit `--version VERSION` or `--binary FILE` selects the executable for
that run only. A named release also remembers its stable/beta/dev channel unless
`--channel` explicitly overrides it. The script itself is not modified by setup. The one-line command fetches current
installer logic each time; update your checkout if using a local copy instead.

For a manual installation, the normal command downloads a fresh replacement.
Alternatively, repair using a specific trusted local executable:

```sh
sudo ./setup.sh --user mitchellr --binary /home/mitchellr/betterframe-kiosk-VERSION-betterframe-pc-x86_64
```

Local `--binary` files are explicitly trusted by the operator. Downloaded releases
are verified against the pinned vendor Ed25519 key and SHA256 before installation.
Stable is the initial default. Beta/dev selection searches published releases
with a complete signed asset set for the target; missing releases, network
errors, or failed verification stop setup before replacing the current app.
Choose a specific release for a one-time recovery:

```sh
sudo ./setup.sh --yes --user kiosk --mode desktop --version 1.0.14-dev.gf0075a9
```

Use `--no-start` to install/configure without starting the app; existing BF
services must already be stopped to avoid racing an in-flight app update. Package availability and binary compatibility are checked;
a release built against a newer glibc/GTK/WebKit than your distribution provides
cannot be installed. The installer requires Ubuntu 24.04+, Debian 13+, or a Fedora-family system
providing GTK 4.14+ and WebKitGTK 6.0. Older Ubuntu/Debian releases are rejected
with an explanation; the loaded runtime libraries are also checked before any
app service is stopped or executable replaced. Setup does not upgrade the OS.

New PC releases use the Ubuntu 24.04 build baseline; older
releases built on Debian Trixie may require a newer distribution. Setup fails before stopping/replacing the existing app in
that case. Supported release targets are PC x86_64 and Raspberry Pi 5 aarch64.
Fedora's available media codecs depend on its distribution packages.

The canonical executable is `/opt/betterframe/kiosk/betterframe-kiosk`, owned by
the runtime user along with its containing directory so app updates can atomically
replace it. State stays in `/var/lib/betterframe/kiosk`; pairing and keys are
preserved. The app also imports its existing `~/.betterframe-kiosk` state when
needed. Changed startup files are backed up with `.before-setup.TIMESTAMP-PID`.
The saved runtime user, mode, channel, and media gateway choice are in `/etc/betterframe/linux-install`.
Remove other custom BF startup commands if your manual install used different
service/autostart names; setup manages `betterframe.service`,
`betterframe-kiosk.service`, and `betterframe.desktop`.

App updates restart only the app. Standalone setup enables app OTA and disables
OS OTA. This no-reboot behavior requires an app release containing the updater
change: an older binary retained with `--binary` still runs its older updater.
Managed BetterFrame OS images must use their existing image update mechanism;
this installer refuses to replace their configuration.

For desktop logs, run `journalctl --user -u betterframe.service`. For dedicated
mode, use `journalctl -u betterframe-kiosk.service`.

To restore graphical login after choosing dedicated mode:

```sh
sudo systemctl disable --now betterframe-kiosk.service
sudo systemctl set-default graphical.target
```

Your previous default target is saved in `/etc/betterframe/previous-default-target`.
Reboot when convenient or start your display manager manually. To change setup
mode/user, restore the old startup configuration first, then remove
`/etc/betterframe/linux-install` and rerun setup with the appropriate user.

## MediaMTX gateway

Setup asks whether to install MediaMTX for Operator Console preview and optional
SimpleVMS recording, recommends yes, and remembers your choice. `--yes` defaults
to on for new installs and reuses the saved choice for existing installs. Use
`--media-gateway on` to enable/repair it or `--media-gateway off` to disable it
while preserving recordings. Older installations without a saved choice are
prompted once when running interactively.

When enabled, setup installs the same pinned version and configuration as the
managed images. It verifies the published archive checksum, installs a system
service running as the selected user, preserves recordings in
`/var/lib/betterframe/recordings`, and checks the local gateway API before
reporting it ready. Reruns repair missing, masked, stopped, or failed services.
This supplies Operator Console preview and SimpleVMS's gateway dependency;
enabling recording remains a BF configuration choice. Setup prepares the existing
recording directory and its permissions; it never formats a disk, mounts a new
partition, or automatically starts recording.

Check `sudo systemctl status betterframe-mediamtx.service` or
`sudo journalctl -u betterframe-mediamtx.service -n 100`. Its API listens only on
`127.0.0.1:9997`. `--no-start` requires an existing gateway service to be stopped
and defers its readiness check until you start it.

App rollback is armed before replacing the executable and stays armed when
startup is deferred until login/boot. The health deadline starts with the first
actual launch. A rendered pairing screen, cached layout, or worker-reported
offline discovery screen can confirm the running candidate without enrollment
or server connectivity. The initial logo and initialization progress alone do
not confirm startup. A late frame/heartbeat from the old app cannot confirm the
new candidate. Saved alpha releases use the dev channel.
