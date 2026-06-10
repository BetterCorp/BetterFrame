# ioBOX PoE USB4 Netlist

This is the schematic capture netlist. Use these global net labels in KiCad,
Eagle, or EasyEDA.

## Power Nets

```text
POE_VP
POE_VN
+5V_SYS
+5V_USB1
+5V_USB2
+5V_USB3
+5V_USB4
+3V3
GND
CHASSIS
```

## ESP32-S3 Core

```text
EN
GPIO0_BOOT
U0TXD
U0RXD
LED_STATUS
```

Connections:

```text
ESP32 EN        -> EN, 10k pull-up to +3V3, reset switch to GND
ESP32 GPIO0     -> GPIO0_BOOT, 10k pull-up to +3V3, boot switch to GND
ESP32 U0TXD     -> programming header RX
ESP32 U0RXD     -> programming header TX
ESP32 GPIO2     -> LED_STATUS -> resistor -> LED -> GND
```

## USB Host And Hub

```text
USB_HOST_DP
USB_HOST_DM
HUB_RESET
HUB_XTAL_IN
HUB_XTAL_OUT
USB1_DP
USB1_DM
USB2_DP
USB2_DM
USB3_DP
USB3_DM
USB4_DP
USB4_DM
USB1_OC
USB2_OC
USB3_OC
USB4_OC
USB1_PWR_EN
USB2_PWR_EN
USB3_PWR_EN
USB4_PWR_EN
```

Connections:

```text
ESP32 GPIO20 -> USB_HOST_DP -> ESD -> GL850G upstream DP
ESP32 GPIO19 -> USB_HOST_DM -> ESD -> GL850G upstream DM

GL850G downstream 1 DP/DM -> ESD -> J_USB1 D+/D-
GL850G downstream 2 DP/DM -> ESD -> J_USB2 D+/D-
GL850G downstream 3 DP/DM -> ESD -> J_USB3 D+/D-
GL850G downstream 4 DP/DM -> ESD -> J_USB4 D+/D-

+5V_SYS -> USB switch U6 -> +5V_USB1 -> J_USB1 VBUS
+5V_SYS -> USB switch U7 -> +5V_USB2 -> J_USB2 VBUS
+5V_SYS -> USB switch U8 -> +5V_USB3 -> J_USB3 VBUS
+5V_SYS -> USB switch U9 -> +5V_USB4 -> J_USB4 VBUS
```

## Ethernet

```text
SPI_SCK
SPI_MOSI
SPI_MISO
ETH_CS
ETH_INT
ETH_RST
ETH_XTAL_IN
ETH_XTAL_OUT
ETH_TXP
ETH_TXN
ETH_RXP
ETH_RXN
ETH_LED_LINK
ETH_LED_ACT
```

Connections:

```text
ESP32 GPIO12 -> SPI_SCK  -> W5500 SCLK
ESP32 GPIO11 -> SPI_MOSI -> W5500 MOSI
ESP32 GPIO13 -> SPI_MISO -> W5500 MISO
ESP32 GPIO10 -> ETH_CS   -> W5500 SCSn
ESP32 GPIO14 -> ETH_INT  -> W5500 INTn
ESP32 GPIO15 -> ETH_RST  -> W5500 RSTn
W5500 TX/RX pairs -> RJ45 magnetics data pins
RJ45 PoE taps/spare-pair power -> PoE module input
```

## GPIO Header Nets

```text
GPIO4
GPIO5
GPIO6
GPIO7
GPIO8
GPIO9
GPIO16
GPIO17
GPIO18
GPIO21
GPIO38
GPIO45
GPIO46
GPIO47
GPIO48
I2C_SDA
I2C_SCL
RS485_DE
RS485_TX
RS485_RX
```

Default aliases:

```text
GPIO47 = I2C_SDA
GPIO48 = I2C_SCL
GPIO16 = RS485_DE
GPIO17 = RS485_TX
GPIO18 = RS485_RX
```

## Test Pads

```text
TP_5V_SYS
TP_3V3
TP_GND
TP_SPI_SCK
TP_SPI_MOSI
TP_SPI_MISO
TP_ETH_CS
TP_ETH_RST
TP_ETH_INT
TP_USB_HOST_DP
TP_USB_HOST_DM
TP_HUB_RESET
```
