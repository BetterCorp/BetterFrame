import type { ApiAuthRequirement } from "@betterportal/framework";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../../models.js";
import { bpAudit } from "../../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../../shared/coordinator-registry.js";
export const title = "Update displays";
export const description = "Update a tenant-scoped resource.";
export const operationId = "frame.displays.update";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.displays", permissions: ["update"] }],
};
export const ParamsSchema = IdSchema;
export const RequestSchema = av.object({
  name: av.optional(av.string().minLength(1).maxLength(128)),
  is_enabled: av.optional(av.bool().coerce()),
  idle_timeout_seconds: av.optional(av.int().min(0).coerce()),
  sleep_timeout_seconds: av.optional(av.int().min(0).coerce()),
});
export const ResponseSchema = ActionSchema;
export default createHandler(
  { params: ParamsSchema, request: RequestSchema, response: ResponseSchema },
  (ctx) =>
    ctx.plugin.withTenant(ctx, async (deps) => {
      const { repo } = deps;
      const id = ctx.params.id;
      const body = RequestSchema.parse(ctx.request);
      await repo.transact(async () => {
        const existing = await repo.getDisplayById(id);
        if (!existing) throw createError({ statusCode: 404, statusMessage: "Resource not found" });
        await repo.updateDisplay(id, body);
        await bpAudit(deps, ctx, "frame.displays.update", id);
      });
      getCoordinator().notifyBundleChanged();
      return { ok: true as const, id, message: "Update successful.", returnPath: "/displays" };
    }),
);
