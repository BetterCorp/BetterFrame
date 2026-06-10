# ioBOX ESP32-S3 Hardware Circuit

Rev A target: ESP32-S3 ioBOX that accepts USB keyboard/mouse input and forwards
events over Wi-Fi or W5500 Ethernet. The ESP32-S3 is a USB host only; it does
not present HID to the kiosk.

## Block Diagram

```text
5V DC input
  |
  +-- 3V3 regulator --> ESP32-S3, W5500, logic
  |
  +-- USB current switches --> USB-A VBUS ports
  |
  +-- GL850G USB hub V5

USB-A keyboard/mouse ports
  -> GL850G downstream ports
  -> GL850G upstream port
  -> ESP32-S3 native USB OTG host pins

ESP32-S3
  -> W5500 SPI Ethernet
  -> RJ45 with magnetics
  -> Wi-Fi fallback/provisioning
```

## Core Parts

| Ref | Function | Suggested LCSC part | Notes |
| --- | --- | --- | --- |
| U1 | MCU module | ESP32-S3-WROOM-1-N16, C2913199 | PCB antenna module. Keep antenna keepout clear. |
| U2 | USB hub | GL850G-HHY22, C136617 | 4-port USB 2.0 hub. Use two downstream ports now, leave two NC/test. |
| U3 | Ethernet controller | W5500, C32843 | SPI Ethernet controller. Matches existing firmware scaffold. |
| J1 | RJ45 with magnetics | HR911105A, C12074 or stocked equivalent | If C12074 stock is low, use another W5500-compatible 10/100 RJ45 magjack. |
| U4/U5 | USB data ESD | USBLC6-2SC6, C7519 | One near hub upstream/host line, one near downstream USB-A connector area. |
| U6/U7 | USB VBUS power switches | AP2331-class current-limited switch | One per USB-A port. Pick 500 mA to 1 A limit depending enclosure power budget. |
| Y1 | W5500 crystal | 25 MHz crystal, 3225 or 5032 | Follow W5500 datasheet load-cap calculation. |
| Y2 | GL850G crystal | 12 MHz crystal | Follow GL850G reference design. |
| U8 | 3V3 regulator | 5V-to-3V3, >=700 mA | ESP32-S3 Wi-Fi peaks are high; avoid weak 150 mA LDOs. |

## Power

Use a 5V external input sized for the hub and peripherals.

Minimum practical budget:

```text
ESP32-S3 Wi-Fi peaks          500-700 mA on 3V3 regulator input side
W5500 + RJ45                  150-200 mA
GL850G hub                    100-150 mA
USB keyboard                  up to 100 mA typical, 500 mA worst-case
USB mouse                     up to 100 mA typical, 500 mA worst-case
```

Recommended input: `5V 2A` minimum, `5V 3A` preferred.

Power nets:

```text
+5V_IN      External 5V input after fuse/reverse protection
+5V_USB1    USB-A port 1 VBUS after current switch
+5V_USB2    USB-A port 2 VBUS after current switch
+3V3        ESP32-S3, W5500, W5500 pullups, status LEDs
GND         Common ground
```

Add:

- Fuse or resettable PTC on `+5V_IN`.
- TVS diode on `+5V_IN` if cable length or field installation is expected.
- 10 uF + 100 nF near every IC supply cluster.
- 120 uF to 220 uF bulk capacitance near USB-A VBUS outputs.

## ESP32-S3

Use the ESP32-S3 native USB pins for host mode:

| ESP32-S3 signal | GPIO | Net |
| --- | ---: | --- |
| USB_D- | GPIO19 | `USB_HOST_DM` |
| USB_D+ | GPIO20 | `USB_HOST_DP` |

Boot and reset support:

```text
EN      10 k pull-up to 3V3, reset button to GND, 100 nF to GND optional
GPIO0   10 k pull-up to 3V3, boot button to GND
```

Recommended ioBOX firmware pin assignment, matching `iobox-firmware/platformio.ini`:

| Function | ESP32-S3 GPIO | Net |
| --- | ---: | --- |
| W5500 CS | GPIO10 | `ETH_CS` |
| W5500 MOSI | GPIO11 | `SPI_MOSI` |
| W5500 SCK | GPIO12 | `SPI_SCK` |
| W5500 MISO | GPIO13 | `SPI_MISO` |
| W5500 INT | GPIO14 | `ETH_INT` |
| W5500 RESET | GPIO15 | `ETH_RST` |
| Status LED | GPIO2 | `LED_STATUS` |
| RS485 RX optional | GPIO17 | `RS485_RX` |
| RS485 TX optional | GPIO18 | `RS485_TX` |

Keep GPIO19/GPIO20 dedicated to USB.

## USB Host Hub

