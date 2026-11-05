import type { AdminDeps } from "../../plugins/service-admin-http/index.js";
import type { BpIdentity } from "./bp-tenants.js";
export async function bpAudit(
  deps: AdminDeps,
  ctx: BpIdentity,
  action: string,
  id: string,
  result: "ok" | "failed" = "ok",
): Promise<void> {
  await deps.repo.insertAudit({
    actor_type: "user",
    actor_id: ctx.user!.sub,
    actor_label: ctx.user!.name ?? ctx.user!.sub,
    action,
    resource_type: action.split(".")[1] ?? "frame",
    resource_id: id,
    ip: null,
    metadata: {
      bp_issuer: ctx.user!.iss,
      bp_subject: ctx.user!.sub,
      bp_tenant_id: ctx.tenant.id,
      bp_app_id: ctx.app.id,
    },
    result,
  });
}
