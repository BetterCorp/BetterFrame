#include "http_policy.h"
#include <cstdio>
#include <cstdlib>

static void expect(bool actual, bool expected, const char *name) {
  if (actual != expected) {
    std::fprintf(stderr, "HTTP policy failed: %s\n", name);
    std::exit(1);
  }
}

int main() {
  using bf::HttpTarget;
  // A trailing slash on the stored origin must never disable the guard. Both
  // bearer-authenticated traffic and enrollment bodies contain credentials.
  for (auto target : {HttpTarget::Server, HttpTarget::Enrollment}) {
    for (const char *configured : {"http://host", "http://host/", "http://host///", "http://host/base/"}) {
      expect(bf::allowHttpRequest(configured, "http://host/api/iobox/pair/claim", target), false,
             "HTTP configured origin (with/without trailing slashes)");
      expect(bf::allowHttpRequest(configured, "https://host/api/iobox/pair/claim", target), false,
             "an insecure configuration is not silently upgraded");
    }
    for (const char *configured : {"https://host", "https://host/", "https://host///", "https://host/base/"}) {
      expect(bf::allowHttpRequest(configured, "https://host/api/iobox/pair/claim", target), true,
             "HTTPS origin supports trailing slash and base path");
      expect(bf::allowHttpRequest(configured, "http://host/api/iobox/pair/claim", target), false,
             "scheme downgrade rejected");
      expect(bf::allowHttpRequest(configured, "https://host.attacker/api/iobox/pair/claim", target), false,
             "hostname prefix is not origin equality");
      expect(bf::allowHttpRequest(configured, "https://host:444/api/iobox/pair/claim", target), false,
             "different port rejected");
    }
    const std::string nulAuthority = std::string("https://host") + '\0' + "@attacker/api";
    expect(bf::allowHttpRequest("https://host/", nulAuthority, target), false,
           "embedded NUL request authority rejected");
    expect(bf::allowHttpRequest(nulAuthority, "https://host/api", target), false,
           "embedded NUL configured authority rejected");
    expect(bf::allowHttpRequest("https://HOST/", "https://host:443/api", target), true,
           "canonical DNS case and effective HTTPS port");
    expect(bf::allowHttpRequest("https://host:8443/", "https://host:8443/api", target), true,
           "explicit configured TLS port");
    for (const char *request : {"https://host@attacker/api", "https://host\\@attacker/api",
         "https://host:65536/api", "https://host:443x/api", "https://host:/api",
         "https://host/api\r\nAuthorization: secret", "https://host/%20#fragment", "//host/api"}) {
      expect(bf::allowHttpRequest("https://host/", request, target), false,
             "ambiguous/malformed URL rejected");
    }
  }
  expect(bf::allowHttpRequest("https://host/", "http://192.0.2.1:18090/local/iobox/check?key=local",
         HttpTarget::LocalKiosk), true, "explicit local kiosk LAN compatibility");
  expect(bf::allowHttpRequest("http://host/", "http://host/api/iobox/pair/claim", HttpTarget::LocalKiosk),
         false, "server enrollment cannot masquerade as local kiosk path");
  expect(bf::allowHttpRequest("https://host/", "http://192.0.2.1:18090/local/iobox/check?key=local"),
         false, "default credential-bearing target cannot use LAN exception");
  std::puts("HTTP request policy: enrollment and bearer credentials stay on the configured HTTPS origin");
}
