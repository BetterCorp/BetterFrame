# Standalone Linux app installation

From a BetterFrame checkout, run:

```sh
sudo ./setup.sh
```

The installer asks for the runtime user, desktop/dedicated startup, and whether
to keep an installed app or download a release. It installs runtime prerequisites
using apt on Ubuntu/Debian or dnf on Fedora-family distributions. It requires
systemd and a regular user account with a home directory.

Desktop mode is the default: BetterFrame starts on graphical login and systemd
restarts it after an app update. It does not enable automatic OS login. Dedicated
mode replaces graphical login with a fullscreen Cage session at the next boot;
select it explicitly at the prompt or with `--mode dedicated`. The installer
never reboots the machine or disables SSH.

Repair an existing manual installation using its current executable:

```sh
sudo ./setup.sh --user mitchellr --binary /home/mitchellr/betterframe-kiosk-VERSION-betterframe-pc-x86_64
```

Local `--binary` files are explicitly trusted by the operator. Downloaded releases
are verified against the pinned vendor Ed25519 key and SHA256 before installation.
With no release selection, setup reuses the canonical installed binary or the
running `betterframe.service` executable. A fresh installation downloads the
latest stable release. Choose a release explicitly for beta/dev installations:

```sh
sudo ./setup.sh --yes --user kiosk --mode desktop --version 1.0.14-dev.gf0075a9
```

Use `--no-start` to defer starting/restarting the app. Dedicated mode always waits
for the next boot. Package availability and binary compatibility are checked;
a release built against a newer glibc/GTK/WebKit than your distribution provides
cannot be installed. New PC releases use the Ubuntu 24.04 build baseline; older
releases built on Debian Trixie may require a newer distribution. Setup fails before stopping/replacing the existing app in
that case. Supported release targets are PC x86_64 and Raspberry Pi 5 aarch64.
Fedora's available media codecs depend on its distribution packages.

The canonical executable is `/opt/betterframe/kiosk/betterframe-kiosk`, owned by
the runtime user along with its containing directory so app updates can atomically
replace it. State stays in `/var/lib/betterframe/kiosk`; pairing and keys are
preserved. The app also imports its existing `~/.betterframe-kiosk` state when
needed. Existing startup files are backed up with `.before-setup.TIMESTAMP-PID`.
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
