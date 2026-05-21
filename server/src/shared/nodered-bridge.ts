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
  forward(topic: string, payload: Record<string, unknown>, onSuccess?: () => void): void;
  listDashboards(): Promise<NoderedDashboard[]>;
  /**
   * Idempotently provision a `bf-server-config` node in Node-RED's flow graph
   * carrying the BetterFrame server URL + admin API key. Skips if any
   * `bf-server-config` node already exists (assume user owns it). Best-effort;
   * caller should retry on transient failure (Node-RED may still be booting).
   */
  ensureServerConfig(serverUrl: string, apiKey: string): Promise<"created" | "exists" | "failed">;
}

interface NoderedFlowNode {
  id: string;
  type: string;
  label?: string;
  name?: string;
  hidden?: boolean;
  disabled?: boolean;
  z?: string;
  [k: string]: unknown;
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
    forward(topic: string, payload: Record<string, unknown>, onSuccess?: () => void): void {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);

      const url = `${base}/api/internal/${encodeURIComponent(topic)}`;
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      })
        .then((r) => {
          if (r.ok) {
            onSuccess?.();
          } else {
            log.warn(`nodered ${topic} → ${r.status}`);
          }
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
    async ensureServerConfig(
      serverUrl: string,
      apiKey: string,
    ): Promise<"created" | "exists" | "failed"> {
      try {
        return await provisionServerConfig(base, timeoutMs, serverUrl, apiKey);
      } catch (err) {
        log.warn(`nodered ensureServerConfig failed: ${(err as Error).message}`);
        return "failed";
      }
    },
  };
}

const BF_SERVER_CONFIG_ID = "bfsrv-default";

async function provisionServerConfig(
  base: string,
  timeoutMs: number,
  serverUrl: string,
  apiKey: string,
): Promise<"created" | "exists" | "failed"> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // GET current flows + revision. Use the "full" format so the response is
    // always {flows, rev} — the bare default in some Node-RED versions returns
    // a plain array which has no rev for the POST.
    const getResp = await fetch(`${base}/nrdp/flows`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "node-red-api-version": "v2",
      },
      signal: ctrl.signal,
    });
    if (!getResp.ok) throw new Error(`GET /flows HTTP ${String(getResp.status)}`);
    const raw = (await getResp.json()) as NoderedFlowNode[] | { flows: NoderedFlowNode[]; rev?: string };
    const flows: NoderedFlowNode[] = Array.isArray(raw) ? raw : (raw.flows ?? []);
    const rev: string | undefined = Array.isArray(raw) ? undefined : raw.rev;

    if (flows.some((n) => n.type === "bf-server-config")) {
      return "exists";
    }

    const newNode: NoderedFlowNode = {
      id: BF_SERVER_CONFIG_ID,
      type: "bf-server-config",
      name: "BetterFrame (auto)",
      server_url: serverUrl.replace(/\/+$/, ""),
      // Node-RED extracts `credentials` on POST /flows and stores them in
      // flows_cred.json. Confirmed by the editor's own save path.
      credentials: { api_key: apiKey },
    };

    const body: Record<string, unknown> = {
      flows: [...flows, newNode],
    };
    if (rev) body.rev = rev;

    const postResp = await fetch(`${base}/nrdp/flows`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "node-red-api-version": "v2",
        "node-red-deployment-type": "full",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!postResp.ok) {
      const text = await postResp.text().catch(() => "");
      throw new Error(`POST /flows HTTP ${String(postResp.status)}: ${text.slice(0, 200)}`);
    }
    return "created";
  } finally {
    clearTimeout(t);
  }
}
