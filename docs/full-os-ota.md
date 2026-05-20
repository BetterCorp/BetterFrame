# BetterFrame Full OS OTA

BetterFrame field devices must use full-image A/B OTA for OS, package,
kernel, firmware, GTK/WebKit/GStreamer, and kiosk runtime changes. App-only
binary replacement is not sufficient for production field deployments.
The legacy kiosk binary updater is gated behind `BF_ENABLE_APP_OTA=1` and
should stay disabled in production.

## Target Design

- Update engine: RAUC.
- Boot selection: Raspberry Pi firmware `autoboot.txt` / `tryboot` via a
  BetterFrame RAUC custom bootloader backend.
- Bundle format: RAUC `verity`.
- Device compatibility: `betterframe-rpi5-aarch64`.
- Slot layout:
  - `BF_BOOTSEL`: small FAT partition containing only `autoboot.txt`.
  - `BF_BOOT_A`: FAT boot files for slot A.
  - `BF_ROOT_A`: ext4 root filesystem for slot A.
  - `BF_BOOT_B`: FAT boot files for slot B.
  - `BF_ROOT_B`: ext4 root filesystem for slot B.
  - `BF_DATA`: persistent ext4 data partition for pairing state, logs,
    RAUC state, and local kiosk cache.

## Safety Flow

1. Kiosk checks the BetterFrame server for an OS bundle matching channel,
   rollout, architecture, and current OS version.
2. Device installs the signed RAUC bundle to the inactive slot.
3. RAUC marks the inactive slot as primary.
4. Device reboots using Pi `tryboot`.
5. If the new slot fails to boot, Pi firmware falls back to the previous
   normal slot.
6. If the new slot boots and the kiosk successfully heartbeats to the server,
   `betterframe-rauc-mark-good.service` runs `rauc status mark-good`.

## Signing

RAUC uses X.509 bundle signing. The public certificate must be baked into the
image as `/etc/rauc/keyring.pem`. The private key is a CI secret used only to
produce `.raucb` bundles.

Generate a production keypair:

```bash
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout betterframe-rauc.key.pem \
  -out betterframe-rauc.cert.pem \
  -days 3650 \
  -subj "/CN=BetterFrame RAUC Production/"
```

Required CI/Coolify secrets for full OS OTA:

- `BF_RAUC_CERT_PEM`: public certificate, baked into the client image.
- `BF_RAUC_KEY_PEM`: private signing key, used only by GitHub Actions.
- `BF_AUTOIMPORT_URL`: BetterFrame server public base URL.
- `BF_AUTOIMPORT_API_KEY`: import token matching server
  `BF_FIRMWARE_IMPORT_API_KEY`.

## Current State

This repository now contains the RAUC target config and boot backend
scaffolding. The remaining production work is:

1. Replace the single-root pi-gen output with a GPT A/B image layout.
2. Generate `.raucb` bundles from the same boot/root artifacts used for the
   flashable image.
3. Add server-side OS release metadata separate from app-binary firmware.
4. Add kiosk-side OS update polling/install orchestration.
5. Lock down local input devices and mutable OS paths.
