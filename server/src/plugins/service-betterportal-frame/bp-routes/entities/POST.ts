import type { ApiAuthRequirement } from "@betterportal/framework";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ActionSchema } from "../../models.js";
import { bpAudit } from "../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../shared/coordinator-registry.js";
export const title = "Create entities";
export const description = "Create a tenant-scoped entities resource.";
export const operationId = "frame.entities.create";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.entities", permissions: ["create"] }],
};
export const RequestSchema = av.object({
  name: av.string().minLength(1).maxLength(128),
  type: av.enum_(["camera", "html", "web", "dashboard"] as const),
  description: av.optional(av.string().maxLength(1024)),
  camera_id: av.optional(av.string().maxLength(128)),
  html_content: av.optional(av.string().maxLength(1000000)),
  web_url: av.optional(av.string().maxLength(2048)),
  dashboard_id: av.optional(av.string().maxLength(128)),
});
export const ResponseSchema = ActionSchema;
export default createHandler({ request: RequestSchema, response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async (deps) => {
    const { repo } = deps;
    const body = RequestSchema.parse(ctx.request);
    const id = await repo.transact(async () => {
      const result = await (async () => {
        if (body.camera_id && !(await repo.getCameraById(body.camera_id)))
          throw createError({ statusCode: 404, statusMessage: "Camera not found" });
        const entity = await repo.createEntity(body);
        return entity.id;
      })();
      await bpAudit(deps, ctx, "frame.entities.create", result);
      return result;
    });
    getCoordinator().notifyBundleChanged();
    return { ok: true as const, id, message: "Created successfully.", returnPath: "/entities" };
  }),
);
