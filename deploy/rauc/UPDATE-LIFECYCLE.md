# OS update lifecycle

A slot post-install hook is not a completed installation. Activation and final
RAUC status writes happen after the hook returns. The bundle therefore stages a
root-owned reboot guard in `/run` and starts it through systemd. This works when
the currently running kiosk predates the fix and cannot request a privileged
reboot itself. It does not grant the kiosk additional privileges.

The guard captures the RAUC D-Bus owner during installation and requires the same
daemon to finish with `Operation=idle` and an empty `LastError`. The guard allows
up to 30 minutes for remaining slot writes and cleanup on slow storage; this wait
is independent of the client watchdog, which starts after RAUC returns. It then verifies
activation: `GetPrimary` identifies the target on x86; the Pi backend's `pending`
record is written only after both tryboot configurations have been synced. Pi
`GetPrimary` identifies the permanent slot, so it cannot confirm trial activation.
The Pi argument form follows the [Raspberry Pi documentation](https://www.raspberrypi.com/documentation/hardware/rpi/os.html).
The guard rechecks the daemon and idle/error state after its five-second grace
period before requesting x86 reboot or Pi `reboot '0 tryboot'` (one argument). Failed, restarted,
unactivated, or timed-out transactions do not trigger reboot.

The guard exposes its current stage or failure in the root-owned, readable file
`/run/betterframe-rauc/os-reboot-status.txt`. The kiosk's persisted update attempt
and admin status remain the user-facing source of diagnostics. No shell access
is required on managed devices.

RAUC metadata lives on shared BF_DATA at `/var/lib/betterframe/rauc`, rather than
inside a replaceable root slot. The service migrates legacy metadata once before
starting. When installing from an older OS, the bundled guard refreshes legacy
metadata after activation so the new system receives the final pending state.
RAUC cannot start before the data mount is available.

The health confirmation service retries after a five-minute health wait instead
of permanently abandoning confirmation. The kiosk must supply a real rendered
health marker, including for its unpaired pairing screen. Only successful
`rauc status mark-good` produces the confirmation marker.

Run host regression tests without hardware or any real reboot:

```sh
python3 -m unittest discover -s deploy/rauc/tests -v
```

These tests mock D-Bus, reboot, and systemd. Actual bootloader behavior and power
loss during writes still require Pi and x86 hardware testing. Existing downloaded
bundles retain their old hook; the correction takes effect with a new bundle.

The client stores its target release, boot ID, phase and diagnostic in
`/var/lib/betterframe/kiosk/os-update.json`, using an atomic, synced replacement.
A new boot is reconciled against `/etc/betterframe/os-version` and RAUC's health
confirmation. An unpaired healthy boot can confirm locally; reporting to BF is
separate. A return to the older OS preserves the attempted target and reports a
rollback instead of overwriting it with an unrelated confirmation.

Automatic and pre-pairing attempts share the persistent three-attempt limit.
Installing and pending-reboot records block automatic reinstallation. An admin
retry is allowed only once the installer is idle. Changing channels can cancel a
download, but cannot abort a transaction already handed to RAUC; loss of the CLI
connection keeps the bundle and blocks automatic retries because the daemon may
still be writing it. Errors appear on the pairing screen and in BF after pairing.

The signed **next OS bundle** carries the reboot guard, including the corrected
Pi argument, for installation by 0.318 or 1.0.0 clients. Already published
1.0.0 bundles are immutable and retain the faulty hook. New client lifecycle
tracking and pairing-health confirmation take effect after booting the new OS.
No terminal access or signing-key rotation is part of this recovery path.
