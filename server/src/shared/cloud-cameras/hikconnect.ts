/**
 * Hik-Connect for Teams (HikCentral Connect) OpenAPI integration.
 *
 * Auth: appKey (AK) + secretKey (SK) → accessToken + areaDomain.
 * Camera list: POST /api/hccgw/resource/v1/areas/cameras/get (paginated).
 * Live view: POST /api/hccgw/video/v1/live/address/get → RTMP URL.
 *
 * Server addresses per region:
 *   Russia:     https://hikcentralconnectru.com
 *   Singapore:  https://isgp.hikcentralconnect.com
 *   Europe:     https://ieu.hikcentralconnect.com
 *   South America: https://isa.hikcentralconnect.com
 *   North America: https://ius.hikcentralconnect.com
 *
 * Notes from docs:
 *   - India/Russia do NOT support RTMP/HLS
 *   - RTMP/HLS: H.264 only, no playback, no stream encryption
 *   - RTMP expireTime: 30s–720d
 *   - All auth on server — kiosk only gets streaming URLs
 */
import type { CloudCameraProvider, CloudCamera, CloudVendor } from "./types.js";

const REGION_BASES: Record<string, string> = {
  ru: "https://hikcentralconnectru.com",
  sg: "https://isgp.hikcentralconnect.com",
  eu: "https://ieu.hikcentralconnect.com",
  sa: "https://isa.hikcentralconnect.com",
  us: "https://ius.hikcentralconnect.com",
};

export class HikConnectProvider implements CloudCameraProvider {
  vendor: CloudVendor = "hikconnect";

  credentialFields() {
    return [
      { name: "app_key", label: "App Key (AK)", type: "text" as const, required: true },
      { name: "secret_key", label: "Secret Key (SK)", type: "password" as const, required: true },
      { name: "region", label: "Region (eu/us/sg/sa/ru)", type: "text" as const, required: false },
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
    let pageIndex = 1;
    const pageSize = 200;

    while (true) {
      const resp = await fetch(`${auth.areaDomain}/api/hccgw/resource/v1/areas/cameras/get`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Token": auth.accessToken,
        },
        body: JSON.stringify({
          pageIndex: String(pageIndex),
          pageSize: String(pageSize),
          filter: { areaID: "-1", includeSubArea: "1" },
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) break;
      const data = await resp.json() as any;
      if (data.errorCode !== "0") break;

      const cameraList = data.data?.camera ?? [];
      for (const cam of cameraList) {
        const serial = cam.device?.devInfo?.serialNo ?? "";
        const channelNo = cam.device?.channelInfo?.no ?? "1";

        let streamUrl: string | null = null;
        let streamType: "rtmp" | "hls" | null = null;
        if (cam.online === "1") {
          const live = await this.fetchLiveAddress(
            auth.areaDomain, auth.accessToken, cam.id, serial,
          );
          if (live) {
            streamUrl = live.url;
            streamType = "rtmp";
          }
        }

        cameras.push({
          vendor_id: cam.id,
          name: cam.name ?? `Hik Ch${channelNo}`,
          model: null,
          rtsp_url: null,
          relay_url: streamUrl,
          online: cam.online === "1",
          stream_type: streamType,
          extra: {
            serial,
            channel_no: channelNo,
            ability_set: cam.abilitySet ?? "",
            area_name: cam.area?.name ?? null,
          },
        });
      }

      const total = data.data?.totalCount ?? 0;
      if (pageIndex * pageSize >= total) break;
      pageIndex++;
    }

    return cameras;
  }

  async getStreamUrl(creds: Record<string, string>, vendorCameraId: string): Promise<string | null> {
    const auth = await this.getToken(creds);
    if (!auth) return null;

    const camsResp = await fetch(`${auth.areaDomain}/api/hccgw/resource/v1/areas/cameras/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Token": auth.accessToken },
      body: JSON.stringify({
        pageIndex: "1", pageSize: "1",
        filter: { cameraID: [vendorCameraId] },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!camsResp.ok) return null;
    const camsData = await camsResp.json() as any;
    const cam = camsData.data?.camera?.[0];
    if (!cam) return null;

    const serial = cam.device?.devInfo?.serialNo ?? "";
    const live = await this.fetchLiveAddress(auth.areaDomain, auth.accessToken, vendorCameraId, serial);
    return live?.url ?? null;
  }

  private async fetchLiveAddress(
    areaDomain: string, token: string, resourceId: string, deviceSerial: string,
  ): Promise<{ url: string; expireTime: number } | null> {
    try {
      const resp = await fetch(`${areaDomain}/api/hccgw/video/v1/live/address/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Token": token },
        body: JSON.stringify({
          resourceId,
          deviceSerial,
          type: "1",
          protocol: 3,
          quality: "1",
          expireTime: 86400,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as any;
      if (data.errorCode !== "0" || !data.data?.url) return null;
      return { url: data.data.url, expireTime: data.data.expireTime ?? 0 };
    } catch {
      return null;
    }
  }

  private async getToken(creds: Record<string, string>): Promise<{
    accessToken: string;
    areaDomain: string;
  } | null> {
    const appKey = creds["app_key"];
    const secretKey = creds["secret_key"];
    if (!appKey || !secretKey) return null;

    const base = REGION_BASES[(creds["region"] ?? "eu").toLowerCase()] ?? REGION_BASES["eu"]!;

    try {
      const resp = await fetch(`${base}/api/hccgw/platform/v1/token/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appKey, secretKey }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as any;
      if (data.errorCode !== "0" || !data.data?.accessToken) return null;
      return {
        accessToken: data.data.accessToken,
        areaDomain: data.data.areaDomain ?? base,
      };
    } catch {
      return null;
    }
  }
}
