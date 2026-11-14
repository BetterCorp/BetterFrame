import * as av from "anyvali";
import { createError } from "h3";
import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../../models.js";
import { bpAudit } from "../../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../../shared/coordinator-registry.js";

export const title = "Save display defaults";
export const description = "Apply a validated change inside the current tenant.";
export const operationId = "frame.settings.display.defaults.post";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    {
      serviceId: "cloud.betterportal.frame",
      viewId: "frame.settings.display.defaults",
      permissions: ["update"],
    },
  ],
};
export const ParamsSchema = av.object({});
export const RequestSchema = av.object({
  layoutIds: av.union([av.array(av.string().minLength(1)), av.string().minLength(1)]).default([]),
  defaultLayoutId: av.string().default(""),
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
        const layoutIds = Array.isArray(body.layoutIds) ? body.layoutIds : [body.layoutIds];
        for (const id of layoutIds)
          if (!(await repo.getLayoutById(id)))
            throw createError({ statusCode: 404, statusMessage: "Layout not found" });
        if (body.defaultLayoutId && !layoutIds.includes(body.defaultLayoutId))
          throw createError({ statusCode: 400, statusMessage: "Default must be an assigned layout" });
        await repo.setSetupExtra("display_defaults", {
          layoutIds,
          defaultLayoutId: body.defaultLayoutId || null,
        });
        await bpAudit(deps, ctx, "frame.settings.display.defaults.update", "display-defaults");
        return { id: "display-defaults", returnPath: "/settings" };
      });
      getCoordinator().notifyBundleChanged();
      return {
        ok: true as const,
        id: result.id,
        message: "Save display defaults successful.",
        returnPath: result.returnPath,
      };
    }),
);
