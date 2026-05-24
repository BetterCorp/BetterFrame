/**
 * Eagle Eye Networks cloud camera integration.
 *
 * Auth: OAuth2 client_credentials → access_token.
 * API base: https://api.eagleeyenetworks.com/api/v3.0
 * Camera list: GET /cameras (paginated).
 * Live view: GET /cameras/{id}/streams → RTSP/HLS URL.
 *
 * Eagle Eye is a true cloud VMS — cameras stream to their cloud,
 * we pull relay URLs. All auth on server.
 */
import type { CloudCameraProvider, CloudCamera, CloudVendor } from "./types.js";

const API_BASE = "https://api.eagleeyenetworks.com/api/v3.0";
const AUTH_URL = "https://auth.eagleeyenetworks.com/oauth2/token";

export class EagleEyeProvider implements CloudCameraProvider {
  vendor: CloudVendor = "eagle_eye";

  credentialFields() {
    return [
      { name: "client_id", label: "Client ID", type: "text" as const, required: true },
      { name: "client_secret", label: "Client Secret", type: "password" as const, required: true },
      { name: "api_key", label: "API Key", type: "text" as const, required: true },
    ];
  }

  async testCredentials(creds: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
    try {
      const token = await this.getToken(creds);
      return token ? { ok: true } : { ok: false, error: "Auth failed" };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async listCameras(creds: Record<string, string>): Promise<CloudCamera[]> {
    const token = await this.getToken(creds);
    if (!token) return [];

    const cameras: CloudCamera[] = [];
    let nextPageToken: string | null = null;

    do {
      const params = new URLSearchParams({ pageSize: "100" });
      if (nextPageToken) params.set("pageToken", nextPageToken);

      const resp = await fetch(`${API_BASE}/cameras?${params}`, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) break;
      const data = await resp.json() as any;

      for (const cam of data.results ?? []) {
        cameras.push({
          vendor_id: cam.id,
          name: cam.name ?? `Eagle Eye ${cam.id}`,
          model: cam.settings?.camera_info?.model ?? null,
          rtsp_url: null,
          relay_url: null,
          online: cam.status === "online",
          stream_type: "hls",
          extra: {
            account_id: cam.accountId ?? null,
            timezone: cam.timezone ?? null,
            tags: cam.tags ?? [],
          },
        });
      }

      nextPageToken = data.nextPageToken ?? null;
    } while (nextPageToken);

    return cameras;
  }

  async getStreamUrl(creds: Record<string, string>, vendorCameraId: string): Promise<string | null> {
    const token = await this.getToken(creds);
    if (!token) return null;

    try {
      const resp = await fetch(`${API_BASE}/cameras/${vendorCameraId}/streams`, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as any;
      return data.hlsUrl ?? data.rtspUrl ?? null;
    } catch {
      return null;
    }
  }

  private async getToken(creds: Record<string, string>): Promise<string | null> {
    const clientId = creds["client_id"];
    const clientSecret = creds["client_secret"];
    if (!clientId || !clientSecret) return null;

    try {
      const resp = await fetch(AUTH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as any;
      return data.access_token ?? null;
    } catch {
      return null;
    }
  }
}
