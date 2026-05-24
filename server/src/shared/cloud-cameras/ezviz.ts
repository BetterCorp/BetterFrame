/**
 * EZVIZ Open Platform (consumer Hikvision cameras).
 *
 * Auth: appKey + appSecret → accessToken + areaDomain.
 * Camera list: POST {areaDomain}/api/lapp/camera/list (paginated).
 * Live view: POST {areaDomain}/api/lapp/live/video/list → HLS URLs.
 *
 * Initial auth endpoint: https://open.ezvizlife.com/api/lapp/token/get
 * Subsequent calls use areaDomain from token response.
 *
 * Notes:
 *   - Streams encrypted by default (device verification code = key)
 *   - Supports HLS, RTMP, FLV
 *   - OAuth-based accounts (Google/FB) NOT supported — email/password EZVIZ only
 *   - Two-step verification must be disabled
 */
import type { CloudCameraProvider, CloudCamera, CloudVendor } from "./types.js";

const AUTH_BASE = "https://open.ezvizlife.com";

export class EzvizProvider implements CloudCameraProvider {
  vendor: CloudVendor = "ezviz";

  credentialFields() {
    return [
      { name: "app_key", label: "App Key", type: "text" as const, required: true },
      { name: "app_secret", label: "App Secret", type: "password" as const, required: true },
    ];
  }

  async testCredentials(creds: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
    try {
      const auth = await this.getToken(creds);
      return auth ? { ok: true } : { ok: false, error: "Token request failed" };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async listCameras(creds: Record<string, string>): Promise<CloudCamera[]> {
    const auth = await this.getToken(creds);
    if (!auth) return [];

    const cameras: CloudCamera[] = [];
    let pageStart = 0;
    const pageSize = 50;

    while (true) {
      const resp = await fetch(`${auth.areaDomain}/api/lapp/camera/list`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          accessToken: auth.accessToken,
          pageStart: String(pageStart),
          pageSize: String(pageSize),
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) break;
      const data = await resp.json() as any;
      if (data.code !== "200" && data.code !== 200) break;

      const list = data.data ?? [];
      if (list.length === 0) break;

      for (const cam of list) {
        cameras.push({
          vendor_id: `${cam.deviceSerial}:${cam.channelNo ?? 1}`,
          name: cam.deviceName ?? cam.channelName ?? `EZVIZ ${cam.deviceSerial}`,
          model: cam.deviceType ?? null,
          rtsp_url: null,
          relay_url: null,
          online: cam.status === 1 || cam.status === "1",
          stream_type: "hls",
          extra: {
            device_serial: cam.deviceSerial,
            channel_no: cam.channelNo ?? 1,
            is_encrypt: cam.isEncrypt ?? 0,
            pic_url: cam.picUrl ?? null,
          },
        });
      }

      if (list.length < pageSize) break;
      pageStart += pageSize;
    }

    return cameras;
  }

  async getStreamUrl(creds: Record<string, string>, vendorCameraId: string): Promise<string | null> {
    const auth = await this.getToken(creds);
    if (!auth) return null;

    const [deviceSerial, channelNo] = vendorCameraId.split(":");

    const resp = await fetch(`${auth.areaDomain}/api/lapp/v2/live/address/get`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        accessToken: auth.accessToken,
        deviceSerial: deviceSerial!,
        channelNo: channelNo ?? "1",
        protocol: "2", // 1=ezopen, 2=HLS, 3=RTMP, 4=FLV
        quality: "1", // 1=HD, 2=SD
        expireTime: "86400",
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) return null;
    const data = await resp.json() as any;
    if ((data.code !== "200" && data.code !== 200) || !data.data?.url) return null;
    return data.data.url;
  }

  private async getToken(creds: Record<string, string>): Promise<{
    accessToken: string;
    areaDomain: string;
  } | null> {
    const appKey = creds["app_key"];
    const appSecret = creds["app_secret"];
    if (!appKey || !appSecret) return null;

    try {
      const resp = await fetch(`${AUTH_BASE}/api/lapp/token/get`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ appKey, appSecret }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as any;
      if ((data.code !== "200" && data.code !== 200) || !data.data?.accessToken) return null;
      return {
        accessToken: data.data.accessToken,
        areaDomain: data.data.areaDomain ?? AUTH_BASE,
      };
    } catch {
      return null;
    }
  }
}
