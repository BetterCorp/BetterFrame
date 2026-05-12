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

export interface NoderedDashboard {
  /** Node-RED tab id, e.g. "abc123def456". URL becomes `/dash/<id>`. */
  id: string;
  name: string;
  hidden: boolean;
}

export interface NoderedBridge {
  forward(topic: string, payload: Record<string, unknown>): void;
  listDashboards(): Promise<NoderedDashboard[]>;
}

interface NoderedFlowNode {
  id: string;
  type: string;
  label?: string;
  name?: string;
  hidden?: boolean;
  disabled?: boolean;
}

/**
 * Pull all dashboard tabs from the Node-RED runtime's flow graph.
 * Both Dashboard 1 (`ui_tab`) and Dashboard 2 (`ui-base` page) shapes get
 * returned. The runtime endpoint is `/flows` under `httpAdminRoot` (which
 * is `/nrdp` for BetterFrame).
 */
async function fetchDashboards(baseUrl: string, timeoutMs: number): Promise<NoderedDashboard[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `${baseUrl}/nrdp/flows`;
    const r = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${String(r.status)}`);
    const data = (await r.json()) as NoderedFlowNode[] | { flows: NoderedFlowNode[] };
    const flows: NoderedFlowNode[] = Array.isArray(data) ? data : (data.flows ?? []);
    const out: NoderedDashboard[] = [];
    for (const n of flows) {
      // Dashboard 1: ui_tab. Dashboard 2: ui-base "page". Treat both alike.
      if (n.type === "ui_tab" || n.type === "ui-base" || n.type === "ui-page") {
        out.push({
          id: n.id,
          name: n.name ?? n.label ?? n.id,
          hidden: Boolean(n.hidden),
        });
      }
    }
    return out;
  } finally {
    clearTimeout(t);
  }
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
    async listDashboards(): Promise<NoderedDashboard[]> {
      try {
        return await fetchDashboards(base, timeoutMs);
      } catch (err) {
        log.warn(`nodered listDashboards failed: ${(err as Error).message}`);
        return [];
      }
    },
  };
}
