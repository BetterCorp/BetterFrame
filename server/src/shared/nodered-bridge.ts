/**
 * Node-RED bridge — best-effort outbound event forwarder.
 *
 * Server fires events (camera motion, kiosk status, layout switch, GPIO
 * pulse). This module POSTs them to Node-RED HTTP-in nodes. Failures
 * are logged but never block the event flow.
 */

export interface NoderedConfig {
  baseUrl: string;
  timeoutMs?: number;
}

export interface NoderedLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface NoderedBridge {
  forward(topic: string, payload: Record<string, unknown>): void;
}

export function initNoderedBridge(config: NoderedConfig, log: NoderedLog): NoderedBridge {
  const base = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 3000;

  return {
    forward(topic: string, payload: Record<string, unknown>): void {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);

      // Internal server-to-Node-RED delivery for events the backend already
      // authenticated, such as kiosk ONVIF/GPIO ingest.
      const url = `${base}/in/${encodeURIComponent(topic)}`;
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      })
        .then((r) => {
          if (!r.ok) log.warn(`nodered ${topic} → ${r.status}`);
        })
        .catch((err) => log.warn(`nodered ${topic} failed: ${(err as Error).message}`))
        .finally(() => clearTimeout(t));
    },
  };
}
