import * as av from "anyvali";
import { createError } from "h3";
import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../../../.bp-generated/route-runtime.js";
import { IdSchema } from "../../../../models.js";
export const title = "Layout cells";
export const description = "Read the layout grid and available entities.";
export const operationId = "frame.layouts.cells.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    { serviceId: "cloud.betterportal.frame", viewId: "frame.layouts.cells", permissions: ["read"] },
  ],
};
export const ParamsSchema = IdSchema;
const CellSchema = av.object({
  id: av.string(),
  row: av.int(),
  col: av.int(),
  row_span: av.int(),
  col_span: av.int(),
  entity_id: av.string(),
  fit: av.string(),
  stream_selector: av.string(),
});
export const ResponseSchema = av.object({
  id: av.string(),
  name: av.string(),
  cells: av.array(CellSchema),
  entities: av.array(av.object({ id: av.string(), name: av.string() })),
});
export const dependencies = [
  { operationId: "frame.layouts.cells.post", method: "POST" },
  { operationId: "frame.layouts.cells.detail.put", method: "PUT" },
  { operationId: "frame.layouts.cells.detail.delete", method: "DELETE" },
] as const;
export default createHandler({ params: ParamsSchema, response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    const layout = await repo.getLayoutById(ctx.params.id);
    if (!layout) throw createError({ statusCode: 404, statusMessage: "Layout not found" });
    const [cells, entities] = await Promise.all([repo.listLayoutCells(layout.id), repo.listEntities()]);
    return {
      id: layout.id,
      name: layout.name,
      entities: entities.map((e) => ({ id: e.id, name: e.name })),
      cells: cells.map((c) => ({
        id: c.id,
        row: c.row,
        col: c.col,
        row_span: c.row_span,
        col_span: c.col_span,
        entity_id: c.entity_id ?? "",
        fit: c.fit,
        stream_selector: c.stream_selector,
      })),
    };
  }),
);
