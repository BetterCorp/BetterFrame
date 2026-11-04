import * as av from "anyvali";
import { createError } from "h3";
import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../../models.js";
import { bpAudit } from "../../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../../shared/coordinator-registry.js";
import { confirmPairing } from "../../../../../shared/pairing.js";
export const title = "Pair kiosk";
export const description = "Apply a validated change inside the current tenant.";
export const operationId = "frame.kiosks.pair.post";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    { serviceId: "cloud.betterportal.frame", viewId: "frame.kiosks.pair", permissions: ["create"] },
  ],
};
export const ParamsSchema = av.object({});
export const RequestSchema = av.object({
  code: av.string().pattern("^[A-HJ-NP-Z2-9]{8}$"),
  name: av.string().maxLength(128).default(""),
});
export const ResponseSchema = ActionSchema;
export default createHandler(
  { params: ParamsSchema, request: RequestSchema, response: ResponseSchema },
  (ctx) =>
    ctx.plugin.withTenant(ctx, async (deps) => {
      const { repo } = deps;
      const body = RequestSchema.parse(ctx.request);
      const params = ParamsSchema.parse(ctx.params);
      const result = await repo.transact(async () => {
        const tenant = await repo.adapter.get<{ id: string; slug: string; schema_name: string }>(
          "SELECT id,slug,schema_name FROM public.tenants WHERE schema_name = current_schema()",
        );
        if (!tenant) throw createError({ statusCode: 409, statusMessage: "Tenant resources not ready" });
        const result = await confirmPairing(repo, deps.auth, deps.secrets, {
          code: body.code,
          nameOverride: body.name || undefined,
          tenant: { id: tenant.id, slug: tenant.slug, schemaName: tenant.schema_name },
        });
        await bpAudit(deps, ctx, "frame.kiosks.pair", result.kioskId);
        return { id: result.kioskId, returnPath: "/kiosks/" + encodeURIComponent(result.kioskId) };
      });
      getCoordinator().notifyBundleChanged();
      return {
        ok: true as const,
        id: result.id,
        message: "Pair kiosk successful.",
        returnPath: result.returnPath,
      };
    }),
);
