import type { ApiAuthRequirement } from "@betterportal/framework";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../../models.js";
import { bpAudit } from "../../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../../shared/coordinator-registry.js";
export const title = "Update cameras";
export const description = "Update a tenant-scoped resource.";
export const operationId = "frame.cameras.update";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.cameras", permissions: ["update"] }],
};
export const ParamsSchema = IdSchema;
export const RequestSchema = av.object({
  name: av.optional(av.string().minLength(1).maxLength(128)),
  enabled: av.optional(av.bool().coerce()),
  stream_policy: av.optional(av.enum_(["auto", "always_main", "always_sub"] as const)),
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
        const existing = await repo.getCameraById(id);
        if (!existing) throw createError({ statusCode: 404, statusMessage: "Resource not found" });
        await repo.updateCamera(id, body);
        await bpAudit(deps, ctx, "frame.cameras.update", id);
      });
      getCoordinator().notifyBundleChanged();
      return { ok: true as const, id, message: "Update successful.", returnPath: "/cameras" };
    }),
);
