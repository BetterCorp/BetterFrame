/**
 * Reolink camera integration.
 *
 * Reolink cameras support local HTTP API + RTSP. No public cloud API
 * for third-party streaming. Cameras expose:
 *   - RTSP: rtsp://admin:pass@ip/h264Preview_01_main (main)
 *           rtsp://admin:pass@ip/h264Preview_01_sub  (sub)
 *   - HTTP API on port 80/443 for device info, PTZ, etc.
 *
 * This provider uses the local HTTP API for discovery + RTSP for streams.
 */
import type { CloudCameraProvider, CloudCamera, CloudVendor } from "./types.js";

export class ReolinkProvider implements CloudCameraProvider {
  vendor: CloudVendor = "reolink";

  credentialFields() {
    return [
      { name: "host", label: "Camera IP/Host", type: "text" as const, required: true },
      { name: "username", label: "Username", type: "text" as const, required: true },
      { name: "password", label: "Password", type: "password" as const, required: true },
    ];
  }

  async testCredentials(creds: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
    const host = creds["host"];
    const username = creds["username"];
    const password = creds["password"];
    if (!host || !username || !password) return { ok: false, error: "Missing credentials" };

    try {
      const resp = await fetch(
        `http://${host}/api.cgi?cmd=Login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([{
            cmd: "Login",
            param: { User: { userName: username, password } },
          }]),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      const data = await resp.json() as any;
      const result = data?.[0];
      if (result?.code === 0 || result?.value?.Token) return { ok: true };
      return { ok: false, error: result?.error?.detail ?? "Login failed" };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async listCameras(creds: Record<string, string>): Promise<CloudCamera[]> {
    const host = creds["host"];
    const username = creds["username"];
    const password = creds["password"];
    if (!host || !username || !password) return [];

    let name = `Reolink (${host})`;
    let model: string | null = null;

    try {
      const token = await this.login(host, username, password);
      if (token) {
        const info = await this.getDevInfo(host, token);
        if (info) {
          name = info.name || name;
          model = info.model;
        }
      }
    } catch { /* fallback to defaults */ }

    const mainUrl = `rtsp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}/h264Preview_01_main`;

    return [{
      vendor_id: host,
      name,
      model,
      rtsp_url: mainUrl,
      relay_url: null,
      online: true,
      stream_type: "rtsp",
      extra: {
        sub_url: `rtsp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}/h264Preview_01_sub`,
      },
    }];
  }

  async getStreamUrl(creds: Record<string, string>, _vendorCameraId: string): Promise<string | null> {
    const host = creds["host"];
    const username = creds["username"];
    const password = creds["password"];
    if (!host || !username || !password) return null;
    return `rtsp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}/h264Preview_01_main`;
  }

  private async login(host: string, username: string, password: string): Promise<string | null> {
    const resp = await fetch(`http://${host}/api.cgi?cmd=Login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{
        cmd: "Login",
        param: { User: { userName: username, password } },
      }]),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    return data?.[0]?.value?.Token?.name ?? null;
  }

  private async getDevInfo(host: string, token: string): Promise<{ name: string; model: string } | null> {
    const resp = await fetch(`http://${host}/api.cgi?cmd=GetDevInfo&token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ cmd: "GetDevInfo", action: 0, param: {} }]),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const info = data?.[0]?.value?.DevInfo;
    if (!info) return null;
    return { name: info.name ?? "", model: info.model ?? "" };
  }
}
