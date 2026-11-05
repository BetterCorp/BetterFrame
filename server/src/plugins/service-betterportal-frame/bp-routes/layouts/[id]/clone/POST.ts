import * as av from "anyvali";
import { createError } from "h3";
import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../../../models.js";
import { bpAudit } from "../../../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../../../shared/coordinator-registry.js";

export const title = "Clone layout";
export const description = "Apply a validated change inside the current tenant.";
export const operationId = "frame.layouts.clone.post";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    { serviceId: "cloud.betterportal.frame", viewId: "frame.layouts.clone", permissions: ["create"] },
  ],
};
export const ParamsSchema = IdSchema;
export const RequestSchema = av.object({});
export const ResponseSchema = ActionSchema;
export default createHandler(
  { params: ParamsSchema, request: RequestSchema, response: ResponseSchema },
  (ctx) =>
    ctx.plugin.withTenant(ctx, async (deps) => {
      const { repo } = deps;
      const body = RequestSchema.parse(ctx.request);
      const params = ParamsSchema.parse(ctx.params);
      const result = await repo.transact(async () => {
        if (!(await repo.getLayoutById(params.id)))
          throw createError({ statusCode: 404, statusMessage: "Layout not found" });
        const layout = await repo.cloneLayout(params.id);
        await bpAudit(deps, ctx, "frame.layouts.clone", layout.id);
        return { id: layout.id, returnPath: "/layouts/" + encodeURIComponent(layout.id) };
      });
      getCoordinator().notifyBundleChanged();
      return {
        ok: true as const,
        id: result.id,
        message: "Clone layout successful.",
        returnPath: result.returnPath,
      };
    }),
);
