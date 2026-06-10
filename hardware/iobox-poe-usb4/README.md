# ioBOX PoE USB4 Board

Board target: ESP32-S3 ioBOX with 802.3af PoE input, W5500 Ethernet, four
USB-A host ports for HID devices, and GPIO expansion headers.

This is a Rev A design package for KiCad/Eagle/EasyEDA capture. It defines the
parts, nets, connector pinout, and schematic blocks. It intentionally uses an
isolated PoE PD module for the first board spin instead of a discrete PoE
flyback supply.

## Electrical Summary

```text
RJ45 PoE/data input
  -> Ethernet magnetics
  -> W5500 SPI Ethernet
  -> ESP32-S3

RJ45 PoE center taps / spare-pair power
  -> bridge rectifier / PD module input
  -> isolated 5V output
  -> USB hub + USB VBUS switches + 3V3 regulator

ESP32-S3 GPIO19/GPIO20 native USB host
  -> GL850G 4-port USB hub
  -> four USB-A downstream host ports

ESP32-S3 GPIO header
  -> 3V3 GPIO, I2C, UART/RS485 option, interrupt-capable pins
```

## Board Assumptions

- PoE class: IEEE 802.3af.
- PoE power: use `5V 9W` module for Rev A.
- USB ports are for keyboard/mouse/HID class devices, not charging.
- Per-port USB current limit should be set around `150 mA` to `250 mA` unless
  the PoE module is upgraded. Four 500 mA USB ports exceed a realistic 802.3af
  system budget once the ESP32-S3, W5500, and hub are included.
- Firmware uses current BetterFrame pin map:
  - W5500 CS GPIO10
  - W5500 MOSI GPIO11
  - W5500 SCK GPIO12
  - W5500 MISO GPIO13
  - USB host GPIO19/GPIO20

## Main ICs

| Ref | Function | Selected part | Notes |
| --- | --- | --- | --- |
| U1 | MCU | ESP32-S3-WROOM-1-N16 or N16R8 | Use module, not bare chip. |
| U2 | USB hub | GL850G-HHY22 | 4 downstream USB ports. |
| U3 | Ethernet | W5500 | SPI Ethernet controller. |
| U4 | PoE PD + isolated 5V | Silvertel AG9905M or AG9905-MTB | 802.3af, 5V output module. Manual assembly likely. |
| U5 | 3V3 regulator | 5V to 3V3, >=800 mA | Pick a JLC/LCSC stocked buck or high-current LDO. |
| U6-U9 | USB VBUS switches | TPS2553/AP2331/AP22802 class | One per USB-A port. Current limit per power budget. |
| U10-U14 | USB ESD | USBLC6-2SC6 or equivalent | One for upstream, one per USB-A connector. |

## Power Tree

```text
PoE RJ45
  -> AG9905M isolated 5V output
  -> +5V_SYS

+5V_SYS
  -> U5 3V3 regulator -> +3V3
  -> U2 GL850G V5/V33 per reference design
  -> U6 USB1 current switch -> +5V_USB1
  -> U7 USB2 current switch -> +5V_USB2
  -> U8 USB3 current switch -> +5V_USB3
  -> U9 USB4 current switch -> +5V_USB4
```

Required protection and filtering:

- TVS on PoE input/module input if not already included in selected module
  reference design.
- Bulk capacitor on `+5V_SYS`: `220 uF` low ESR plus `10 uF` and `100 nF`.
- Bulk capacitor on each USB VBUS output: `47 uF` to `120 uF`.
- 100 nF at every IC power pin group.
- Power-good/test pads for `+5V_SYS` and `+3V3`.

## Ethernet / PoE Front End

Use an RJ45/magjack suitable for PoE. Route Ethernet data pairs to W5500 and
PoE power taps to the PoE module input as recommended by the selected magjack
and PoE module datasheets.

W5500 SPI nets:

| ESP32-S3 GPIO | Net | W5500 signal |
| ---: | --- | --- |
| GPIO12 | `SPI_SCK` | SCLK |
| GPIO11 | `SPI_MOSI` | MOSI |
| GPIO13 | `SPI_MISO` | MISO |
| GPIO10 | `ETH_CS` | SCSn |
| GPIO14 | `ETH_INT` | INTn |
| GPIO15 | `ETH_RST` | RSTn |

W5500 support:

- 25 MHz crystal with datasheet load capacitors.
- 10 k pull-up on reset.
- Optional 0R series links on SPI for bring-up.
- Keep W5500 close to magjack.
- Keep Ethernet differential pairs short and length-similar.

