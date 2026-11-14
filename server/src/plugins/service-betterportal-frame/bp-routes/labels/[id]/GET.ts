import type { ApiAuthRequirement } from "@betterportal/framework";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../../.bp-generated/route-runtime.js";
import { IdSchema } from "../../../models.js";
export const title = "Labels details";
export const description = "Read one tenant-scoped resource.";
export const operationId = "frame.labels.detail.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.labels", permissions: ["read"] }],
};
export const ParamsSchema = IdSchema;
export const ResponseSchema = av.object({
  id: av.string(),
  name: av.string(),
  description: av.string(),
  color: av.string(),
});
export default createHandler({ params: ParamsSchema, response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const item = await repo.getLabelById(ctx.params.id);
    if (!item) throw createError({ statusCode: 404, statusMessage: "Resource not found" });
    return { id: item.id, name: item.name, description: item.description ?? "", color: item.color ?? "" };
  }),
);

export const dependencies = [
  { operationId: "frame.labels.update", method: "PUT" },
  { operationId: "frame.labels.delete", method: "DELETE" },
] as const;
