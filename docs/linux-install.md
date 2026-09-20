# Standalone Linux app installation

From a BetterFrame checkout, run:

```sh
sudo ./setup.sh
```

On the first run, the installer asks for the runtime user, desktop/dedicated
startup, and stable/beta/dev release channel. Subsequent runs reuse these saved
choices and download the latest signed app for that channel. It installs runtime prerequisites
using apt on Ubuntu/Debian or dnf on Fedora-family distributions. It requires
systemd and a regular user account with a home directory.

Desktop mode is the default: BetterFrame starts on graphical login and systemd
restarts it after an app update. It does not enable automatic OS login. Dedicated
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
`--channel` explicitly overrides it. The script itself is not modified by setup;
update your checkout to obtain newer installer logic.

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
cannot be installed. New PC releases use the Ubuntu 24.04 build baseline; older
releases built on Debian Trixie may require a newer distribution. Setup fails before stopping/replacing the existing app in
that case. Supported release targets are PC x86_64 and Raspberry Pi 5 aarch64.
Fedora's available media codecs depend on its distribution packages.

The canonical executable is `/opt/betterframe/kiosk/betterframe-kiosk`, owned by
the runtime user along with its containing directory so app updates can atomically
replace it. State stays in `/var/lib/betterframe/kiosk`; pairing and keys are
preserved. The app also imports its existing `~/.betterframe-kiosk` state when
needed. Changed startup files are backed up with `.before-setup.TIMESTAMP-PID`.
The saved runtime user, mode, and channel are in `/etc/betterframe/linux-install`.
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
