/**
 * Dahua DMSS cloud camera integration.
 *
 * Dahua uses HTTP Digest auth against local NVR/DVR ISAPI endpoints.
 * DMSS is their cloud relay app — uses P2P tunneling, no public cloud API.
 * For BetterFrame: we connect to the device directly via ISAPI (HTTP)
 * to list channels + get RTSP URIs. Cloud relay requires Dahua partner SDK.
 *
 * RTSP format: rtsp://user:pass@ip/cam/realmonitor?channel=X&subtype=Y
 * where subtype=0 is main stream, subtype=1 is sub stream.
 *
 * All auth on server — kiosk only gets RTSP URLs.
 */
import type { CloudCameraProvider, CloudCamera, CloudVendor } from "./types.js";

export class DahuaProvider implements CloudCameraProvider {
  vendor: CloudVendor = "dahua";

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
      const base = this.baseUrl(creds);
      const resp = await fetch(`${base}/cgi-bin/magicBox.cgi?action=getDeviceType`, {
        headers: this.authHeader(creds),
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok ? { ok: true } : { ok: false, error: `HTTP ${resp.status}` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async listCameras(creds: Record<string, string>): Promise<CloudCamera[]> {
    const base = this.baseUrl(creds);
    const cameras: CloudCamera[] = [];

    try {
      // Get channel count from device.
      const resp = await fetch(`${base}/cgi-bin/magicBox.cgi?action=getProductDefinition`, {
        headers: this.authHeader(creds),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return [];
      const text = await resp.text();
      const channelMatch = text.match(/MaxChannel=(\d+)/);
      const channels = channelMatch ? Number(channelMatch[1]) : 1;

      for (let ch = 1; ch <= channels; ch++) {
        const rtspUrl = `rtsp://${creds["username"]}:${creds["password"]}@${creds["host"]}:${creds["rtsp_port"] ?? "554"}/cam/realmonitor?channel=${ch}&subtype=0`;
        cameras.push({
          vendor_id: `${creds["host"]}_ch${ch}`,
          name: `Dahua Channel ${ch}`,
          model: null,
          rtsp_url: rtspUrl,
          relay_url: null,
          online: true,
          stream_type: "rtsp",
          extra: { channel: ch },
        });
      }
    } catch {
      // Device unreachable.
    }
    return cameras;
  }

  async getStreamUrl(creds: Record<string, string>, vendorCameraId: string): Promise<string | null> {
    const chMatch = vendorCameraId.match(/ch(\d+)$/);
    const ch = chMatch ? Number(chMatch[1]) : 1;
    return `rtsp://${creds["username"]}:${creds["password"]}@${creds["host"]}:${creds["rtsp_port"] ?? "554"}/cam/realmonitor?channel=${ch}&subtype=0`;
  }

  private baseUrl(creds: Record<string, string>): string {
    const port = creds["port"] ?? "80";
    return `http://${creds["host"]}:${port}`;
  }

  private authHeader(creds: Record<string, string>): Record<string, string> {
    const basic = Buffer.from(`${creds["username"]}:${creds["password"]}`).toString("base64");
    return { "Authorization": `Basic ${basic}` };
  }
}
