import type { ApiAuthRequirement } from "@betterportal/framework";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ActionSchema } from "../../models.js";
import { bpAudit } from "../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../shared/coordinator-registry.js";
export const title = "Create labels";
export const description = "Create a tenant-scoped labels resource.";
export const operationId = "frame.labels.create";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.labels", permissions: ["create"] }],
};
export const RequestSchema = av.object({
  name: av.string().minLength(1).maxLength(64).pattern("^[a-z0-9][a-z0-9_-]*$"),
  description: av.optional(av.string().maxLength(256)),
  color: av.optional(av.string().maxLength(16)),
});
export const ResponseSchema = ActionSchema;
export default createHandler({ request: RequestSchema, response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async (deps) => {
    const { repo } = deps;
    const body = RequestSchema.parse(ctx.request);
    const id = await repo.transact(async () => {
      const result = await (async () => {
        const label = await repo.createLabel(body);
        return label.id;
      })();
      await bpAudit(deps, ctx, "frame.labels.create", result);
      return result;
    });
    getCoordinator().notifyBundleChanged();
    return { ok: true as const, id, message: "Created successfully.", returnPath: "/labels" };
  }),
);
