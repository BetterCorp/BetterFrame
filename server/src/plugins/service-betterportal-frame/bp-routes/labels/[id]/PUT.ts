import type { ApiAuthRequirement } from "@betterportal/framework";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../../models.js";
import { bpAudit } from "../../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../../shared/coordinator-registry.js";
export const title = "Update labels";
export const description = "Update a tenant-scoped resource.";
export const operationId = "frame.labels.update";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.labels", permissions: ["update"] }],
};
export const ParamsSchema = IdSchema;
export const RequestSchema = av.object({
  name: av.optional(av.string().minLength(1).maxLength(64).pattern("^[a-z0-9][a-z0-9_-]*$")),
  description: av.optional(av.string().maxLength(256)),
  color: av.optional(av.string().maxLength(16)),
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
        const existing = await repo.getLabelById(id);
        if (!existing) throw createError({ statusCode: 404, statusMessage: "Resource not found" });
        await repo.updateLabel(id, body);
        await bpAudit(deps, ctx, "frame.labels.update", id);
      });
      getCoordinator().notifyBundleChanged();
      return { ok: true as const, id, message: "Update successful.", returnPath: "/labels" };
    }),
);
