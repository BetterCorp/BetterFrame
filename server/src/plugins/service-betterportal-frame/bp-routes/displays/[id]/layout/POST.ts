import * as av from "anyvali";
import { createError } from "h3";
import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../../../models.js";
import { bpAudit } from "../../../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../../../shared/coordinator-registry.js";
import { switchLayout } from "../../../../../../shared/admin/bp-workflows.js";
export const title = "Switch layout";
export const description = "Apply a validated change inside the current tenant.";
export const operationId = "frame.displays.layout.post";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    { serviceId: "cloud.betterportal.frame", viewId: "frame.displays.layout", permissions: ["update"] },
  ],
};
export const ParamsSchema = IdSchema;
export const RequestSchema = av.object({ layout_id: av.string().minLength(1).maxLength(128) });
export const ResponseSchema = ActionSchema;
export default createHandler(
  { params: ParamsSchema, request: RequestSchema, response: ResponseSchema },
  (ctx) =>
    ctx.plugin.withTenant(ctx, async (deps) => {
      const { repo } = deps;
      const body = RequestSchema.parse(ctx.request);
      const params = ParamsSchema.parse(ctx.params);
      const result = await repo.transact(async () => {
        await switchLayout(deps, ctx, params.id, body.layout_id);
        return { id: params.id, returnPath: "/displays/" + encodeURIComponent(params.id) };
      });
      getCoordinator().notifyBundleChanged();
      return {
        ok: true as const,
        id: result.id,
        message: "Switch layout successful.",
        returnPath: result.returnPath,
      };
    }),
);
