#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <Update.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiUdp.h>
#include <esp_random.h>
#include <bootloader_random.h>
#include <mbedtls/base64.h>
#include "ota_signature.h"
#include <sys/time.h>
#include "trust_config.h"
#include "http_policy.h"
#include <mbedtls/sha256.h>

#if BF_ETHERNET_VARIANT
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <ESP_SSLClient.h>
#include <SPI.h>
#endif

#ifndef BF_IOBOX_FW_VERSION
#define BF_IOBOX_FW_VERSION "0.0.0-dev"
#endif

#ifndef BF_DEFAULT_SERVER_URL
#define BF_DEFAULT_SERVER_URL "https://betterframe.local"
#endif

#ifndef BF_MODEL_HINT
#define BF_MODEL_HINT "ioBOX-WIFI"
#endif

#ifndef BF_AP_TIMEOUT_MS
#define BF_AP_TIMEOUT_MS 300000
#endif

#ifndef BF_STATUS_LED_PIN
#define BF_STATUS_LED_PIN 2
#endif

#ifndef BF_PIR_PIN
#define BF_PIR_PIN -1
#endif

#ifndef BF_BUTTON_PIN
#define BF_BUTTON_PIN -1
#endif

namespace {

enum class NetMode { Unknown, Ethernet, WifiSta };

Preferences prefs;
WebServer portal(80);

String serialNumber;
String serverUrl;
String ioboxKey;
String ioboxId;
String provisioningSecret;
bool claimAckPending = false;
bool identityBlocked = false;
String diagnostic;
String assignedDisplayId;
String assignedKioskLocalKey;
String assignedKioskIp;
uint16_t assignedKioskPort = 18090;
String modelId;
NetMode mode = NetMode::Unknown;
JsonDocument ioMappings;

bool networkUp = false;
bool paired = false;
bool localKioskReachable = false;
uint32_t lastHeartbeatMs = 0;
uint32_t lastConfigMs = 0;
uint32_t lastOtaCheckMs = 0;
uint32_t lastHardwarePollMs = 0;
uint32_t eventSeq = 0;
int lastPirState = -1;
int lastButtonState = -1;
String rs485Line;

#if BF_ETHERNET_VARIANT
EthernetClient ethClient;
ESP_SSLClient ethSecureClient;
#endif
WiFiClient wifiClient;
WiFiClientSecure wifiSecureClient;

struct ParsedUrl {
  String host;
  String path;
  uint16_t port;
  bool https;
};

String prefString(const char *key, const char *fallback = "") {
  return prefs.getString(key, fallback);
}

bool saveString(const char *key, const String &value) {
  return prefs.putString(key, value) == value.length() && prefs.getString(key) == value;
}

void report(const String &message) {
  if (diagnostic != message) {
    diagnostic = message;
    Serial.println("[ioBOX] " + message);
  }
}

bool saveIdentity(const String &id, const String &key, bool ackPending) {
  if (id.isEmpty() || key.isEmpty()) return false;
  JsonDocument identity;
  identity["version"] = 1;
  identity["id"] = id;
  identity["key"] = key;
  identity["server"] = serverUrl;
  identity["ack_pending"] = ackPending;
  String encoded;
  serializeJson(identity, encoded);
  // NVS commits a single value atomically. Verify before ACK or using it.
  if (!saveString("identity", encoded)) {
    report("Pairing storage failed; retaining server claim for retry");
    return false;
  }
  ioboxId = id;
  ioboxKey = key;
  claimAckPending = ackPending;
  paired = true;
  return true;
}

String macSerial() {
  uint64_t mac = ESP.getEfuseMac();
  char buf[20];
  snprintf(buf, sizeof(buf), "IOB-%04X%08X", static_cast<uint16_t>(mac >> 32), static_cast<uint32_t>(mac));
  return String(buf);
}

String modeName(NetMode value) {
  switch (value) {
    case NetMode::Ethernet:
      return "ethernet";
    case NetMode::WifiSta:
      return "wifi_sta";
    default:
      return "unknown";
  }
}

NetMode loadMode() {
  String raw = prefString("net_mode");
  if (raw == "ethernet") return NetMode::Ethernet;
  if (raw == "wifi_sta") return NetMode::WifiSta;
  return NetMode::Unknown;
}

void storeMode(NetMode value) {
  mode = value;
  saveString("net_mode", modeName(value));
}

void setLed(bool on) {
#if BF_STATUS_LED_PIN >= 0
  digitalWrite(BF_STATUS_LED_PIN, on ? HIGH : LOW);
#endif
}

String joinUrl(const String &base, const char *path) {
  if (base.endsWith("/")) return base.substring(0, base.length() - 1) + path;
  return base + path;
}

bool parseUrl(const String &url, ParsedUrl &out) {
  bf::HttpUrl parsed;
  if (!bf::parseHttpUrl(std::string(url.c_str(), url.length()), parsed)) return false;
  out.host = parsed.host.c_str();
  out.path = parsed.path.c_str();
  out.port = parsed.port;
  out.https = parsed.https;
  return true;
}

bool allowRequest(const String &url, bf::HttpTarget target = bf::HttpTarget::Server) {
  // Preserve lengths so embedded NUL bytes cannot make validation inspect a
  // different authority than Arduino HTTPClient later parses from String.
  return bf::allowHttpRequest(std::string(serverUrl.c_str(), serverUrl.length()),
                             std::string(url.c_str(), url.length()), target);
}

String sha256Hex(const uint8_t digest[32]) {
  static const char *hex = "0123456789abcdef";
  String out;
  out.reserve(64);
  for (int i = 0; i < 32; i++) {
    out += hex[digest[i] >> 4];
    out += hex[digest[i] & 0x0F];
  }
  return out;
}

bool tlsReady() {
  if (strlen(BF_TLS_CA_PEM) == 0) {
    report("TLS trust root missing; provision trust_config_local.h before deployment");
    return false;
  }
  if (time(nullptr) < 1704067200) {
    report("Waiting for network time before certificate verification");
    return false;
  }
  return true;
}

bool syncNetworkTime() {
  if (time(nullptr) >= 1704067200) return true;
  WiFiUDP wifiUdp;
#if BF_ETHERNET_VARIANT
  EthernetUDP ethernetUdp;
  UDP &udp = mode == NetMode::Ethernet ? static_cast<UDP &>(ethernetUdp) : static_cast<UDP &>(wifiUdp);
#else
  UDP &udp = wifiUdp;
#endif
  if (!udp.begin(49152 + (esp_random() % 16000))) return false;
  uint8_t packet[48] = {};
  packet[0] = 0x23; // NTP v4 client
  esp_fill_random(packet + 40, 8);
  uint8_t nonce[8];
  memcpy(nonce, packet + 40, 8);
  if (!udp.beginPacket(BF_NTP_SERVER, 123)) { udp.stop(); return false; }
  udp.write(packet, sizeof(packet));
  if (!udp.endPacket()) { udp.stop(); return false; }
  uint32_t start = millis();
  while (millis() - start < 3000) {
    if (udp.parsePacket() >= 48 && udp.remotePort() == 123 && udp.read(packet, 48) == 48 &&
        (packet[0] & 7) == 4 && (packet[0] >> 6) != 3 && packet[1] > 0 && packet[1] <= 15 &&
        memcmp(packet + 24, nonce, 8) == 0) {
      uint32_t seconds = (uint32_t(packet[40]) << 24) | (uint32_t(packet[41]) << 16) |
                         (uint32_t(packet[42]) << 8) | packet[43];
      if (seconds >= 3913056000UL) {
        timeval value = {static_cast<time_t>(seconds - 2208988800UL), 0};
        settimeofday(&value, nullptr);
        udp.stop();
        return true;
      }
    }
    delay(10);
  }
  udp.stop();
  report("Network time unavailable; TLS will retry (check NTP/DNS)");
  return false;
}

bool verifyFirmwareSignature(const uint8_t digest[32], const String &signature, String &error) {
  const String publicHex = BF_OTA_PUBLIC_KEY_HEX;
  if (publicHex.length() != 64) { error = "OTA signing public key not provisioned"; return false; }
  uint8_t publicKey[32];
  for (size_t i = 0; i < 32; ++i) {
    char pair[3] = {publicHex[i * 2], publicHex[i * 2 + 1], 0};
    char *end = nullptr;
    publicKey[i] = static_cast<uint8_t>(strtoul(pair, &end, 16));
    if (end != pair + 2) { error = "invalid OTA signing public key"; return false; }
  }
  String base64 = signature;
  base64.replace('-', '+');
  base64.replace('_', '/');
  while (base64.length() % 4) base64 += '=';
  uint8_t decoded[64];
  size_t decodedLength = 0;
  if (signature.length() != 86 ||
      mbedtls_base64_decode(decoded, sizeof(decoded), &decodedLength,
        reinterpret_cast<const uint8_t *>(base64.c_str()), base64.length()) != 0 || decodedLength != 64) {
    error = "missing or invalid firmware signature";
    return false;
  }
  // Match server/shared/firmware.ts: Ed25519 over lowercase SHA256 hex text.
  bool valid = verifyOtaDigest(digest, decoded, publicKey);
  if (!valid) error = "firmware signature verification failed";
  return valid;
}

bool streamUpdateWithSha(Client &client, int contentLength, const String &expectedSha, const String &signature, String &error) {
  if (expectedSha.length() != 64) {
    error = "missing sha256";
    return false;
  }

  const bool knownSize = contentLength > 0;
  const size_t updateSize = knownSize ? static_cast<size_t>(contentLength) : UPDATE_SIZE_UNKNOWN;
  if (!Update.begin(updateSize)) {
    error = Update.errorString();
    return false;
  }

  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0);

