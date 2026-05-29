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

The Wi-Fi variant supports HTTPS using the ESP32 TLS stack. The W5500 Ethernet
variant uses plain HTTP because the standard Arduino W5500 client does not
provide TLS; deploy it against an internal HTTP service URL or terminate TLS
upstream on the same trusted network.

## Implemented Contract

- AP provisioning portal at `http://192.168.4.1/`.
- Serial/model hint announce to `/api/iobox/announce`.
- Pair claim to `/api/iobox/pair/claim` when the device is registered but unpaired.
- Heartbeat to `/api/iobox/heartbeat`.
- Config pull from `/api/iobox/config`.
- Event post to `/api/iobox/event`.
- OTA check via `/api/iobox/firmware/check`; binary download and apply when available.
- Direct kiosk local event path using `/local/iobox/check` and `/local/iobox/event`, with server fallback.
- Local `layout.switch` mappings are executed directly against the kiosk LAN API when the assigned kiosk is reachable.
- RS485 UART line input can emit generic `rs485` events when `BF_RS485_RX_PIN` and `BF_RS485_TX_PIN` are configured.

USB HID host, binary Pelco protocol decoding, and richer IO expanders should be added inside the hardware polling section without changing the server API contract.
