import type { ApiAuthRequirement } from "@betterportal/framework";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ActionSchema } from "../../models.js";
import { bpAudit } from "../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../shared/coordinator-registry.js";
export const title = "Create layouts";
export const description = "Create a tenant-scoped layouts resource.";
export const operationId = "frame.layouts.create";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.layouts", permissions: ["create"] }],
};
export const RequestSchema = av.object({
  name: av.string().minLength(1).maxLength(128),
  description: av.optional(av.string().maxLength(1024)),
  priority: av.enum_(["hot", "normal", "cold"] as const).default("normal"),
  cooling_timeout_seconds: av.optional(av.int().min(0).coerce()),
  idle_timeout_seconds: av.optional(av.int().min(0).coerce()),
});
export const ResponseSchema = ActionSchema;
export default createHandler({ request: RequestSchema, response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async (deps) => {
    const { repo } = deps;
    const body = RequestSchema.parse(ctx.request);
    const id = await repo.transact(async () => {
      const result = await (async () => {
        const layout = await repo.createLayout(body);
        return layout.id;
      })();
      await bpAudit(deps, ctx, "frame.layouts.create", result);
      return result;
    });
    getCoordinator().notifyBundleChanged();
    return { ok: true as const, id, message: "Created successfully.", returnPath: "/layouts" };
  }),
);