  uint8_t buffer[1024];
  size_t total = 0;
  uint32_t lastDataMs = millis();
  const uint32_t downloadStartMs = millis();
  while ((knownSize && total < static_cast<size_t>(contentLength)) || (!knownSize && (client.connected() || client.available()))) {
    if (millis() - downloadStartMs > 180000) {
      error = "download deadline exceeded";
      mbedtls_sha256_free(&sha);
      Update.abort();
      return false;
    }
    int available = client.available();
    if (available <= 0) {
      if (millis() - lastDataMs > 15000) break;
      delay(2);
      continue;
    }
    size_t want = min(static_cast<size_t>(available), sizeof(buffer));
    if (knownSize) want = min(want, static_cast<size_t>(contentLength) - total);
    int got = client.read(buffer, want);
    if (got <= 0) continue;
    lastDataMs = millis();
    mbedtls_sha256_update(&sha, buffer, got);
    if (Update.write(buffer, got) != static_cast<size_t>(got)) {
      error = Update.errorString();
      mbedtls_sha256_free(&sha);
      Update.abort();
      return false;
    }
    total += static_cast<size_t>(got);
  }

  uint8_t digest[32];
  mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);
  if (knownSize && total != static_cast<size_t>(contentLength)) {
    error = "short download";
    Update.abort();
    return false;
  }
  if (!sha256Hex(digest).equalsIgnoreCase(expectedSha)) {
    error = "sha256 mismatch";
    Update.abort();
    return false;
  }
  if (!verifyFirmwareSignature(digest, signature, error)) {
    Update.abort();
    return false;
  }
  if (!Update.end(!knownSize)) {
    error = Update.errorString();
    return false;
  }
  return true;
}

