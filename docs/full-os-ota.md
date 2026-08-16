# BetterFrame full OS OTA

Production kiosks use signed RAUC A/B OS updates. App-only binary replacement
is disabled unless `BF_ENABLE_APP_OTA=1` is explicitly set.

## Targets

| Target | Slots | Boot selection |
| --- | --- | --- |
| Raspberry Pi 5 aarch64 | two FAT boot + two ext4 root + data | firmware `autoboot.txt` and `tryboot` |
| PC x86_64 | shared ESP + two ext4 root + data | RAUC GRUB backend and shared `grubenv` |

The persistent data partition contains pairing state, local bundle cache, and
RAUC state. An x86 bundle contains only the root filesystem because both slots
boot through the shared ESP.

## Safety flow

1. The kiosk downloads a matching bundle and verifies its size, SHA-256,
   compatibility, and RAUC signature before installation.
2. RAUC writes the inactive slot and selects it for one trial boot.
3. The kiosk drains active media pipelines and reboots (`tryboot` on Pi).
4. A successful server heartbeat creates `/run/betterframe/kiosk-healthy`.
5. `betterframe-rauc-mark-good.service` commits the running slot and creates
   `/run/betterframe/rauc-confirmed`.
6. Only then does the kiosk report the version as confirmed to the server.
   Failure before commit leaves the prior slot available for rollback.

The system D-Bus policy denies RAUC to every user except root and the
unprivileged `bfkiosk` service account. The kiosk can install a verified bundle;
the separately privileged mark-good service owns slot confirmation.

## Signing

Generate the long-lived production certificate and keep its private key only in
the release system:

```bash
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout betterframe-rauc.key.pem \
  -out betterframe-rauc.cert.pem \
  -days 3650 \
  -subj "/CN=BetterFrame RAUC Production/"
```

The certificate is baked into `/etc/rauc/keyring.pem`. Release CI consumes the
certificate/key secrets, creates the `.raucb`, and can import it through the
server's dedicated OTA import key. Never place the private key in an image or
repository.

## Release gate

Before publishing a production image, boot both slots on real target hardware,
install a signed upgrade, deliberately prevent the trial kiosk health marker,
and verify automatic fallback. Then repeat with a healthy trial and verify the
server changes from `pending_reboot` to `confirmed` only after `mark-good`.
