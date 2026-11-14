import * as av from "anyvali";
import { createError } from "h3";
import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../../../models.js";
import { bpAudit } from "../../../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../../../shared/coordinator-registry.js";

export const title = "Assign label";
export const description = "Apply a validated change inside the current tenant.";
export const operationId = "frame.kiosks.labels.post";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    { serviceId: "cloud.betterportal.frame", viewId: "frame.kiosks.labels", permissions: ["update"] },
  ],
};
export const ParamsSchema = IdSchema;
export const RequestSchema = av.object({
  label_id: av.string().minLength(1).maxLength(128),
  role: av.enum_(["consume", "operate"] as const).default("consume"),
});
export const ResponseSchema = ActionSchema;
export default createHandler(
  { params: ParamsSchema, request: RequestSchema, response: ResponseSchema },
  (ctx) =>
    ctx.plugin.withTenant(ctx, async (deps) => {
      const { repo } = deps;
      const body = RequestSchema.parse(ctx.request);
      const params = ParamsSchema.parse(ctx.params);
      const result = await repo.transact(async () => {
        if (!(await repo.getKioskById(params.id)) || !(await repo.getLabelById(body.label_id)))
          throw createError({ statusCode: 404, statusMessage: "Resource or label not found" });
        await repo.attachKioskLabel(params.id, body.label_id, body.role);
        await bpAudit(deps, ctx, "frame.kiosks.labels.post", params.id);
        return { id: params.id, returnPath: "/kiosks/" + encodeURIComponent(params.id) };
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