#if BF_ETHERNET_VARIANT
bool ethernetHttpBody(const char *method, const String &url, const String &payload, String &body, bool auth = true) {
  ParsedUrl parsed;
  if (!parseUrl(url, parsed)) return false;
  if (parsed.https && !tlsReady()) return false;
  Client &client = parsed.https ? static_cast<Client &>(ethSecureClient) : static_cast<Client &>(ethClient);
  client.setTimeout(8000);
  if (!client.connect(parsed.host.c_str(), parsed.port)) {
    report("Ethernet connection/TLS verification failed");
    return false;
  }

  client.print(method);
  client.print(" ");
  client.print(parsed.path);
  client.println(" HTTP/1.0");
  client.print("Host: ");
  client.println(parsed.host);
  client.println("Connection: close");
  client.println("Accept: application/json");
  if (auth && ioboxKey.length() > 0) {
    client.print("Authorization: Bearer ");
    client.println(ioboxKey);
  }
  if (strcmp(method, "POST") == 0) {
    client.println("Content-Type: application/json");
    client.print("Content-Length: ");
    client.println(payload.length());
  }
  client.println();
  if (payload.length() > 0) client.print(payload);

  uint32_t start = millis();
  while (!client.available() && client.connected() && millis() - start < 8000) delay(5);
  String status = client.readStringUntil('\n');
  if (!status.startsWith("HTTP/1.1 2") && !status.startsWith("HTTP/1.0 2")) {
    report("Server HTTP error: " + status.substring(0, 12));
    client.stop();
    return false;
  }
  start = millis();
  while (client.connected()) {
    if (millis() - start > 10000) { client.stop(); report("Response headers timed out"); return false; }
    String line = client.readStringUntil('\n');
    if (line == "\r" || line.length() == 0) break;
  }
  body = "";
  start = millis();
  while (client.connected() || client.available()) {
    while (client.available()) {
      if (body.length() >= 16384) { client.stop(); report("Response too large"); return false; }
      body += static_cast<char>(client.read());
    }
    if (millis() - start > 10000) { client.stop(); report("Response timed out"); return false; }
    delay(1);
  }
  client.stop();
  return true;
}
#endif

