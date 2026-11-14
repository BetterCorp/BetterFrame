import * as av from "anyvali";
import { createError } from "h3";
import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../../../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../../../../models.js";
import { bpAudit } from "../../../../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../../../../shared/coordinator-registry.js";

export const title = "Save cell";
export const description = "Apply a validated change inside the current tenant.";
export const operationId = "frame.layouts.cells.detail.put";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    { serviceId: "cloud.betterportal.frame", viewId: "frame.layouts.cells.detail", permissions: ["update"] },
  ],
};
export const ParamsSchema = av.object({ id: av.string().minLength(1), cellId: av.string().minLength(1) });
export const RequestSchema = av.object({
  row: av.int().min(0).max(63).coerce(),
  col: av.int().min(0).max(63).coerce(),
  row_span: av.int().min(1).max(32).coerce().default(1),
  col_span: av.int().min(1).max(32).coerce().default(1),
  entity_id: av.string().maxLength(128).default(""),
  fit: av.enum_(["cover", "contain", "fill"] as const).default("cover"),
  stream_selector: av.enum_(["auto", "main", "sub"] as const).default("auto"),
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
        const layout = await repo.getLayoutById(params.id);
        if (!layout) throw createError({ statusCode: 404, statusMessage: "Layout not found" });
        if (body.entity_id && !(await repo.getEntityById(body.entity_id)))
          throw createError({ statusCode: 404, statusMessage: "Entity not found" });
        const cells = await repo.listLayoutCells(params.id);
        if (
          cells.some(
            (c) =>
              c.id !== ("cellId" in params ? params.cellId : "") &&
              body.row < c.row + c.row_span &&
              c.row < body.row + body.row_span &&
              body.col < c.col + c.col_span &&
              c.col < body.col + body.col_span,
          )
        )
          throw createError({ statusCode: 409, statusMessage: "Cell overlaps another cell" });
        const cell = await repo.getLayoutCellById(params.cellId);
        if (!cell || cell.layout_id !== params.id)
          throw createError({ statusCode: 404, statusMessage: "Cell not found" });
        await repo.updateLayoutCell(cell.id, { ...body, entity_id: body.entity_id || null });
        await bpAudit(deps, ctx, "frame.layouts.cells.update", cell.id);
        return { id: cell.id, returnPath: "/layouts/" + encodeURIComponent(params.id) + "/cells" };
      });
      getCoordinator().notifyBundleChanged();
      return {
        ok: true as const,
        id: result.id,
        message: "Save cell successful.",
        returnPath: result.returnPath,
      };
    }),
);