## USB Host Hub

ESP32-S3 native USB host to GL850G upstream:

| ESP32-S3 GPIO | Net | USB function |
| ---: | --- | --- |
| GPIO19 | `USB_HOST_DM` | USB D- |
| GPIO20 | `USB_HOST_DP` | USB D+ |

Hub downstream:

| GL850G port | Connector | Nets |
| --- | --- | --- |
| Downstream 1 | J_USB1 | `USB1_DP`, `USB1_DM`, `+5V_USB1` |
| Downstream 2 | J_USB2 | `USB2_DP`, `USB2_DM`, `+5V_USB2` |
| Downstream 3 | J_USB3 | `USB3_DP`, `USB3_DM`, `+5V_USB3` |
| Downstream 4 | J_USB4 | `USB4_DP`, `USB4_DM`, `+5V_USB4` |

USB layout:

- Route USB D+/D- as 90 ohm differential where the PCB stackup allows.
- Put ESD near USB-A connectors.
- Put VBUS power switches close to USB-A connectors.
- Tie USB shield to chassis if available, otherwise use a 0R/RC option to GND.
- Strap GL850G for self-powered operation.

## GPIO Headers

Use two 2.54 mm headers: one for low-risk GPIO and one for power/serial.

### J_GPIO1

| Pin | Net | Notes |
| ---: | --- | --- |
| 1 | `+3V3` | 3V3 output, limited |
| 2 | `GND` | Ground |
| 3 | `GPIO4` | ADC/touch capable |
| 4 | `GPIO5` | ADC/touch capable |
| 5 | `GPIO6` | GPIO |
| 6 | `GPIO7` | GPIO |
| 7 | `GPIO8` | GPIO |
| 8 | `GPIO9` | GPIO |
| 9 | `GPIO21` | GPIO |
| 10 | `GND` | Ground |

### J_GPIO2

| Pin | Net | Notes |
| ---: | --- | --- |
| 1 | `+5V_SYS` | 5V output, fused/limited if exposed |
| 2 | `GND` | Ground |
| 3 | `GPIO16` | RS485 DE / spare |
| 4 | `GPIO17` | UART TX / RS485 TX |
| 5 | `GPIO18` | UART RX / RS485 RX |
| 6 | `GPIO38` | GPIO |
| 7 | `GPIO45` | input-only/strap-sensitive; use carefully |
| 8 | `GPIO46` | input-only/strap-sensitive; use carefully |
| 9 | `I2C_SDA` / GPIO47 | Optional I2C |
| 10 | `I2C_SCL` / GPIO48 | Optional I2C |

Do not expose GPIO19/GPIO20 on the general header; they are dedicated USB host.

## Programming Header

Add either USB-C programming directly to native USB or a UART programming
header. Because GPIO19/GPIO20 are consumed by USB host/hub, Rev A should use a
UART header for flashing and logs:

| Pin | Net |
| ---: | --- |
| 1 | `+3V3` |
| 2 | `GND` |
| 3 | `U0TXD` |
| 4 | `U0RXD` |
| 5 | `EN` |
| 6 | `GPIO0_BOOT` |

Add buttons:

- `EN` reset button to GND.
- `GPIO0_BOOT` boot button to GND.

## Schematic Sheets

For KiCad/Eagle/EasyEDA, create these sheets:

1. `01_Power_PoE`
2. `02_ESP32S3`
3. `03_Ethernet_W5500`
4. `04_USB_Hub_4xA`
5. `05_GPIO_Headers`
6. `06_Test_Programming`

Use the net names in `netlist.md` exactly to keep firmware and schematic in
sync.

## PCB Notes

- 4-layer board recommended.
- Place RJ45 on one edge.
- Place USB-A connectors on an adjacent or opposite enclosure edge.
- Place ESP32-S3 at an edge with antenna keepout clear.
- Keep PoE/module isolation clearances per module datasheet.
- Keep W5500-to-RJ45 data routing away from ESP32 antenna.
- Solid ground plane; do not split ground under USB pairs.
- Add test pads for all power rails, SPI, ETH reset/int, USB host pair, and
  hub reset.

## Known Rev A Risks

- Four USB ports at 500 mA each are not compatible with a small 802.3af 5V 9W
  module. This board should current-limit USB ports for HID use.
- ESP32-S3 USB host firmware must support hub + HID enumeration. Validate this
  before committing to production.
- PoE magnetics/module pinouts vary. Lock the exact magjack and PoE module
  footprints before PCB layout.