Use GL850G between the ESP32-S3 and the two physical USB-A ports.

Nets:

```text
ESP32-S3 GPIO20 USB_HOST_DP -> USB ESD -> GL850G upstream DP
ESP32-S3 GPIO19 USB_HOST_DM -> USB ESD -> GL850G upstream DM

GL850G downstream port 1 DP/DM -> USB ESD -> J_USB1 D+/D-
GL850G downstream port 2 DP/DM -> USB ESD -> J_USB2 D+/D-

+5V_IN -> USB power switch 1 -> J_USB1 VBUS
+5V_IN -> USB power switch 2 -> J_USB2 VBUS
J_USB1 GND -> GND
J_USB2 GND -> GND
```

Per USB data pair:

- Route D+/D- as 90 ohm differential where practical.
- Keep stubs short.
- Put ESD parts close to external connectors.
- Use 22 ohm series resistors only if recommended by the selected hub reference
  schematic; place them close to the driving IC.

USB-A connectors:

| USB-A pin | Net |
| --- | --- |
| 1 VBUS | `+5V_USBx` |
| 2 D- | `USBx_DM` |
| 3 D+ | `USBx_DP` |
| 4 GND | `GND` |
| Shield | Chassis/earth if available, otherwise GND through RC/0R option |

Hub notes:

- Populate the GL850G crystal/load capacitors exactly from the datasheet.
- Strap the hub for self-powered mode because ioBOX supplies VBUS.
- Tie unused downstream ports according to the datasheet, or expose test pads.
- For first prototype, expose hub reset and status pins on pads.

## Ethernet

W5500 runs from 3V3 and connects to ESP32-S3 over SPI.

Nets:

```text
ESP32 GPIO12 SPI_SCK  -> W5500 SCLK
ESP32 GPIO11 SPI_MOSI -> W5500 MOSI
ESP32 GPIO13 SPI_MISO -> W5500 MISO
ESP32 GPIO10 ETH_CS   -> W5500 SCSn
ESP32 GPIO14 ETH_INT  -> W5500 INTn
ESP32 GPIO15 ETH_RST  -> W5500 RSTn
```

W5500 support:

- 25 MHz crystal with correct load capacitors.
- 10 k pull-up on reset, optional ESP32-controlled reset transistor/GPIO.
- Decouple every VDD pin with 100 nF, plus local 10 uF.
- RJ45 magjack center taps and Bob Smith termination per W5500 reference design.
- Keep differential Ethernet pairs short and symmetric between W5500 and magjack.

## Optional RS485

If keeping the existing firmware RS485 path:

```text
ESP32 GPIO18 TX -> MAX3485 DI
ESP32 GPIO17 RX <- MAX3485 RO
ESP32 GPIO16    -> DE and /RE, or tie receiver always enabled
```

Use an isolated transceiver if cable runs leave the kiosk enclosure or share
building wiring.

## EasyEDA Sheet Structure

Create these schematic sheets:

1. `Power`
2. `ESP32-S3`
3. `USB Host Hub`
4. `Ethernet W5500`
5. `IO Optional`

Use global net labels:

```text
+5V_IN
+5V_USB1
+5V_USB2
+3V3
GND
USB_HOST_DP
USB_HOST_DM
USB1_DP
USB1_DM
USB2_DP
USB2_DM
SPI_SCK
SPI_MOSI
SPI_MISO
ETH_CS
ETH_INT
ETH_RST
LED_STATUS
RS485_RX
RS485_TX
RS485_DE
```

## PCB Layout Rules

- 4-layer PCB preferred: signal, ground, power, signal.
- Put ESP32-S3 at board edge with antenna over board edge or keepout.
- Put USB-A connectors at the enclosure edge.
- Put ESD devices within a few mm of USB connectors.
- Put W5500 close to RJ45 magjack.
- Keep USB D+/D- and Ethernet pairs away from the ESP32 antenna zone.
- Use a solid ground plane under USB and Ethernet routing.
- Do not split ground under high-speed pairs.

## First Prototype Bring-Up

1. Power only: confirm `+5V_IN`, `+3V3`, no hot ICs.
2. Flash ESP32-S3 over UART or native USB before enabling hub path in firmware.
3. Confirm W5500 SPI responds.
4. Confirm Ethernet link LEDs and DHCP.
5. Enable ESP32-S3 USB host stack with one keyboard direct through the hub.
6. Add mouse.
7. Verify firmware emits `io.keyboard` and `io.mouse` events.

## Rev A Decision

Use a built-in GL850G hub rather than two separate USB host controllers. It
keeps the firmware model simple: one ESP32-S3 USB host controller sees a hub
with keyboard and mouse devices attached. If firmware hub support proves weak,
Rev B can replace the hub with an external SPI USB host controller for the
second port.
