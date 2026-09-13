#include "ota_signature.h"
#include <cstring>
#include <cstdio>
#include <cstdlib>

static void decode(const char *hex, uint8_t *out, size_t size) {
  for (size_t i = 0; i < size; ++i) {
    char value[] = {hex[i * 2], hex[i * 2 + 1], 0};
    out[i] = static_cast<uint8_t>(strtoul(value, nullptr, 16));
  }
}
int main(int argc, char **argv) {
  if (argc != 4) return 2;
  uint8_t digest[32], signature[64], publicKey[32];
  decode(argv[1], digest, 32);
  decode(argv[2], signature, 64);
  decode(argv[3], publicKey, 32);
  if (!verifyOtaDigest(digest, signature, publicKey)) return 3;
  digest[0] ^= 1;
  if (verifyOtaDigest(digest, signature, publicKey)) return 4;
  digest[0] ^= 1;
  signature[0] ^= 1;
  if (verifyOtaDigest(digest, signature, publicKey)) return 5;
  signature[0] ^= 1;
  publicKey[0] ^= 1;
  if (verifyOtaDigest(digest, signature, publicKey)) return 6;
  puts("OTA signature: server-format valid signature accepted; modified digest/signature/key rejected");
  return 0;
}
