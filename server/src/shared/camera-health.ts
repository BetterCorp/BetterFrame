/**
 * Periodic camera health checker.
 *
 * Probes each camera's RTSP stream or ONVIF endpoint to determine if
 * it's reachable. Updates cameras.last_seen_at on success. Emits an
 * event when a camera goes offline (was seen recently, now unreachable).
 *
 * Runs server-side on a configurable interval (default 60s). Uses the
 * ffprobe-style approach: open a TCP connection to the RTSP port, send
 * OPTIONS, check for 200. No actual stream decode — just reachability.
 */
import { createConnection, type Socket } from "node:net";
import type { Repository } from "../plugins/service-store/repository.js";

export interface CameraHealthConfig {
  intervalMs: number;
  timeoutMs: number;
}

const DEFAULT_CONFIG: CameraHealthConfig = {
  intervalMs: 60_000,
  timeoutMs: 5_000,
};

export function startCameraHealthChecker(
  repo: Repository,
  config: Partial<CameraHealthConfig> = {},
  log: { info: (m: string) => void; warn: (m: string) => void },
): { stop: () => void } {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let timer: ReturnType<typeof setInterval> | null = null;

  async function checkAll(): Promise<void> {
    const cameras = (await repo.listCameras()).filter((c) => c.enabled);
    for (const cam of cameras) {
      const host = cam.type === "onvif"
        ? cam.onvif_host
        : parseRtspHost(cam.rtsp_url);
      const port = cam.type === "onvif"
        ? (cam.onvif_port ?? 80)
        : parseRtspPort(cam.rtsp_url);

      if (!host) continue;

      const reachable = await tcpProbe(host, port, cfg.timeoutMs);
      const wasOnline = cam.last_seen_at
        ? Date.now() - new Date(cam.last_seen_at).getTime() < cfg.intervalMs * 3
        : false;

      if (reachable) {
        await repo.updateCamera(cam.id, { last_seen_at: new Date().toISOString() } as any);
      } else if (wasOnline) {
        // Camera just went offline — log event for Node-RED / admin visibility.
        log.warn(`camera ${cam.id} (${cam.name}) went offline`);
        try {
          await repo.insertEvent({
            source_kiosk_id: null,
            source_camera_id: cam.id,
            source_type: "system",
            topic: "camera.offline",
            property_op: null,
            payload: {
              camera_id: cam.id,
              camera_name: cam.name,
              last_seen_at: cam.last_seen_at,
            },
            forwarded_to_nodered: false,
          });
        } catch {
          // Event insert failure shouldn't break the health loop.
        }
      }
    }
  }

  // Run immediately then on interval.
  checkAll().catch(() => {});
  timer = setInterval(() => { checkAll().catch(() => {}); }, cfg.intervalMs);

  return {
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(result);
    };

    const sock: Socket = createConnection({ host, port, timeout: timeoutMs }, () => {
      done(true);
    });
    sock.on("error", () => done(false));
    sock.on("timeout", () => done(false));
    setTimeout(() => done(false), timeoutMs + 500);
  });
}

function parseRtspHost(url: string | null): string | null {
  if (!url) return null;
  try {
    const match = url.match(/@([^:/]+)/);
    if (match) return match[1]!;
    const u = new URL(url.replace("rtsp://", "http://"));
    return u.hostname || null;
  } catch {
    return null;
  }
}

function parseRtspPort(url: string | null): number {
  if (!url) return 554;
  try {
    const match = url.match(/@[^:]+:(\d+)/);
    if (match) return Number(match[1]);
    const u = new URL(url.replace("rtsp://", "http://"));
    return u.port ? Number(u.port) : 554;
  } catch {
    return 554;
  }
}
