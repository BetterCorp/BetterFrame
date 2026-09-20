import type { Repository } from "./db/repository.js";
import { createTenantSchema } from "./db/init.js";
import type { Tenant } from "./tenant.js";
import type { AuthApi } from "./auth.js";
import type { SecretsApi } from "./secrets.js";
import { confirmPairing, matchesSecret } from "./pairing.js";

export const DEMO_SLUG = "demo";
const MARKER = "demo_tenant_id";
export async function demoTenant(repo: Repository): Promise<Tenant | null> {
  return repo.adapter.withSearchPath("public", async () => {
    const id = await repo.getSetupExtra(MARKER);
    return typeof id === "string" ? repo.getTenantById(id) : null;
  });
}

/** Legacy customer tenants may also be named demo; only the stored ID is managed. */
export async function demoTenantHidden(repo: Repository, enabled: boolean | undefined, tenant: Tenant): Promise<boolean> {
  if (enabled || tenant.slug !== DEMO_SLUG) return false;
  return (await demoTenant(repo))?.id === tenant.id;
}

export async function visibleTenants(repo: Repository, enabled: boolean | undefined): Promise<Tenant[]> {
  const tenants = await repo.listTenants();
  if (enabled || !tenants.some(t => t.slug === DEMO_SLUG)) return tenants;
  const hidden = await demoTenant(repo);
  return tenants.filter(t => t.id !== hidden?.id);
}

export async function demoAvailable(repo: Repository, enabled: boolean): Promise<boolean> {
  return enabled && (await demoTenant(repo))?.is_active === true;
}

export async function prepareDemo(repo: Repository, enabled: boolean): Promise<Tenant | null> {
  if (!enabled) return null;
  if (repo.adapter.dialect() !== "postgres") throw Error("Demo requires PostgreSQL tenant isolation");
  return repo.adapter.withSearchPath("public", () => repo.transact(async () => {
    await repo.adapter.get("SELECT pg_advisory_xact_lock(1642060916)");
    const existing = await demoTenant(repo);
    if (existing) return existing.is_active ? existing : null;
    if (await repo.getTenantBySlug(DEMO_SLUG)) throw Error("Reserved demo tenant slug is already in use");
    const tenant = await repo.createTenant({ name: "Demo", slug: DEMO_SLUG, max_kiosks: 1000 });
    await createTenantSchema(repo.adapter, tenant.slug, { info: () => {}, warn: () => {} });
    await repo.setSetupExtra(MARKER, tenant.id);
    await repo.adapter.withSearchPath(tenant.schema_name, async () => {
      const layout = await repo.createLayout({ name: "Welcome to BetterFrame" });
      await repo.createLayoutCell({ layout_id: layout.id, row: 0, col: 0, content_type: "html",
        html_content: '<!doctype html><html><body style="margin:0;background:#0b1220;color:white;display:grid;place-content:center;height:100vh;text-align:center;font-family:sans-serif"><h1>BetterFrame</h1><p>Your content. Every display.</p><p>Welcome to the demo</p></body></html>' });
      await repo.setSetupExtra("display_defaults", { layoutIds: [layout.id], defaultLayoutId: layout.id });
    });
    return tenant;
  }));
}

export async function enrollDemo(repo: Repository, auth: AuthApi, secrets: SecretsApi,
  enabled: boolean, code: string, pollingSecret: string | undefined): Promise<void> {
  if (!enabled) throw Error("Demo unavailable");
  const tenant = await demoTenant(repo);
  if (!tenant?.is_active) throw Error("Demo unavailable");
  await repo.adapter.withSearchPath(tenant.schema_name, () => repo.transact(async () => {
    // Serialize capacity checks across API instances; pairing itself locks its code.
    const current = await repo.adapter.get<{ is_active: boolean; max_kiosks: number | null }>(
      "SELECT is_active, max_kiosks FROM public.tenants WHERE id = ? FOR UPDATE", [tenant.id]);
    if (!current?.is_active) throw Error("Demo unavailable");
    const pc = await repo.getPairingCode(code, true);
    if (!pc || !matchesSecret(pollingSecret, pc.extras["polling_secret_hash"])) throw Error("Invalid demo pairing session");
    if (!pc.consumed_at && current.max_kiosks != null) {
      const count = await repo.adapter.get<{ count: string }>("SELECT count(*) FROM kiosks");
      if (Number(count?.count) >= current.max_kiosks) throw Error("Demo capacity reached");
    }
    await confirmPairing(repo, auth, secrets, {
      code, demo: true, tenant: { id: tenant.id, slug: tenant.slug, schemaName: tenant.schema_name },
    });
  }));
}

/** Normal deletion owns credential invalidation and client recovery. */
export async function cleanupDemo(repo: Repository, now = new Date()): Promise<number> {
  const tenant = await demoTenant(repo);
  if (!tenant) return 0;
  return repo.adapter.withSearchPath(tenant.schema_name, () => repo.transact(async () => {
    const rows = await repo.adapter.all<{ id: string }>(
      `SELECT id FROM kiosks WHERE paired_at <= ? OR COALESCE(last_seen_at, paired_at) <= ?
       ORDER BY paired_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
      [new Date(now.getTime() - 86400000).toISOString(), new Date(now.getTime() - 300000).toISOString()]);
    for (const row of rows) await repo.deleteKiosk(row.id);
    return rows.length;
  }));
}
