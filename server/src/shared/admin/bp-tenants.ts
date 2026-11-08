import { createHash } from "node:crypto";
import { createError } from "h3";
import type { RouteHandlerContext } from "@betterportal/framework";
import type { Repository } from "../db/repository.js";
import { createTenantSchema } from "../db/init.js";
import type { Tenant } from "../types.js";

export type BpIdentity = Pick<RouteHandlerContext, "user" | "tenant" | "app">;

/** Called only by BP handlers after the framework enforces operation permissions. */
export function assertBpIdentity(ctx: BpIdentity): void {
  if (
    !ctx.user ||
    ctx.user.tokenType !== "access" ||
    !ctx.user.sub ||
    ctx.user.tenantId !== ctx.tenant.id ||
    ctx.user.appId !== ctx.app.id ||
    ctx.app.tenantId !== ctx.tenant.id ||
    !ctx.tenant.active
  ) {
    throw createError({ statusCode: 403, statusMessage: "Verified active BP tenant and user required" });
  }
}

/** Local schema/default provisioning only; never creates a BP tenant or human user. */
export async function ensureBpTenant(
  repo: Repository,
  installationId: string,
  ctx: BpIdentity,
  onCreated: () => void = () => {},
): Promise<Tenant> {
  assertBpIdentity(ctx);
  if (!installationId.trim()) throw new Error("BP installation trust identifier is required");
  return repo.adapter.withSearchPath("public", () =>
    repo.adapter.transaction(async () => {
      // Same lock as startup and legacy tenant creation; acquired before any row locks.
      await repo.adapter.get("SELECT pg_advisory_xact_lock(734192081)");
      const binding = await repo.adapter.get<{ frame_tenant_id: string; state: string }>(
        "SELECT frame_tenant_id, state FROM public.bp_tenant_bindings WHERE installation_id = ? AND bp_tenant_id = ?",
        [installationId, ctx.tenant.id],
      );
      if (binding) {
        const tenant = await repo.getTenantById(binding.frame_tenant_id);
        if (binding.state !== "ready" || !tenant?.is_active) {
          throw createError({ statusCode: 403, statusMessage: "Frame tenant resources unavailable" });
        }
        return tenant;
      }
      const suffix = createHash("sha256")
        .update(JSON.stringify([installationId, ctx.tenant.id]))
        .digest("hex")
        .slice(0, 32);
      const slug = `bp-${suffix}`;
      if (await repo.getTenantBySlug(slug))
        throw new Error("Unbound Frame tenant requires explicit migration mapping");
      const tenant = await repo.createTenant({ name: ctx.tenant.title, slug });
      await repo.adapter.run(
        "INSERT INTO public.bp_tenant_bindings (installation_id, bp_tenant_id, frame_tenant_id, state) VALUES (?, ?, ?, 'provisioning')",
        [installationId, ctx.tenant.id, tenant.id],
      );
      await createTenantSchema(repo.adapter, tenant.slug, { info() {}, warn() {} });
      await repo.adapter.withSearchPath(tenant.schema_name, () => repo.markSetupComplete());
      await repo.adapter.run(
        "UPDATE public.bp_tenant_bindings SET state = 'ready' WHERE installation_id = ? AND bp_tenant_id = ?",
        [installationId, ctx.tenant.id],
      );
      // The schema and ready marker commit together. Any failure rolls back all setup.
      repo.adapter.afterCommit?.(onCreated);
      return tenant;
    }),
  );
}

/** Operator-only migration helper: exact identifiers, no slug/email adoption. */
export async function bindExistingBpTenant(
  repo: Repository,
  installationId: string,
  bpTenantId: string,
  frameTenantId: string,
): Promise<void> {
  if (!installationId.trim() || !/^[0-9a-f-]{36}$/i.test(bpTenantId))
    throw new Error("Installation and BP tenant UUID required");
  await repo.adapter.withSearchPath("public", () =>
    repo.adapter.transaction(async () => {
      await repo.adapter.get("SELECT pg_advisory_xact_lock(734192081)");
      const tenant = await repo.getTenantById(frameTenantId);
      if (!tenant?.is_active) throw new Error("Existing active Frame tenant required");
      const existing = await repo.adapter.get<{ frame_tenant_id: string; state: string }>(
        "SELECT frame_tenant_id, state FROM public.bp_tenant_bindings WHERE installation_id = ? AND bp_tenant_id = ?",
        [installationId, bpTenantId],
      );
      if (existing) {
        if (existing.frame_tenant_id !== frameTenantId || existing.state !== "ready")
          throw new Error("Binding already exists or is revoked");
        return;
      }
      await repo.adapter.run(
        "INSERT INTO public.bp_tenant_bindings (installation_id, bp_tenant_id, frame_tenant_id) VALUES (?, ?, ?)",
        [installationId, bpTenantId, frameTenantId],
      );
    }),
  );
}
