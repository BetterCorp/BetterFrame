/**
 * Pick the kiosk's preferred LAN IP for direct HTTP reach.
 *
 * Behind Docker/Angie the heartbeat source IP we see (kiosk.local_last_ip)
 * is the proxy/container bridge (e.g. 172.31.0.2), not the kiosk's real LAN
 * address. Kiosks report all their interfaces via the heartbeat
 * (network_interfaces_json from `ip -j addr show`). Prefer the first
 * non-loopback / non-link-local IP from that list; fall back to the
 * heartbeat source only when we have nothing reported.
 */
import type { Kiosk } from "./types.js";

interface ReportedInterface {
  name: string;
  mac?: string | null;
  operstate?: string | null;
  ips: string[];
}

function ipWithoutCidr(ip: string): string {
  return ip.includes("/") ? ip.slice(0, ip.indexOf("/")) : ip;
}

function isUsableLanIp(ip: string): boolean {
  const bare = ipWithoutCidr(ip);
  return bare !== "::1"
    && !bare.startsWith("127.")
    && !bare.startsWith("169.254.")
    && !bare.startsWith("fe80:");
}

function parseInterfaces(raw: string | null): ReportedInterface[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        name: typeof item?.name === "string" ? item.name : "unknown",
        operstate: typeof item?.operstate === "string" ? item.operstate : null,
        ips: Array.isArray(item?.ips)
          ? item.ips.filter((ip: unknown) => typeof ip === "string")
          : [],
      }))
      .filter((item) => item.ips.length > 0);
  } catch {
    return [];
  }
}

/** Returns a bare IP (no CIDR) suitable for `http://<ip>:<port>/...`. */
export function pickKioskLanIp(kiosk: Kiosk): string | null {
  const ifaces = parseInterfaces(kiosk.network_interfaces_json);
  // Prefer interfaces marked UP, then any with usable IPs.
  const sorted = [...ifaces].sort((a, b) => {
    const aUp = a.operstate?.toLowerCase() === "up" ? 0 : 1;
    const bUp = b.operstate?.toLowerCase() === "up" ? 0 : 1;
    return aUp - bUp;
  });
  for (const iface of sorted) {
    for (const ip of iface.ips) {
      if (isUsableLanIp(ip)) return ipWithoutCidr(ip);
    }
  }
  if (kiosk.local_last_ip && isUsableLanIp(kiosk.local_last_ip)) {
    return ipWithoutCidr(kiosk.local_last_ip);
  }
  return null;
}
