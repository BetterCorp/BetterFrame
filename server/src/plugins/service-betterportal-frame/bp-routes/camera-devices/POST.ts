import type { ApiAuthRequirement } from "@betterportal/framework";
import { encryptCameraCredential } from "../../../../shared/admin/camera-credentials.js";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ActionSchema } from "../../models.js";
import { bpAudit } from "../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../shared/coordinator-registry.js";
export const title = "Create camera devices";
export const description = "Create a tenant-scoped camera devices resource.";
export const operationId = "frame.camera.devices.create";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    { serviceId: "cloud.betterportal.frame", viewId: "frame.camera.devices", permissions: ["create"] },
  ],
};
export const RequestSchema = av.object({
  name: av.string().minLength(1).maxLength(128),
  host: av.string().minLength(1).maxLength(255),
  port: av.int().min(1).max(65535).coerce().default(80),
  username: av.optional(av.string().maxLength(128)),
  password: av.optional(av.string().maxLength(512)),
});
export const ResponseSchema = ActionSchema;
export default createHandler({ request: RequestSchema, response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async (deps) => {
    const { repo } = deps;
    const body = RequestSchema.parse(ctx.request);
    const id = await repo.transact(async () => {
      const result = await (async () => {
        const device = await repo.createCameraDevice({
          ...body,
          password: body.password ? encryptCameraCredential(deps.secrets, body.password) : null,
        });
        return device.id;
      })();
      await bpAudit(deps, ctx, "frame.camera.devices.create", result);
      return result;
    });
    getCoordinator().notifyBundleChanged();
    return { ok: true as const, id, message: "Created successfully.", returnPath: "/camera-devices" };
  }),
);