bool httpJson(const char *method, const String &url, const JsonDocument *body, JsonDocument &out,
              bf::HttpTarget target = bf::HttpTarget::Server) {
  // Scope is explicit: enrollment JSON is secret-bearing even without a bearer
  // header. Enforce parsed HTTPS origins before serialization or either transport.
  if (!allowRequest(url, target)) {
    report("Request blocked: server credentials require the configured HTTPS origin (identity retained)");
    return false;
  }
  const bool auth = target == bf::HttpTarget::Server;
  String payload;
  if (body) serializeJson(*body, payload);

#if BF_ETHERNET_VARIANT
  if (mode == NetMode::Ethernet) {
    String response;
    if (!ethernetHttpBody(method, url, payload, response, auth)) return false;
    if (response.length() == 0) return true;
    return deserializeJson(out, response) == DeserializationError::Ok;
  }
#endif

  if (url.startsWith("https://") && !tlsReady()) return false;
  HTTPClient http;
  http.setTimeout(8000);
  http.setConnectTimeout(8000);
  bool began = url.startsWith("https://") ? http.begin(wifiSecureClient, url) : http.begin(wifiClient, url);
  if (!began) return false;
  http.addHeader("Content-Type", "application/json");
  if (auth && ioboxKey.length() > 0) {
    http.addHeader("Authorization", "Bearer " + ioboxKey);
  }

  int code = 0;
  if (strcmp(method, "GET") == 0) code = http.GET();
  else if (strcmp(method, "POST") == 0) code = http.POST(payload);
  else {
    http.end();
    return false;
  }

  if (code < 200 || code >= 300) {
    report("Server request failed (HTTP " + String(code) + "); retrying with saved identity");
    http.end();
    return false;
  }

  String response = http.getString();
  http.end();
  if (response.length() == 0) return true;
  return deserializeJson(out, response) == DeserializationError::Ok;
}

#if BF_ETHERNET_VARIANT
bool beginEthernet() {
  WiFi.mode(WIFI_OFF);
  SPI.begin(BF_ETH_SPI_SCK_PIN, BF_ETH_SPI_MISO_PIN, BF_ETH_SPI_MOSI_PIN, BF_ETH_CS_PIN);
  Ethernet.init(BF_ETH_CS_PIN);
  uint8_t mac[6];
  uint64_t chipMac = ESP.getEfuseMac();
  mac[0] = 0x02;
  mac[1] = 0xBF;
  mac[2] = 0x10;
  mac[3] = static_cast<uint8_t>(chipMac >> 16);
  mac[4] = static_cast<uint8_t>(chipMac >> 8);
  mac[5] = static_cast<uint8_t>(chipMac);
  Ethernet.begin(mac);

  uint32_t start = millis();
  while (millis() - start < 12000) {
    if (Ethernet.linkStatus() == LinkON && Ethernet.localIP() != IPAddress(0, 0, 0, 0)) return true;
    delay(100);
  }
  return false;
}
#endif

bool beginWifiSta() {
  String ssid = prefString("wifi_ssid");
  String pass = prefString("wifi_pass");
  if (ssid.length() == 0) return false;

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), pass.c_str());
  uint32_t start = millis();
  while (millis() - start < 15000) {
    if (WiFi.status() == WL_CONNECTED) return true;
    delay(100);
  }
  return false;
}

void renderPortal(const String &message = "") {
  String html = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>";
  html += "<title>BetterFrame ioBOX</title></head><body><h1>BetterFrame ioBOX</h1>";
  if (message.length()) html += "<p>" + message + "</p>";
  html += "<p>Serial: <code>" + serialNumber + "</code></p>";
  html += "<form method='post' action='/save'>";
  html += "<label>Server URL <input name='server' value='" + serverUrl + "'></label><br>";
  html += "<label>Wi-Fi SSID <input name='ssid'></label><br>";
  html += "<label>Wi-Fi Password <input name='pass' type='password'></label><br>";
  html += "<button type='submit'>Save</button></form></body></html>";
  portal.send(200, "text/html", html);
}

void startProvisioningPortal() {
  WiFi.mode(WIFI_AP);
  String apName = "BetterFrame-ioBOX-" + serialNumber.substring(serialNumber.length() - 6);
  WiFi.softAP(apName.c_str());
  portal.on("/", HTTP_GET, []() { renderPortal(); });
  portal.on("/save", HTTP_POST, []() {
    String nextServer = portal.arg("server");
    String ssid = portal.arg("ssid");
    String pass = portal.arg("pass");
    if (nextServer.length() > 0) saveString("server", nextServer);
    if (ssid.length() > 0) {
      saveString("wifi_ssid", ssid);
      saveString("wifi_pass", pass);
      storeMode(NetMode::WifiSta);
      portal.send(200, "text/html", "<p>Saved. Restarting.</p>");
      delay(800);
      ESP.restart();
      return;
    }
    renderPortal("SSID is required.");
  });
  portal.begin();

  uint32_t start = millis();
  while (millis() - start < BF_AP_TIMEOUT_MS) {
    portal.handleClient();
    setLed((millis() / 250) % 2 == 0);
    delay(5);
  }
  portal.stop();
  WiFi.softAPdisconnect(true);
}

