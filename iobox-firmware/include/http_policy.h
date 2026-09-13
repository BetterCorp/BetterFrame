#pragma once
#include <cstdint>
#include <string>

namespace bf {

// Enrollment bodies carry a provisioning secret even though they have no bearer
// header. Only explicitly local kiosk calls may use the legacy LAN HTTP protocol.
enum class HttpTarget { Server, Enrollment, LocalKiosk };

struct HttpUrl {
  std::string host;
  std::string path;
  uint16_t port = 0;
  bool https = false;
};

inline bool parseHttpUrl(const std::string &url, HttpUrl &out) {
  size_t authorityStart;
  if (url.compare(0, 8, "https://") == 0) {
    authorityStart = 8;
    out.https = true;
  } else if (url.compare(0, 7, "http://") == 0) {
    authorityStart = 7;
    out.https = false;
  } else {
    return false;
  }
  // Reject inputs that HTTP clients can interpret differently, including URL
  // userinfo, fragments, backslashes, whitespace and control characters.
  for (unsigned char ch : url) {
    if (ch <= 0x20 || ch == 0x7f || ch == '\\' || ch == '#' || ch == '@') return false;
  }
  const size_t pathStart = url.find_first_of("/?", authorityStart);
  const std::string authority = url.substr(authorityStart, pathStart - authorityStart);
  const size_t colon = authority.find(':');
  out.host = authority.substr(0, colon);
  if (out.host.empty()) return false;
  // The W5500 implementation supports DNS names and IPv4, not IPv6 literals.
  for (char &ch : out.host) {
    if (ch >= 'A' && ch <= 'Z') ch += 'a' - 'A';
    if (!((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '.')) return false;
  }
  out.port = out.https ? 443 : 80;
  if (colon != std::string::npos) {
    const std::string port = authority.substr(colon + 1);
    if (port.empty() || port.size() > 5) return false;
    uint32_t value = 0;
    for (char ch : port) {
      if (ch < '0' || ch > '9') return false;
      value = value * 10 + (ch - '0');
    }
    if (value == 0 || value > 65535) return false;
    out.port = static_cast<uint16_t>(value);
  }
  out.path = pathStart == std::string::npos ? "/" : url.substr(pathStart);
  if (out.path.front() == '?') out.path.insert(0, "/");
  return true;
}

inline bool allowHttpRequest(const std::string &configuredServer, const std::string &requestUrl,
                             HttpTarget target = HttpTarget::Server) {
  HttpUrl request;
  if (!parseHttpUrl(requestUrl, request)) return false;
  if (target == HttpTarget::LocalKiosk) {
    return request.path.compare(0, 7, "/local/") == 0;
  }
  HttpUrl server;
  return parseHttpUrl(configuredServer, server) && server.https && request.https &&
         server.host == request.host && server.port == request.port;
}

} // namespace bf
