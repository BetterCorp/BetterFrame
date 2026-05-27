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

export interface NoderedTenantConfig {
  tenant_slug: string;
  tenant_name: string;
  api_key: string;
  active: boolean;
  deleted?: boolean;
}

export interface NoderedBridge {
  forward(
    topic: string,
    payload: Record<string, unknown>,
    tenant: { tenant_slug: string; tenant_name: string | null },
    onSuccess?: () => void,
  ): void;
  listDashboards(): Promise<NoderedDashboard[]>;
  reconcileServerConfigs(serverUrl: string, tenantConfigs: NoderedTenantConfig[]): Promise<"updated" | "noop" | "failed">;
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
    forward(
      topic: string,
      payload: Record<string, unknown>,
      tenant: { tenant_slug: string; tenant_name: string | null },
      onSuccess?: () => void,
    ): void {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);

      const url = `${base}/api/internal/${encodeURIComponent(topic)}`;
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...payload,
          tenant_slug: tenant.tenant_slug,
          tenant_name: tenant.tenant_name,
        }),
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
    async reconcileServerConfigs(
      serverUrl: string,
      tenantConfigs: NoderedTenantConfig[],
    ): Promise<"updated" | "noop" | "failed"> {
      try {
        return await reconcileServerConfigs(base, timeoutMs, serverUrl, tenantConfigs, log);
      } catch (err) {
        log.warn(`nodered reconcileServerConfigs failed: ${(err as Error).message}`);
        return "failed";
      }
    },
  };
}

const LEGACY_BF_SERVER_CONFIG_ID = "bfsrv-default";

function managedNodeId(tenantSlug: string): string {
  return `bfsrv-tenant-${tenantSlug}`;
}

function configNodeName(tenant: NoderedTenantConfig): string {
  const base = `BetterFrame (${tenant.tenant_name})`;
  if (tenant.deleted) return `${base} [deleted]`;
  if (!tenant.active) return `${base} [inactive]`;
  return base;
}

function desiredTenantState(tenant: NoderedTenantConfig): "active" | "inactive" | "deleted" {
  if (tenant.deleted) return "deleted";
  return tenant.active ? "active" : "inactive";
}

function apiKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, 8);
}

async function reconcileServerConfigs(
  base: string,
  timeoutMs: number,
  serverUrl: string,
  tenantConfigs: NoderedTenantConfig[],
  log: NoderedLog,
): Promise<"updated" | "noop" | "failed"> {
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
    const flows: NoderedFlowNode[] = (Array.isArray(raw) ? raw : (raw.flows ?? [])).map((node) => ({ ...node }));
    const rev: string | undefined = Array.isArray(raw) ? undefined : raw.rev;

    const desired = new Map<string, NoderedTenantConfig>();
    for (const tenant of tenantConfigs) {
      desired.set(managedNodeId(tenant.tenant_slug), tenant);
    }

    let changed = false;
    const managedIds = new Set(desired.keys());

    for (let i = 0; i < flows.length; i += 1) {
      const node = flows[i]!;
      if (node.id === LEGACY_BF_SERVER_CONFIG_ID && node.type === "bf-server-config") {
        const legacyName = typeof node.name === "string" ? node.name : "";
        if (legacyName === "BetterFrame (auto)") {
          node.name = "BetterFrame (legacy auto)";
          node.disabled = true;
          node["managed_by_betterframe"] = true;
          node["managed_tenant_state"] = "deleted";
          changed = true;
        }
        continue;
      }
      if (node.type !== "bf-server-config" || node["managed_by_betterframe"] !== true) continue;
      const tenant = desired.get(String(node.id));
      if (!tenant) {
        node.disabled = true;
        node["managed_tenant_state"] = "deleted";
        if (typeof node.name === "string" && !node.name.endsWith(" [deleted]")) {
          node.name = `${node.name} [deleted]`;
        }
        changed = true;
        log.info(`nodered: disabled tenant config ${String(node["tenant_slug"] ?? node.id)} (deleted)`);
        continue;
      }
      const state = desiredTenantState(tenant);
      const nextName = configNodeName(tenant);
      const nextDisabled = state !== "active";
      if (
        node.name !== nextName
        || node.server_url !== serverUrl.replace(/\/+$/, "")
        || node["tenant_slug"] !== tenant.tenant_slug
        || node["tenant_name"] !== tenant.tenant_name
        || node["managed_api_key_prefix"] !== apiKeyPrefix(tenant.api_key)
        || node["managed_tenant_state"] !== state
        || node.disabled !== nextDisabled
      ) {
        node.name = nextName;
        node.server_url = serverUrl.replace(/\/+$/, "");
        node["tenant_slug"] = tenant.tenant_slug;
        node["tenant_name"] = tenant.tenant_name;
        node["managed_by_betterframe"] = true;
        node["managed_api_key_prefix"] = apiKeyPrefix(tenant.api_key);
        node["managed_tenant_state"] = state;
        node.disabled = nextDisabled;
        node.credentials = { api_key: tenant.api_key };
        changed = true;
        if (state === "active") log.info(`nodered: updated tenant config ${tenant.tenant_slug}`);
        if (state === "inactive") log.info(`nodered: disabled tenant config ${tenant.tenant_slug} (inactive)`);
        if (state === "deleted") log.info(`nodered: disabled tenant config ${tenant.tenant_slug} (deleted)`);
      }
      managedIds.delete(String(node.id));
    }

    for (const id of managedIds) {
      const tenant = desired.get(id)!;
      const state = desiredTenantState(tenant);
      flows.push({
        id,
        type: "bf-server-config",
        name: configNodeName(tenant),
        server_url: serverUrl.replace(/\/+$/, ""),
        tenant_slug: tenant.tenant_slug,
        tenant_name: tenant.tenant_name,
        managed_by_betterframe: true,
        managed_api_key_prefix: apiKeyPrefix(tenant.api_key),
        managed_tenant_state: state,
        disabled: state !== "active",
        credentials: { api_key: tenant.api_key },
      });
      changed = true;
      if (state === "active") log.info(`nodered: created tenant config ${tenant.tenant_slug}`);
      if (state === "inactive") log.info(`nodered: disabled tenant config ${tenant.tenant_slug} (inactive)`);
      if (state === "deleted") log.info(`nodered: disabled tenant config ${tenant.tenant_slug} (deleted)`);
    }

    if (!changed) {
      return "noop";
    }

    const body: Record<string, unknown> = {
      flows,
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
    return "updated";
  } finally {
    clearTimeout(t);
  }
}