void chooseNetworkAtBoot() {
  mode = loadMode();
  if (mode == NetMode::Ethernet) {
#if BF_ETHERNET_VARIANT
    networkUp = beginEthernet();
#else
    networkUp = false;
#endif
    return;
  }

  if (mode == NetMode::WifiSta) {
    networkUp = beginWifiSta();
    return;
  }

#if BF_ETHERNET_VARIANT
  if (beginEthernet()) {
    storeMode(NetMode::Ethernet);
    networkUp = true;
    return;
  }
#endif

  startProvisioningPortal();
  networkUp = false;
}

void maintainSelectedNetwork() {
  if (mode == NetMode::WifiSta) {
    if (WiFi.status() != WL_CONNECTED) {
      networkUp = false;
      WiFi.reconnect();
    } else {
      networkUp = true;
    }
  }

#if BF_ETHERNET_VARIANT
  if (mode == NetMode::Ethernet) {
    Ethernet.maintain();
    networkUp = Ethernet.linkStatus() == LinkON && Ethernet.localIP() != IPAddress(0, 0, 0, 0);
  }
#endif
}

void acknowledgeClaim() {
  if (!claimAckPending || ioboxKey.isEmpty()) return;
  JsonDocument body, response;
  body["serial"] = serialNumber;
  body["provisioning_secret"] = provisioningSecret;
  if (httpJson("POST", joinUrl(serverUrl, "/api/iobox/pair/ack"), &body, response)) {
    saveIdentity(ioboxId, ioboxKey, false);
  }
}

void announceOrClaim() {
  if (identityBlocked) return;
  if (!ioboxKey.isEmpty()) { paired = true; acknowledgeClaim(); return; }
  if (provisioningSecret.isEmpty()) {
    uint8_t random[32];
    // Ethernet disables Wi-Fi; explicitly enable the hardware entropy source.
    if (mode == NetMode::Ethernet) bootloader_random_enable();
    esp_fill_random(random, sizeof(random));
    if (mode == NetMode::Ethernet) bootloader_random_disable();
    String nextSecret = sha256Hex(random);
    if (!saveString("claim_secret", nextSecret)) {
      report("Cannot persist pairing secret; check NVS storage");
      return;
    }
    provisioningSecret = nextSecret;
  }
  JsonDocument body, response;
  body["serial"] = serialNumber;
  body["provisioning_secret"] = provisioningSecret;
  body["model_hint"] = modelId;
  body["firmware_version"] = BF_IOBOX_FW_VERSION;
  body["firmware_arch"] = "esp32s3";
  body["network_mode"] = modeName(mode);
  if (!httpJson("POST", joinUrl(serverUrl, "/api/iobox/announce"), &body, response, bf::HttpTarget::Enrollment)) return;
  const char *status = response["status"] | "";
  if (strcmp(status, "unknown_serial") == 0) { report("Serial not registered; waiting for administrator"); return; }
  if (response["model_id"].is<const char *>()) modelId = String(response["model_id"].as<const char *>());
  JsonDocument claim, claimResponse;
  claim["serial"] = serialNumber;
  claim["provisioning_secret"] = provisioningSecret;
  claim["firmware_version"] = BF_IOBOX_FW_VERSION;
  claim["network_mode"] = modeName(mode);
  if (!httpJson("POST", joinUrl(serverUrl, "/api/iobox/pair/claim"), &claim, claimResponse, bf::HttpTarget::Enrollment)) return;
  String id = String(claimResponse["iobox_id"] | "");
  String key = String(claimResponse["iobox_key"] | "");
  if (saveIdentity(id, key, true)) {
    report("Paired; identity stored, waiting for configuration");
    acknowledgeClaim();
  }
}

void heartbeat() {
  acknowledgeClaim();
  StaticJsonDocument<512> body;
  body["firmware_version"] = BF_IOBOX_FW_VERSION;
  body["network_mode"] = modeName(mode);
  body["ip"] =
#if BF_ETHERNET_VARIANT
      mode == NetMode::Ethernet ? Ethernet.localIP().toString() :
#endif
                                WiFi.localIP().toString();

  StaticJsonDocument<512> response;
  httpJson("POST", joinUrl(serverUrl, "/api/iobox/heartbeat"), &body, response);
}

void pullConfig() {
  StaticJsonDocument<2048> response;
  if (!httpJson("GET", joinUrl(serverUrl, "/api/iobox/config"), nullptr, response)) return;

  JsonObject display = response["assigned_display"];
  assignedDisplayId = String(display["id"] | "");
  JsonObject localTarget = response["local_target"];
  assignedKioskLocalKey = String(localTarget["local_key"] | "");

  JsonArray candidates = localTarget["candidates"].as<JsonArray>();
  assignedKioskIp = "";
  assignedKioskPort = 18090;
  for (JsonObject candidate : candidates) {
    assignedKioskIp = String(candidate["ip"] | "");
    assignedKioskPort = candidate["port"] | 18090;
    if (assignedKioskIp.length() > 0) break;
  }
  ioMappings.clear();
  ioMappings["items"] = response["mappings"];
}

