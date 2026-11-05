import * as av from "anyvali";
import { createError } from "h3";
import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../../../models.js";
import { bpAudit } from "../../../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../../../shared/coordinator-registry.js";

export const title = "Assign label";
export const description = "Apply a validated change inside the current tenant.";
export const operationId = "frame.camera.devices.labels.post";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    { serviceId: "cloud.betterportal.frame", viewId: "frame.camera.devices.labels", permissions: ["update"] },
  ],
};
export const ParamsSchema = IdSchema;
export const RequestSchema = av.object({ label_id: av.string().minLength(1).maxLength(128) });
export const ResponseSchema = ActionSchema;
export default createHandler(
  { params: ParamsSchema, request: RequestSchema, response: ResponseSchema },
  (ctx) =>
    ctx.plugin.withTenant(ctx, async (deps) => {
      const { repo } = deps;
      const body = RequestSchema.parse(ctx.request);
      const params = ParamsSchema.parse(ctx.params);
      const result = await repo.transact(async () => {
        if (!(await repo.getCameraDeviceById(params.id)) || !(await repo.getLabelById(body.label_id)))
          throw createError({ statusCode: 404, statusMessage: "Resource or label not found" });
        await repo.attachCameraDeviceLabel(params.id, body.label_id);
        await bpAudit(deps, ctx, "frame.camera-devices.labels.post", params.id);
        return { id: params.id, returnPath: "/camera-devices/" + encodeURIComponent(params.id) };
      });
      getCoordinator().notifyBundleChanged();
      return {
        ok: true as const,
        id: result.id,
        message: "Assign label successful.",
        returnPath: result.returnPath,
      };
    }),
);
