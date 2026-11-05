import type { ApiAuthRequirement } from "@betterportal/framework";
import { encryptCameraCredential } from "../../../../shared/admin/camera-credentials.js";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ActionSchema } from "../../models.js";
import { bpAudit } from "../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../shared/coordinator-registry.js";
export const title = "Create cameras";
export const description = "Create a tenant-scoped cameras resource.";
export const operationId = "frame.cameras.create";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.cameras", permissions: ["create"] }],
};
export const RequestSchema = av.object({
  name: av.string().minLength(1).maxLength(128),
  type: av.enum_(["rtsp", "onvif"] as const),
  rtsp_url: av.optional(av.string().maxLength(2048)),
  onvif_host: av.optional(av.string().maxLength(255)),
  onvif_port: av.optional(av.int().min(1).max(65535).coerce()),
  onvif_username: av.optional(av.string().maxLength(128)),
  onvif_password: av.optional(av.string().maxLength(512)),
});
export const ResponseSchema = ActionSchema;
export default createHandler({ request: RequestSchema, response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async (deps) => {
    const { repo } = deps;
    const body = RequestSchema.parse(ctx.request);
    if (body.type === "rtsp" && !body.rtsp_url?.startsWith("rtsp://"))
      throw createError({ statusCode: 400, statusMessage: "RTSP URL required" });
    if (body.type === "onvif" && !body.onvif_host)
      throw createError({ statusCode: 400, statusMessage: "ONVIF host required" });
    const id = await repo.transact(async () => {
      const result = await (async () => {
        const camera = await repo.createCamera({
          ...body,
          rtsp_url: body.rtsp_url ? encryptCameraCredential(deps.secrets, body.rtsp_url) : null,
          onvif_password: body.onvif_password
            ? encryptCameraCredential(deps.secrets, body.onvif_password)
            : null,
        });
        return camera.id;
      })();
      await bpAudit(deps, ctx, "frame.cameras.create", result);
      return result;
    });
    getCoordinator().notifyBundleChanged();
    return { ok: true as const, id, message: "Created successfully.", returnPath: "/cameras" };
  }),
);
