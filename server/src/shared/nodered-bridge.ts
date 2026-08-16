import { readFileSync } from "node:fs";

export interface NoderedConfig {
  baseUrl: string;
  timeoutMs?: number;
}

export interface NoderedLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface NoderedDashboard {
  id: string;
  name: string;
  hidden: boolean;
}

export interface NoderedTenantConfig {
  tenant_id: string;
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
    tenant: { tenant_slug: string; tenant_name: string | null; tenant_id?: string | null },
    onSuccess?: () => void,
  ): void;
  listDashboards(tenantId: string): Promise<NoderedDashboard[]>;
  reconcileServerConfigs(
    serverUrl: string,
    tenantConfigs: NoderedTenantConfig[],
  ): Promise<"updated" | "noop" | "failed">;
  deleteTenant(tenantId: string): Promise<boolean>;
}

interface NoderedFlowNode {
  id: string;
  type: string;
  label?: string;
  name?: string;
  hidden?: boolean;
}

async function fetchDashboards(
  baseUrl: string,
  timeoutMs: number,
  tenantId: string,
): Promise<NoderedDashboard[]> {
  const response = await fetch(`${baseUrl}/nrdp/flows`, {
    headers: { accept: "application/json", "x-betterframe-tenant": tenantId },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  const data = (await response.json()) as NoderedFlowNode[] | { flows: NoderedFlowNode[] };
  const flows = Array.isArray(data) ? data : (data.flows ?? []);
  return flows
    .filter((node) => node.type === "ui_tab" || node.type === "ui-base" || node.type === "ui-page")
    .map((node) => ({
      id: node.id,
      name: node.name ?? node.label ?? node.id,
      hidden: Boolean(node.hidden),
    }));
}

export function initNoderedBridge(config: NoderedConfig, log: NoderedLog): NoderedBridge {
  const base = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 3000;
  const managerToken = process.env["BF_NODERED_MANAGER_SECRET"]
    ?? readSecretFile(process.env["BF_NODERED_MANAGER_SECRET_FILE"]);

  return {
    forward(topic, payload, tenant, onSuccess): void {
      fetch(`${base}/api/internal/${encodeURIComponent(topic)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-betterframe-tenant": tenant.tenant_id ?? tenant.tenant_slug,
        },
        body: JSON.stringify({
          ...payload,
          tenant_slug: tenant.tenant_slug,
          tenant_key: tenant.tenant_slug,
          tenant_id: tenant.tenant_id ?? tenant.tenant_slug,
          tenant_name: tenant.tenant_name,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
        .then((response) => {
          if (response.ok) onSuccess?.();
          else log.warn(`nodered ${topic} -> ${response.status}`);
        })
        .catch((error: Error) => log.warn(`nodered ${topic} failed: ${error.message}`));
    },

    async listDashboards(tenantId): Promise<NoderedDashboard[]> {
      try {
        return await fetchDashboards(base, timeoutMs, tenantId);
      } catch (error) {
        log.warn(`nodered listDashboards failed: ${(error as Error).message}`);
        return [];
      }
    },

    async reconcileServerConfigs(serverUrl, tenantConfigs): Promise<"updated" | "noop" | "failed"> {
      try {
        if (managerToken.length < 32) throw new Error("BF_NODERED_MANAGER_SECRET is not configured");
        for (const tenant of tenantConfigs) {
          const response = await fetch(
            `${base}/_betterframe/v1/tenants/${encodeURIComponent(tenant.tenant_id)}`,
            {
              method: "PUT",
              headers: {
                authorization: `Bearer ${managerToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                tenant_id: tenant.tenant_id,
                slug: tenant.tenant_slug,
                name: tenant.tenant_name,
                active: tenant.active && !tenant.deleted,
                server_url: serverUrl,
                api_key: tenant.api_key,
              }),
              signal: AbortSignal.timeout(timeoutMs),
            },
          );
          if (!response.ok) throw new Error(`tenant ${tenant.tenant_slug}: HTTP ${response.status}`);
        }
        return "updated";
      } catch (error) {
        log.warn(`nodered reconcileServerConfigs failed: ${(error as Error).message}`);
        return "failed";
      }
    },

    async deleteTenant(tenantId): Promise<boolean> {
      if (managerToken.length < 32) return false;
      try {
        const response = await fetch(
          `${base}/_betterframe/v1/tenants/${encodeURIComponent(tenantId)}`,
          {
            method: "DELETE",
            headers: { authorization: `Bearer ${managerToken}` },
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        return response.ok;
      } catch (error) {
        log.warn(`nodered deleteTenant failed: ${(error as Error).message}`);
        return false;
      }
    },
  };
}

function readSecretFile(path: string | undefined): string {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}
