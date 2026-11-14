import type { ApiAuthRequirement } from "@betterportal/framework";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../../models.js";
import { bpAudit } from "../../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../../shared/coordinator-registry.js";
export const title = "Update entities";
export const description = "Update a tenant-scoped resource.";
export const operationId = "frame.entities.update";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.entities", permissions: ["update"] }],
};
export const ParamsSchema = IdSchema;
export const RequestSchema = av.object({
  name: av.optional(av.string().minLength(1).maxLength(128)),
  description: av.optional(av.string().maxLength(1024)),
  html_content: av.optional(av.string().maxLength(1000000)),
  web_url: av.optional(av.string().maxLength(2048)),
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
        const existing = await repo.getEntityById(id);
        if (!existing) throw createError({ statusCode: 404, statusMessage: "Resource not found" });
        if (existing.managed)
          throw createError({
            statusCode: 409,
            statusMessage: "Managed entity must be edited at its source",
          });
        await repo.updateEntity(id, body);
        await bpAudit(deps, ctx, "frame.entities.update", id);
      });
      getCoordinator().notifyBundleChanged();
      return { ok: true as const, id, message: "Update successful.", returnPath: "/entities" };
    }),
);