bool checkLocalKiosk() {
  if (assignedKioskIp.length() == 0 || assignedKioskLocalKey.length() == 0) return false;
  StaticJsonDocument<256> response;
  String url = "http://" + assignedKioskIp + ":" + String(assignedKioskPort) + "/local/iobox/check?key=" + assignedKioskLocalKey;
  return httpJson("GET", url, nullptr, response, bf::HttpTarget::LocalKiosk);
}

bool postEventToLocalKiosk(JsonDocument &event) {
  if (!localKioskReachable) return false;
  String url = "http://" + assignedKioskIp + ":" + String(assignedKioskPort) + "/local/iobox/event?key=" + assignedKioskLocalKey;
  StaticJsonDocument<256> response;
  return httpJson("POST", url, &event, response, bf::HttpTarget::LocalKiosk);
}

void postEventToServer(JsonDocument &event, const char *route) {
  event["route"] = route;
  StaticJsonDocument<512> response;
  httpJson("POST", joinUrl(serverUrl, "/api/iobox/event"), &event, response);
}

bool jsonValueMatches(JsonVariant actual, JsonVariant expected) {
  String actualText;
  String expectedText;
  serializeJson(actual, actualText);
  serializeJson(expected, expectedText);
  return actualText == expectedText;
}

bool mappingMatchesEvent(JsonObject mapping, JsonDocument &event) {
  const char *sourceKind = mapping["source_kind"] | "";
  const char *kind = event["kind"] | "";
  if (strcmp(sourceKind, kind) != 0) return false;
  JsonObject match = mapping["match_json"].as<JsonObject>();
  JsonObject payload = event["payload"].as<JsonObject>();
  for (JsonPair kv : match) {
    JsonVariant actual = event[kv.key().c_str()];
    if (actual.isNull()) actual = payload[kv.key().c_str()];
    if (!jsonValueMatches(actual, kv.value())) return false;
  }
  return true;
}

bool runLocalMapping(JsonObject mapping) {
  const char *action = mapping["action"] | "";
  JsonObject params = mapping["params_json"].as<JsonObject>();
  if (strcmp(action, "layout.switch") == 0) {
    const char *layoutId = params["layout_id"] | "";
    if (assignedKioskIp.length() == 0 || assignedKioskLocalKey.length() == 0 || strlen(layoutId) == 0) return false;
    String url = "http://" + assignedKioskIp + ":" + String(assignedKioskPort) + "/local/layout/" + String(layoutId) + "?key=" + assignedKioskLocalKey;
    StaticJsonDocument<256> response;
    return httpJson("GET", url, nullptr, response, bf::HttpTarget::LocalKiosk);
  }
  return false;
}

bool runLocalMappings(JsonDocument &event) {
  JsonArray items = ioMappings["items"].as<JsonArray>();
  bool handled = false;
  for (JsonObject mapping : items) {
    if (!mapping["enabled"].isNull() && !mapping["enabled"].as<bool>()) continue;
    if (!mappingMatchesEvent(mapping, event)) continue;
    handled = runLocalMapping(mapping) || handled;
  }
  return handled;
}

void emitIoEvent(const char *kind, JsonObject payload) {
  StaticJsonDocument<768> event;
  char eventId[40];
  snprintf(eventId, sizeof(eventId), "%s-%lu", serialNumber.c_str(), static_cast<unsigned long>(++eventSeq));
  event["event_id"] = eventId;
  event["kind"] = kind;
  event["display_id"] = assignedDisplayId;
  event["occurred_at_ms"] = static_cast<uint32_t>(millis());
  event["payload"] = payload;
  if (payload["action"].is<const char *>()) event["action"] = payload["action"];
  if (payload["code"].is<const char *>()) event["code"] = payload["code"];
  if (!payload["value"].isNull()) event["value"] = payload["value"];

  bool localHandled = localKioskReachable && runLocalMappings(event);
  if (localHandled) event["local_handled"] = true;

  if (localKioskReachable && postEventToLocalKiosk(event)) {
    postEventToServer(event, "direct");
  } else {
    postEventToServer(event, "proxy");
  }
}

