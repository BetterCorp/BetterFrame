import type { ApiAuthRequirement } from "@betterportal/framework";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../../models.js";
import { bpAudit } from "../../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../../shared/coordinator-registry.js";
export const title = "Delete labels";
export const description = "Delete a tenant-scoped resource.";
export const operationId = "frame.labels.delete";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.labels", permissions: ["delete"] }],
};
export const ParamsSchema = IdSchema;
export const RequestSchema = av.object({});
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
        await repo.deleteLabel(id);
        await bpAudit(deps, ctx, "frame.labels.delete", id);
      });
      getCoordinator().notifyBundleChanged();
      return { ok: true as const, id, message: "Delete successful.", returnPath: "/labels" };
    }),
);
