/**
 * Hik-Connect (Hikvision cloud) integration.
 *
 * Hikvision uses a proprietary cloud API at api.hik-connect.com.
 * Auth: username/password → session token. No public OAuth.
 * Camera list: GET /v3/userdevices/v1/devices/list
 * Streaming: cameras expose RTSP locally; cloud relay uses P2P via
 * Hik-Connect SDK (native, not web-friendly). For BetterFrame we
 * extract the device serial + verify credentials, then assume
 * local RTSP access (most Hik-Connect cameras are on the same LAN
 * as the kiosk). If not on LAN, need ISAPI relay.
 *
 * Auth keys stay on server — kiosk only gets RTSP URLs.
 */
import type { CloudCameraProvider, CloudCamera, CloudVendor } from "./types.js";

const API_BASE = "https://api.hik-connect.com";

export class HikConnectProvider implements CloudCameraProvider {
  vendor: CloudVendor = "hikconnect";

  credentialFields() {
    return [
      { name: "username", label: "Hik-Connect Email/Phone", type: "email" as const, required: true },
      { name: "password", label: "Password", type: "password" as const, required: true },
      { name: "region", label: "Region (eu/us/ap)", type: "text" as const, required: false },
    ];
  }

  async testCredentials(creds: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
    try {
      const token = await this.login(creds);
      return token ? { ok: true } : { ok: false, error: "Login failed" };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async listCameras(creds: Record<string, string>): Promise<CloudCamera[]> {
    const token = await this.login(creds);
    if (!token) return [];

    try {
      const resp = await fetch(`${this.apiBase(creds)}/v3/userdevices/v1/devices/list`, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      if (!resp.ok) return [];
      const data = await resp.json() as any;
      const devices = data?.data?.list ?? data?.deviceList ?? [];
      return devices.map((d: any) => ({
        vendor_id: d.deviceSerial ?? d.serial ?? String(d.id),
        name: d.deviceName ?? d.name ?? "Hikvision Camera",
        model: d.deviceModel ?? d.model ?? null,
        rtsp_url: null, // Hik-Connect doesn't expose RTSP URLs — local ONVIF needed
        relay_url: null,
        online: d.status === "online" || d.online === true,
        extra: { serial: d.deviceSerial, type: d.deviceType },
      }));
    } catch {
      return [];
    }
  }

  async getStreamUrl(creds: Record<string, string>, vendorCameraId: string): Promise<string | null> {
    // Hik-Connect uses P2P relay via native SDK — no direct RTSP from cloud.
    // Kiosk needs local ONVIF/RTSP access. Return null to signal "use local".
    return null;
  }

  private apiBase(creds: Record<string, string>): string {
    const region = (creds["region"] ?? "eu").toLowerCase();
    if (region === "us") return "https://api.hik-connect.com";
    if (region === "ap") return "https://api.hik-connect.com";
    return "https://api.hik-connect.com"; // EU is default
  }

  private async login(creds: Record<string, string>): Promise<string | null> {
    const { username, password } = creds;
    if (!username || !password) return null;

    try {
      const resp = await fetch(`${this.apiBase(creds)}/v3/users/login/v2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: username,
          password,
          featureCode: "deadbeef", // required by API
        }),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as any;
      return data?.data?.accessToken ?? data?.accessToken ?? null;
    } catch {
      return null;
    }
  }
}
