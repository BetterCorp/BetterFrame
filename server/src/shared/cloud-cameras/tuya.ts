/**
 * Tuya IoT Cloud camera integration.
 *
 * Best-documented cloud API of the five vendors. OAuth2 auth with
 * HMAC-SHA256 signing. Camera streaming via /v1.0/users/{uid}/devices/
 * {device_id}/stream/actions/allocate → returns RTSP/HLS URLs.
 *
 * All auth on server — kiosk only gets streaming URLs in the bundle.
 *
 * Requires Tuya IoT developer account + IoT Video Live Stream subscription.
 * API base: https://openapi.tuyaeu.com (EU), openapi.tuyaus.com (US), etc.
 */
import { createHmac } from "node:crypto";
import type { CloudCameraProvider, CloudCamera, CloudVendor } from "./types.js";

const REGION_BASES: Record<string, string> = {
  eu: "https://openapi.tuyaeu.com",
  us: "https://openapi.tuyaus.com",
  cn: "https://openapi.tuyacn.com",
  in: "https://openapi.tuyain.com",
};

export class TuyaProvider implements CloudCameraProvider {
  vendor: CloudVendor = "tuya";

  credentialFields() {
    return [
      { name: "client_id", label: "Access ID (Client ID)", type: "text" as const, required: true },
      { name: "client_secret", label: "Access Secret", type: "password" as const, required: true },
      { name: "region", label: "Region (eu/us/cn/in)", type: "text" as const, required: false },
      { name: "uid", label: "User UID (from Tuya app)", type: "text" as const, required: false },
    ];
  }

  async testCredentials(creds: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
    try {
      const token = await this.getToken(creds);
      return token ? { ok: true } : { ok: false, error: "Token request failed" };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async listCameras(creds: Record<string, string>): Promise<CloudCamera[]> {
    const token = await this.getToken(creds);
    if (!token) return [];
    const uid = creds["uid"];
    if (!uid) return [];

    const base = this.apiBase(creds);
    const resp = await this.signedGet(`${base}/v1.0/users/${uid}/devices`, creds, token);
    if (!resp) return [];

    const devices = resp.result ?? [];
    const cameraDevices = devices.filter(
      (d: any) => d.category === "sp" || d.category === "ipc",
    );
    const cameras: CloudCamera[] = [];
    for (const d of cameraDevices) {
      let streamUrl: string | null = null;
      if (d.online === true) {
        streamUrl = await this.getStreamUrl(creds, d.id);
      }
      cameras.push({
        vendor_id: d.id,
        name: d.name ?? "Tuya Camera",
        model: d.product_name ?? d.model ?? null,
        rtsp_url: null,
        relay_url: streamUrl,
        online: d.online === true,
        stream_type: streamUrl ? "rtsp" : null,
        extra: { category: d.category, product_id: d.product_id, local_ip: d.ip ?? null },
      });
    }
    return cameras;
  }

  async getStreamUrl(creds: Record<string, string>, vendorCameraId: string): Promise<string | null> {
    const token = await this.getToken(creds);
    if (!token) return null;
    const uid = creds["uid"];
    if (!uid) return null;

    const base = this.apiBase(creds);
    const resp = await this.signedPost(
      `${base}/v1.0/users/${uid}/devices/${vendorCameraId}/stream/actions/allocate`,
      creds, token,
      { type: "rtsp" },
    );
    return resp?.result?.url ?? null;
  }

  private apiBase(creds: Record<string, string>): string {
    return REGION_BASES[(creds["region"] ?? "eu").toLowerCase()] ?? REGION_BASES["eu"]!;
  }

  private async getToken(creds: Record<string, string>): Promise<string | null> {
    const { client_id, client_secret } = creds;
    if (!client_id || !client_secret) return null;
    const base = this.apiBase(creds);
    const ts = Date.now().toString();
    const sign = this.calcSign(client_id, client_secret, ts, "");

    const resp = await fetch(`${base}/v1.0/token?grant_type=1`, {
      method: "GET",
      headers: {
        "client_id": client_id,
        "sign": sign,
        "t": ts,
        "sign_method": "HMAC-SHA256",
      },
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    return data?.result?.access_token ?? null;
  }

  private calcSign(clientId: string, secret: string, ts: string, token: string): string {
    const str = clientId + token + ts;
    return createHmac("sha256", secret).update(str).digest("hex").toUpperCase();
  }

  private async signedGet(url: string, creds: Record<string, string>, token: string): Promise<any> {
    const ts = Date.now().toString();
    const sign = this.calcSign(creds["client_id"]!, creds["client_secret"]!, ts, token);
    const resp = await fetch(url, {
      headers: {
        "client_id": creds["client_id"]!,
        "access_token": token,
        "sign": sign,
        "t": ts,
        "sign_method": "HMAC-SHA256",
      },
    });
    if (!resp.ok) return null;
    return resp.json();
  }

  private async signedPost(url: string, creds: Record<string, string>, token: string, body: any): Promise<any> {
    const ts = Date.now().toString();
    const sign = this.calcSign(creds["client_id"]!, creds["client_secret"]!, ts, token);
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "client_id": creds["client_id"]!,
        "access_token": token,
        "sign": sign,
        "t": ts,
        "sign_method": "HMAC-SHA256",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    return resp.json();
  }
}
