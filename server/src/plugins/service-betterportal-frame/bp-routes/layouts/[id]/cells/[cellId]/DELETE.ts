import * as av from "anyvali";
import { createError } from "h3";
import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../../../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../../../../models.js";
import { bpAudit } from "../../../../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../../../../shared/coordinator-registry.js";

export const title = "Delete cell";
export const description = "Apply a validated change inside the current tenant.";
export const operationId = "frame.layouts.cells.detail.delete";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    { serviceId: "cloud.betterportal.frame", viewId: "frame.layouts.cells.detail", permissions: ["delete"] },
  ],
};
export const ParamsSchema = av.object({ id: av.string().minLength(1), cellId: av.string().minLength(1) });
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
        const cell = await repo.getLayoutCellById(params.cellId);
        if (!cell || cell.layout_id !== params.id)
          throw createError({ statusCode: 404, statusMessage: "Cell not found" });
        await repo.deleteLayoutCell(cell.id);
        await bpAudit(deps, ctx, "frame.layouts.cells.delete", cell.id);
        return { id: cell.id, returnPath: "/layouts/" + encodeURIComponent(params.id) + "/cells" };
      });
      getCoordinator().notifyBundleChanged();
      return {
        ok: true as const,
        id: result.id,
        message: "Delete cell successful.",
        returnPath: result.returnPath,
      };
    }),
);
