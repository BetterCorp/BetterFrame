# BetterFrame ioBOX Firmware

ESP32-S3 PlatformIO firmware scaffold for BetterFrame ioBOX devices.

## Variants

- `iobox_wifi`: no Ethernet chip. Uses Wi-Fi STA after provisioning.
- `iobox_eth`: Ethernet-capable board. If Ethernet succeeds at boot, Wi-Fi is never enabled.

Recommended base hardware:

- MCU: ESP32-S3 with native USB OTG and at least 8 MB flash.
- Ethernet variant: ESP32-S3 + W5500 SPI Ethernet.
- RS485/PTZ option: isolated MAX3485/MAX13487-class transceiver on UART.
- Local IO option: PIR, buttons, status LED or relay/light outputs.

## Boot Networking Rule

Network mode is selected only at boot.

- If stored mode is `ethernet`, firmware attempts Ethernet only. If it disconnects later, it keeps retrying Ethernet.
- If stored mode is `wifi_sta`, firmware attempts configured Wi-Fi only. If it fails, it keeps retrying Wi-Fi.
- If no stored mode exists, Ethernet-capable firmware tries Ethernet first. On success it stores `ethernet`.
- If no Ethernet is available, Wi-Fi AP provisioning starts for 5 minutes. Successful Wi-Fi provisioning stores `wifi_sta` and restarts.
- Changing mode requires a factory reset.

## Build

```bash
cd iobox-firmware
pio run -e iobox_wifi
pio run -e iobox_eth
```

Set deployment values with PlatformIO build flags or a private local override:

- `BF_DEFAULT_SERVER_URL`
- `BF_MODEL_HINT`
- Ethernet SPI pins for the chosen board.
- IO pins for PIR/buttons/RS485.

Both variants verify the server certificate and hostname against an embedded
root CA. W5500 uses ESP_SSLClient over EthernetClient. Server pairing and API
traffic require HTTPS. Enrollment bodies and bearer-authenticated requests are
explicitly scoped to the parsed configured HTTPS origin, including when the
stored URL has trailing slashes. Hostname prefixes, different ports and scheme
downgrades cannot bypass this check. The existing local kiosk LAN protocol remains
HTTP through explicitly local calls, which never attach the server bearer key.

### Required trust provisioning and upgrade order

1. Deploy the matching server pairing changes before upgrading devices.
2. Obtain the deployment CA certificate and the server's existing firmware signing
   **public** PEM through an authenticated operator channel. Verify their
   fingerprints independently. Never copy the signing private key into firmware.
3. Generate the ignored local header and build both variants:

   ```sh
   python3 scripts/provision_trust.py --ca /secure/public/root-ca.pem \
     --signing-public-key /secure/public/firmware-signing.pub.pem
   pio run -e iobox_wifi -e iobox_eth
   ```

   Release CI requires repository variables `BF_IOBOX_TLS_CA_PEM` and
   `BF_IOBOX_OTA_PUBLIC_KEY_PEM` with those same public values. Missing values
   fail release builds. Unprovisioned developer builds compile, but visibly
   refuse server TLS and OTA; they must not be flashed to a production fleet.
4. Ensure the configured HTTPS name resolves on both networks, matches the server
   certificate, and NTP/DNS are reachable. `BF_NTP_SERVER` defaults to
   `pool.ntp.org`; provision your own time server in the local header when needed.
   Certificate verification waits for NTP time, retries on failure, and never
   disables validity checks. NTP is unauthenticated: networks requiring protected
   time must supply a trusted time source/network and hardware qualification.
5. For old HTTP deployments, provision an HTTPS URL and CA before flashing.
   Existing credentials and network configuration are retained. A changed server
   origin or corrupt identity stops enrollment with a serial-console diagnostic;
   an administrator must explicitly recover/reset it. Existing serial-only
   claims whose key was already lost require administrator unpair/re-enrollment;
   the device cannot securely recover a secret it never possessed.

Before mass rollout, test the provisioned images on real Wi-Fi/W5500 hardware:
valid/untrusted/expired/wrong-host certificates, missing NTP, lost claim and ACK
responses, power loss during NVS write, revoked keys, interrupted flash, invalid
and valid firmware signatures. Keep USB recovery available. Firmware does not
replace hardware secure boot, encrypted NVS, or device-level rollback controls.

### Pairing durability and OTA format

A 256-bit device secret is saved in NVS **before** announcing. Its hash binds
server-side claim retries; the secret is never logged. This binds the first
accepted announcement, rather than proving factory provenance. Enroll on a
controlled network; deployments needing protection against initial serial
impersonation must pre-register per-device manufacturing credentials. The returned identity is
stored as one versioned NVS value and read back before use/ACK. A reboot or lost
claim response reuses the same secret. ACK retries survive reboot and the server
removes the encrypted retry envelope after ACK. Existing two-key identities are
migrated without deleting the legacy copy. Storage or authentication failures
preserve the identity and report an actionable serial-console state.

OTA signatures use the existing server format: base64url Ed25519 signature over
the 64-byte lowercase hexadecimal SHA-256 digest of the exact firmware binary.
The embedded Ed25519 public key is independent of the downloaded metadata. The
firmware verifies both digest and signature **before** `Update.end()` marks the
partition bootable; failures abort the inactive-partition write. Downloads must
stay on the configured HTTPS origin, so bearer credentials cannot leak through a
server-supplied third-party URL. Rotating the signing key requires an image signed
by the currently trusted key that carries the new trust material, or USB service.
The existing server import signs firmware; release downloads alone are not a
substitute for signed metadata from that import.

## Implemented Contract

- AP provisioning portal at `http://192.168.4.1/`.
- Serial/model hint announce to `/api/iobox/announce`.
- Pair claim to `/api/iobox/pair/claim` and durable-storage acknowledgment to `/api/iobox/pair/ack`.
- Heartbeat to `/api/iobox/heartbeat`.
- Config pull from `/api/iobox/config`.
- Event post to `/api/iobox/event`.
- OTA check via `/api/iobox/firmware/check`; binary download and apply when available.
- Direct kiosk local event path using `/local/iobox/check` and `/local/iobox/event`, with server fallback.
- Local `layout.switch` mappings are executed directly against the kiosk LAN API when the assigned kiosk is reachable.
- RS485 UART line input can emit generic `rs485` events when `BF_RS485_RX_PIN` and `BF_RS485_TX_PIN` are configured.

USB HID host, binary Pelco protocol decoding, and richer IO expanders should be added inside the hardware polling section without changing the server API contract.

## Local regression checks

After PlatformIO has installed the pinned libraries, run:

```sh
python3 -m unittest discover -s tests -v
node tests/test_ota_signature.mjs
```

The native signature test compiles the same verification helper and Crypto library
used by firmware, verifies a Node-generated server-format signature, and rejects
modified firmware digests, signatures, and public keys. The provisioning tests
reject invalid certificates, private key input, and non-Ed25519 signing keys.
The native HTTP policy tests exercise the same origin/scope helper as firmware,
including insecure configurations with trailing slashes, HTTPS origins, malformed
URLs, server/enrollment credential isolation, and local kiosk HTTP compatibility.
