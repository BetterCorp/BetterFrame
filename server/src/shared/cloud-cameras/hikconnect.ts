/**
 * Hik-Connect (Hikvision cloud) integration.
 *
 * Hikvision cloud API at api.hik-connect.com. Auth via username/password
 * → access token. Device list returns serials, names, online status.
 * Streaming: request HLS preview URL via /v3/open/devices/:serial/previewURLs.
 * URLs are session-based and expire — kiosk must refresh via server API.
 *
 * All auth on server — kiosk only gets HLS URLs in the bundle.
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
      const cameras: CloudCamera[] = [];

      for (const d of devices) {
        const serial = d.deviceSerial ?? d.serial ?? String(d.id);
        const streamUrl = await this.fetchPreviewUrl(this.apiBase(creds), token, serial);
        cameras.push({
          vendor_id: serial,
          name: d.deviceName ?? d.name ?? "Hikvision Camera",
          model: d.deviceModel ?? d.model ?? null,
          rtsp_url: null,
          relay_url: streamUrl,
          online: d.status === "online" || d.online === true,
          stream_type: streamUrl ? "hls" : null,
          extra: { serial, type: d.deviceType, local_ip: d.localIp ?? d.ip ?? null },
        });
      }
      return cameras;
    } catch {
      return [];
    }
  }

  async getStreamUrl(creds: Record<string, string>, vendorCameraId: string): Promise<string | null> {
    const token = await this.login(creds);
    if (!token) return null;
    return this.fetchPreviewUrl(this.apiBase(creds), token, vendorCameraId);
  }

  private async fetchPreviewUrl(base: string, token: string, serial: string): Promise<string | null> {
    try {
      const resp = await fetch(`${base}/v3/open/devices/${serial}/previewURLs`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ protocol: "hls", quality: 1 }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as any;
      return data?.data?.url ?? data?.url ?? null;
    } catch {
      return null;
    }
  }

  private apiBase(creds: Record<string, string>): string {
    const region = (creds["region"] ?? "eu").toLowerCase();
    if (region === "us") return "https://api.hik-connect.com";
    if (region === "ap") return "https://api.hik-connect.com";
    return API_BASE;
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
          featureCode: "deadbeef",
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
