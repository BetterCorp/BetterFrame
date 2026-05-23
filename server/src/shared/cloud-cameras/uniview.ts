/**
 * Uniview (UNV) camera integration.
 *
 * UNV is ONVIF-first, local LAN architecture. Their "EZCloud" portal
 * has no public API. LightAPI (HTTP REST on the device) provides channel
 * enumeration. For BetterFrame: connect directly to NVR/camera via HTTP.
 *
 * RTSP: rtsp://user:pass@ip:554/media/video<channel>
 *
 * All auth on server — kiosk only gets RTSP URLs.
 */
import type { CloudCameraProvider, CloudCamera, CloudVendor } from "./types.js";

export class UniviewProvider implements CloudCameraProvider {
  vendor: CloudVendor = "uniview";

  credentialFields() {
    return [
      { name: "host", label: "Device IP/Host", type: "text" as const, required: true },
      { name: "port", label: "HTTP Port", type: "text" as const, required: false },
      { name: "username", label: "Username", type: "text" as const, required: true },
      { name: "password", label: "Password", type: "password" as const, required: true },
    ];
  }

  async testCredentials(creds: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
    try {
      const base = `http://${creds["host"]}:${creds["port"] ?? "80"}`;
      const resp = await fetch(`${base}/LAPI/V1.0/System/DeviceInfo`, {
        headers: this.authHeader(creds),
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok ? { ok: true } : { ok: false, error: `HTTP ${resp.status}` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async listCameras(creds: Record<string, string>): Promise<CloudCamera[]> {
    const base = `http://${creds["host"]}:${creds["port"] ?? "80"}`;
    const cameras: CloudCamera[] = [];

    try {
      const resp = await fetch(`${base}/LAPI/V1.0/Channels`, {
        headers: this.authHeader(creds),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return [];
      const data = await resp.json() as any;
      const channels = data?.Response?.Data?.ChannelList ?? [];
      for (const ch of channels) {
        const chId = ch.ID ?? ch.ChannelID ?? 1;
        cameras.push({
          vendor_id: `${creds["host"]}_ch${chId}`,
          name: ch.Name ?? `UNV Channel ${chId}`,
          model: null,
          rtsp_url: `rtsp://${creds["username"]}:${creds["password"]}@${creds["host"]}:554/media/video${chId}`,
          relay_url: null,
          online: ch.Online === true || ch.Status === "Online",
          extra: { channel_id: chId },
        });
      }
    } catch {
      // Fallback: assume single channel.
      cameras.push({
        vendor_id: `${creds["host"]}_ch1`,
        name: "UNV Camera",
        model: null,
        rtsp_url: `rtsp://${creds["username"]}:${creds["password"]}@${creds["host"]}:554/media/video1`,
        relay_url: null,
        online: true,
        extra: {},
      });
    }
    return cameras;
  }

  async getStreamUrl(creds: Record<string, string>, vendorCameraId: string): Promise<string | null> {
    const chMatch = vendorCameraId.match(/ch(\d+)$/);
    const ch = chMatch ? Number(chMatch[1]) : 1;
    return `rtsp://${creds["username"]}:${creds["password"]}@${creds["host"]}:554/media/video${ch}`;
  }

  private authHeader(creds: Record<string, string>): Record<string, string> {
    const basic = Buffer.from(`${creds["username"]}:${creds["password"]}`).toString("base64");
    return { "Authorization": `Basic ${basic}` };
  }
}