void pollHardware() {
#if BF_PIR_PIN >= 0
  int pir = digitalRead(BF_PIR_PIN);
  if (lastPirState != -1 && pir != lastPirState) {
    StaticJsonDocument<128> payload;
    payload["state"] = pir == HIGH ? "present" : "clear";
    emitIoEvent("presence", payload.as<JsonObject>());
  }
  lastPirState = pir;
#endif

#if BF_BUTTON_PIN >= 0
  int button = digitalRead(BF_BUTTON_PIN);
  if (lastButtonState != -1 && button != lastButtonState) {
    StaticJsonDocument<128> payload;
    payload["code"] = "button_1";
    payload["state"] = button == LOW ? "down" : "up";
    emitIoEvent("button", payload.as<JsonObject>());
  }
  lastButtonState = button;
#endif

#if BF_RS485_RX_PIN >= 0 && BF_RS485_TX_PIN >= 0
  while (Serial1.available() > 0) {
    char ch = static_cast<char>(Serial1.read());
    if (ch == '\r') continue;
    if (ch == '\n') {
      String raw = rs485Line;
      raw.trim();
      rs485Line = "";
      if (raw.length() > 0) {
        StaticJsonDocument<256> payload;
        payload["raw"] = raw;
        payload["code"] = raw;
        emitIoEvent("rs485", payload.as<JsonObject>());
      }
    } else if (rs485Line.length() < 180) {
      rs485Line += ch;
    } else {
      rs485Line = "";
    }
  }
#endif

  // USB HID host and binary RS485/Pelco decoders should normalize input into
  // emitIoEvent("keyboard" | "mouse" | "joystick" | "rs485", payload).
}

