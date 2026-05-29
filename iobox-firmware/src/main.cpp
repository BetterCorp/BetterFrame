#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <Update.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <mbedtls/sha256.h>

#if BF_ETHERNET_VARIANT
#include <Ethernet.h>
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

void saveString(const char *key, const String &value) {
  prefs.putString(key, value);
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
  out.https = url.startsWith("https://");
  int schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) return false;
  int hostStart = schemeEnd + 3;
  int pathStart = url.indexOf('/', hostStart);
  String hostPort = pathStart >= 0 ? url.substring(hostStart, pathStart) : url.substring(hostStart);
  out.path = pathStart >= 0 ? url.substring(pathStart) : "/";
  int colon = hostPort.lastIndexOf(':');
  out.port = out.https ? 443 : 80;
  if (colon > 0) {
    out.host = hostPort.substring(0, colon);
    out.port = static_cast<uint16_t>(hostPort.substring(colon + 1).toInt());
  } else {
    out.host = hostPort;
  }
  return out.host.length() > 0;
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

bool streamUpdateWithSha(Client &client, int contentLength, const String &expectedSha, String &error) {
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
  while ((knownSize && total < static_cast<size_t>(contentLength)) || (!knownSize && (client.connected() || client.available()))) {
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
  if (!Update.end()) {
    error = Update.errorString();
    return false;
  }
  return true;
}

#if BF_ETHERNET_VARIANT
bool ethernetHttpBody(const char *method, const String &url, const String &payload, String &body, bool auth = true) {
  ParsedUrl parsed;
  if (!parseUrl(url, parsed) || parsed.https) return false;
  if (!ethClient.connect(parsed.host.c_str(), parsed.port)) return false;

  ethClient.print(method);
  ethClient.print(" ");
  ethClient.print(parsed.path);
  ethClient.println(" HTTP/1.1");
  ethClient.print("Host: ");
  ethClient.println(parsed.host);
  ethClient.println("Connection: close");
  ethClient.println("Accept: application/json");
  if (auth && ioboxKey.length() > 0) {
    ethClient.print("Authorization: Bearer ");
    ethClient.println(ioboxKey);
  }
  if (strcmp(method, "POST") == 0) {
    ethClient.println("Content-Type: application/json");
    ethClient.print("Content-Length: ");
    ethClient.println(payload.length());
  }
  ethClient.println();
  if (payload.length() > 0) ethClient.print(payload);

  uint32_t start = millis();
  while (!ethClient.available() && ethClient.connected() && millis() - start < 8000) delay(5);
  String status = ethClient.readStringUntil('\n');
  if (!status.startsWith("HTTP/1.1 2") && !status.startsWith("HTTP/1.0 2")) {
    ethClient.stop();
    return false;
  }
  while (ethClient.connected()) {
    String line = ethClient.readStringUntil('\n');
    if (line == "\r" || line.length() == 0) break;
  }
  body = "";
  start = millis();
  while (ethClient.connected() || ethClient.available()) {
    while (ethClient.available()) body += static_cast<char>(ethClient.read());
    if (millis() - start > 10000) break;
    delay(1);
  }
  ethClient.stop();
  return true;
}
#endif

bool httpJson(const char *method, const String &url, const JsonDocument *body, JsonDocument &out, bool auth = true) {
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

  HTTPClient http;
  http.setTimeout(8000);
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

void announceOrClaim() {
  StaticJsonDocument<512> body;
  body["serial"] = serialNumber;
  body["model_hint"] = modelId;
  body["firmware_version"] = BF_IOBOX_FW_VERSION;
  body["firmware_arch"] = "esp32s3";
  body["network_mode"] = modeName(mode);

  StaticJsonDocument<1024> response;
  if (!httpJson("POST", joinUrl(serverUrl, "/api/iobox/announce"), &body, response, false)) return;

  const char *status = response["status"] | "";
  if (strcmp(status, "unknown_serial") == 0) return;
  if (response["model_id"].is<const char *>()) modelId = String(response["model_id"].as<const char *>());

  if (ioboxKey.length() > 0) {
    paired = true;
    return;
  }

  StaticJsonDocument<512> claim;
  claim["serial"] = serialNumber;
  claim["firmware_version"] = BF_IOBOX_FW_VERSION;
  claim["network_mode"] = modeName(mode);
  StaticJsonDocument<1024> claimResponse;
  if (httpJson("POST", joinUrl(serverUrl, "/api/iobox/pair/claim"), &claim, claimResponse, false)) {
    ioboxId = String(claimResponse["iobox_id"] | "");
    ioboxKey = String(claimResponse["iobox_key"] | "");
    if (ioboxKey.length() > 0) {
      saveString("iobox_id", ioboxId);
      saveString("iobox_key", ioboxKey);
      paired = true;
    }
  }
}

void heartbeat() {
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
  return httpJson("GET", url, nullptr, response, false);
}

bool postEventToLocalKiosk(JsonDocument &event) {
  if (!localKioskReachable) return false;
  String url = "http://" + assignedKioskIp + ":" + String(assignedKioskPort) + "/local/iobox/event?key=" + assignedKioskLocalKey;
  StaticJsonDocument<256> response;
  return httpJson("POST", url, &event, response, false);
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
    return httpJson("GET", url, nullptr, response, false);
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
  String absolute = downloadUrl.startsWith("http") ? downloadUrl : joinUrl(serverUrl, downloadUrl.c_str());
  if (absolute.length() == 0) return;

  bool ok = false;
  String otaError;
#if BF_ETHERNET_VARIANT
  if (mode == NetMode::Ethernet) {
    ParsedUrl parsed;
    if (parseUrl(absolute, parsed) && !parsed.https && ethClient.connect(parsed.host.c_str(), parsed.port)) {
      ethClient.print("GET ");
      ethClient.print(parsed.path);
      ethClient.println(" HTTP/1.1");
      ethClient.print("Host: ");
      ethClient.println(parsed.host);
      ethClient.println("Connection: close");
      if (ioboxKey.length() > 0) {
        ethClient.print("Authorization: Bearer ");
        ethClient.println(ioboxKey);
      }
      ethClient.println();

      uint32_t start = millis();
      while (!ethClient.available() && ethClient.connected() && millis() - start < 8000) delay(5);
      String status = ethClient.readStringUntil('\n');
      int contentLength = UPDATE_SIZE_UNKNOWN;
      bool statusOk = status.startsWith("HTTP/1.1 2") || status.startsWith("HTTP/1.0 2");
      while (ethClient.connected()) {
        String line = ethClient.readStringUntil('\n');
        if (line.startsWith("Content-Length:")) contentLength = line.substring(15).toInt();
        if (line == "\r" || line.length() == 0) break;
      }
      if (statusOk) {
        ok = streamUpdateWithSha(ethClient, contentLength, expectedSha, otaError);
      } else {
        otaError = "download http error";
      }
      ethClient.stop();
    }
  } else
#endif
  {
  HTTPClient http;
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
  ok = streamUpdateWithSha(*stream, len, expectedSha, otaError);
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
  wifiSecureClient.setInsecure();
  serialNumber = prefString("serial");
  if (serialNumber.length() == 0) {
    serialNumber = macSerial();
    saveString("serial", serialNumber);
  }
  serverUrl = prefString("server", BF_DEFAULT_SERVER_URL);
  ioboxId = prefString("iobox_id");
  ioboxKey = prefString("iobox_key");
  modelId = prefString("model_id", BF_MODEL_HINT);

  chooseNetworkAtBoot();
  if (networkUp) {
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
  setLed(networkUp);
  if (!networkUp || !paired) {
    delay(1000);
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
