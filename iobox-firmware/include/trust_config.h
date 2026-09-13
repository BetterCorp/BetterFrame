#pragma once
// Override with include/trust_config_local.h during controlled provisioning.
// Only PUBLIC trust material belongs here, never a firmware signing private key.
#if __has_include("trust_config_local.h")
#include "trust_config_local.h"
#endif
#ifndef BF_TLS_CA_PEM
#define BF_TLS_CA_PEM ""
#endif
#ifndef BF_OTA_PUBLIC_KEY_HEX
#define BF_OTA_PUBLIC_KEY_HEX ""
#endif
#ifndef BF_NTP_SERVER
#define BF_NTP_SERVER "pool.ntp.org"
#endif