void otaCheck() {
  StaticJsonDocument<512> response;
  String url = joinUrl(serverUrl, "/api/iobox/firmware/check?current=" BF_IOBOX_FW_VERSION "&arch=esp32s3&model_id=") + modelId;
  if (!httpJson("GET", url, nullptr, response)) return;
  if (response["up_to_date"] | true) return;

  String downloadUrl = String(response["download_url"] | "");
  String version = String(response["version"] | "");
  String expectedSha = String(response["sha256"] | "");
  String signature = String(response["signature"] | "");
  if (signature.isEmpty() || strlen(BF_OTA_PUBLIC_KEY_HEX) == 0) {
    report("OTA deferred: firmware signature or embedded signing key missing");
    return;
  }
  String absolute = downloadUrl.startsWith("http") ? downloadUrl : joinUrl(serverUrl, downloadUrl.c_str());
  if (!allowRequest(absolute) || !tlsReady()) {
    report("OTA rejected: download must use the configured HTTPS origin");
    return;
  }

  bool ok = false;
  String otaError;
#if BF_ETHERNET_VARIANT
  if (mode == NetMode::Ethernet) {
    ParsedUrl parsed;
    if (parseUrl(absolute, parsed) && ethSecureClient.connect(parsed.host.c_str(), parsed.port)) {
      ethSecureClient.print("GET ");
      ethSecureClient.print(parsed.path);
      ethSecureClient.println(" HTTP/1.0");
      ethSecureClient.print("Host: ");
      ethSecureClient.println(parsed.host);
      ethSecureClient.println("Connection: close");
      if (ioboxKey.length() > 0) {
        ethSecureClient.print("Authorization: Bearer ");
        ethSecureClient.println(ioboxKey);
      }
      ethSecureClient.println("");

      uint32_t start = millis();
      while (!ethSecureClient.available() && ethSecureClient.connected() && millis() - start < 8000) delay(5);
      String status = ethSecureClient.readStringUntil('\n');
      int contentLength = UPDATE_SIZE_UNKNOWN;
      bool statusOk = status.startsWith("HTTP/1.1 2") || status.startsWith("HTTP/1.0 2");
      start = millis();
      while (ethSecureClient.connected()) {
        if (millis() - start > 10000) { statusOk = false; break; }
        String line = ethSecureClient.readStringUntil('\n');
        String headerName = line.substring(0, line.indexOf(':'));
        if (headerName.equalsIgnoreCase("Content-Length")) contentLength = line.substring(15).toInt();
        if (line == "\r" || line.length() == 0) break;
      }
      if (statusOk) {
        ok = streamUpdateWithSha(ethSecureClient, contentLength, expectedSha, signature, otaError);
      } else {
        otaError = "download http error";
      }
      ethSecureClient.stop();
    }
  } else
#endif
  {
  HTTPClient http;
  http.setTimeout(15000);
  http.setConnectTimeout(8000);
  bool began = absolute.startsWith("https://") ? http.begin(wifiSecureClient, absolute) : http.begin(wifiClient, absolute);
  if (!began) return;
  if (ioboxKey.length() > 0) http.addHeader("Authorization", "Bearer " + ioboxKey);
  int code = http.GET();
  if (code != 200) {
    http.end();
    return;
  }

  int len = http.getSize();
  WiFiClient *stream = http.getStreamPtr();
  ok = streamUpdateWithSha(*stream, len, expectedSha, signature, otaError);
  http.end();
  }

  StaticJsonDocument<256> applied;
  applied["version"] = version;
  if (!ok) applied["error"] = otaError.length() > 0 ? otaError : Update.errorString();
  StaticJsonDocument<256> appliedResponse;
  httpJson("POST", joinUrl(serverUrl, "/api/iobox/firmware/applied"), &applied, appliedResponse);
  if (ok) ESP.restart();
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(100);

#if BF_STATUS_LED_PIN >= 0
  pinMode(BF_STATUS_LED_PIN, OUTPUT);
#endif
#if BF_PIR_PIN >= 0
  pinMode(BF_PIR_PIN, INPUT);
#endif
#if BF_BUTTON_PIN >= 0
  pinMode(BF_BUTTON_PIN, INPUT_PULLUP);
#endif
#if BF_RS485_RX_PIN >= 0 && BF_RS485_TX_PIN >= 0
  Serial1.begin(9600, SERIAL_8N1, BF_RS485_RX_PIN, BF_RS485_TX_PIN);
#if BF_RS485_DE_PIN >= 0
  pinMode(BF_RS485_DE_PIN, OUTPUT);
  digitalWrite(BF_RS485_DE_PIN, LOW);
#endif
#endif

  prefs.begin("bf-iobox", false);
  wifiSecureClient.setCACert(BF_TLS_CA_PEM);
  wifiSecureClient.setHandshakeTimeout(15);
#if BF_ETHERNET_VARIANT
  ethSecureClient.setClient(&ethClient);
  ethSecureClient.setCACert(BF_TLS_CA_PEM);
  ethSecureClient.setTimeout(8); // ESP_SSLClient takes seconds, unlike Stream.
  ethSecureClient.setHandshakeTimeout(15);
#endif
  serialNumber = prefString("serial");
  if (serialNumber.length() == 0) {
    serialNumber = macSerial();
    saveString("serial", serialNumber);
  }
  serverUrl = prefString("server", BF_DEFAULT_SERVER_URL);
  provisioningSecret = prefString("claim_secret");
  String storedIdentity = prefString("identity");
  if (!storedIdentity.isEmpty()) {
    JsonDocument identity;
    if (deserializeJson(identity, storedIdentity) == DeserializationError::Ok && identity["version"] == 1 &&
        identity["server"].as<String>() == serverUrl && !identity["id"].as<String>().isEmpty() &&
        !identity["key"].as<String>().isEmpty()) {
      ioboxId = identity["id"].as<String>();
      ioboxKey = identity["key"].as<String>();
      claimAckPending = identity["ack_pending"] | false;
      paired = true;
    } else {
      report("Saved identity invalid or server changed; local service required (identity retained)");
      identityBlocked = true;
    }
  } else {
    String legacyId = prefString("iobox_id");
    String legacyKey = prefString("iobox_key");
    if (!legacyId.isEmpty() && !legacyKey.isEmpty()) {
      if (!saveIdentity(legacyId, legacyKey, false)) identityBlocked = true;
    } else if (!legacyId.isEmpty() || !legacyKey.isEmpty()) {
      identityBlocked = true;
      report("Incomplete legacy identity; administrator must recover enrollment (identity retained)");
    }
  }
  modelId = prefString("model_id", BF_MODEL_HINT);

  chooseNetworkAtBoot();
  if (networkUp) {
    syncNetworkTime();
    announceOrClaim();
    if (paired) {
      heartbeat();
      pullConfig();
      localKioskReachable = checkLocalKiosk();
    }
  }
}

void loop() {
  maintainSelectedNetwork();
  static uint32_t lastTimeAttempt = 0;
  if (networkUp && time(nullptr) < 1704067200 && millis() - lastTimeAttempt > 30000) {
    lastTimeAttempt = millis();
    syncNetworkTime();
  }
  setLed(networkUp && paired ? true : (millis() / 500) % 2);
  if (!networkUp || !paired) {
    delay(3000);
    if (networkUp && !paired) announceOrClaim();
    return;
  }

  uint32_t now = millis();
  if (now - lastHeartbeatMs > 30000) {
    lastHeartbeatMs = now;
    heartbeat();
  }
  if (now - lastConfigMs > 60000) {
    lastConfigMs = now;
    pullConfig();
    localKioskReachable = checkLocalKiosk();
  }
  if (now - lastOtaCheckMs > 300000) {
    lastOtaCheckMs = now;
    otaCheck();
  }
  if (now - lastHardwarePollMs > 25) {
    lastHardwarePollMs = now;
    pollHardware();
  }
  delay(5);
}
