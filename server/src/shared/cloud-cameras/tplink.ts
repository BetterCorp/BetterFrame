/**
 * TP-Link (Tapo/VIGI) camera integration.
 *
 * TP-Link has NO public cloud API. Tapo cameras support local RTSP +
 * ONVIF. VIGI is enterprise-only with direct NVR access. For
 * BetterFrame: connect to cameras directly via RTSP on the LAN.
 *
 * RTSP format: rtsp://user:pass@camera_ip/stream1 (main)
 *              rtsp://user:pass@camera_ip/stream2 (sub)
 *
 * This provider is essentially a direct-RTSP helper — no cloud relay.
 * All auth on server — kiosk only gets RTSP URLs.
 */
import type { CloudCameraProvider, CloudCamera, CloudVendor } from "./types.js";

export class TpLinkProvider implements CloudCameraProvider {
  vendor: CloudVendor = "tplink";

  credentialFields() {
    return [
      { name: "host", label: "Camera IP/Host", type: "text" as const, required: true },
      { name: "username", label: "Camera Username", type: "text" as const, required: true },
      { name: "password", label: "Camera Password", type: "password" as const, required: true },
    ];
  }

  async testCredentials(creds: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
    // No HTTP API — test by probing RTSP port (554).
    const { createConnection } = await import("node:net");
    const host = creds["host"] ?? "localhost";
    return new Promise((resolve) => {
      const sock = createConnection(
        { host, port: 554, timeout: 3000 },
        () => { sock.destroy(); resolve({ ok: true }); },
      );
      sock.on("error", () => resolve({ ok: false, error: "RTSP port unreachable" }));
      sock.on("timeout", () => { sock.destroy(); resolve({ ok: false, error: "Timeout" }); });
    });
  }

  async listCameras(creds: Record<string, string>): Promise<CloudCamera[]> {
    return [{
      vendor_id: creds["host"] ?? "unknown",
      name: `TP-Link Camera (${creds["host"]})`,
      model: null,
      rtsp_url: `rtsp://${creds["username"]}:${creds["password"]}@${creds["host"]}/stream1`,
      relay_url: null,
      online: true,
      stream_type: "rtsp",
      extra: {},
    }];
  }

  async getStreamUrl(creds: Record<string, string>, _vendorCameraId: string): Promise<string | null> {
    return `rtsp://${creds["username"]}:${creds["password"]}@${creds["host"]}/stream1`;
  }
}
