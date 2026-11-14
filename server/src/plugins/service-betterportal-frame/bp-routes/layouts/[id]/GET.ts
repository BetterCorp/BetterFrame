import type { ApiAuthRequirement } from "@betterportal/framework";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../../.bp-generated/route-runtime.js";
import { IdSchema } from "../../../models.js";
export const title = "Layouts details";
export const description = "Read one tenant-scoped resource.";
export const operationId = "frame.layouts.detail.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.layouts", permissions: ["read"] }],
};
export const ParamsSchema = IdSchema;
export const ResponseSchema = av.object({
  id: av.string(),
  name: av.string(),
  description: av.string(),
  priority: av.string(),
  cooling_timeout_seconds: av.int(),
  idle_timeout_seconds: av.int(),
});
export default createHandler({ params: ParamsSchema, response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const item = await repo.getLayoutById(ctx.params.id);
    if (!item) throw createError({ statusCode: 404, statusMessage: "Resource not found" });
    return {
      id: item.id,
      name: item.name,
      description: item.description ?? "",
      priority: item.priority,
      cooling_timeout_seconds: item.cooling_timeout_seconds ?? 0,
      idle_timeout_seconds: item.idle_timeout_seconds ?? 0,
    };
  }),
);

export const dependencies = [
  { operationId: "frame.layouts.update", method: "PUT" },
  { operationId: "frame.layouts.delete", method: "DELETE" },
] as const;
