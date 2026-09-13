#pragma once
#include <Ed25519.h>

// Wire contract shared with server/src/shared/firmware.ts. The signature covers
// the lowercase HEX digest, not the binary digest or the firmware bytes directly.
inline bool verifyOtaDigest(const uint8_t digest[32], const uint8_t signature[64],
                            const uint8_t publicKey[32]) {
  static const char hex[] = "0123456789abcdef";
  char message[64];
  for (size_t i = 0; i < 32; ++i) {
    message[2 * i] = hex[digest[i] >> 4];
    message[2 * i + 1] = hex[digest[i] & 15];
  }
  return Ed25519::verify(signature, publicKey, message, sizeof(message));
}
