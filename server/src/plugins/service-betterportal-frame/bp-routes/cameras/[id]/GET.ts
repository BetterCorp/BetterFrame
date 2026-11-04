import type { ApiAuthRequirement } from "@betterportal/framework";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../../.bp-generated/route-runtime.js";
import { IdSchema } from "../../../models.js";
export const title = "Cameras details";
export const description = "Read one tenant-scoped resource.";
export const operationId = "frame.cameras.detail.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.cameras", permissions: ["read"] }],
};
export const ParamsSchema = IdSchema;
export const ResponseSchema = av.object({
  id: av.string(),
  name: av.string(),
  enabled: av.bool(),
  stream_policy: av.string(),
});
export default createHandler({ params: ParamsSchema, response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const item = await repo.getCameraById(ctx.params.id);
    if (!item) throw createError({ statusCode: 404, statusMessage: "Resource not found" });
    return { id: item.id, name: item.name, enabled: item.enabled, stream_policy: item.stream_policy };
  }),
);

export const dependencies = [
  { operationId: "frame.cameras.update", method: "PUT" },
  { operationId: "frame.cameras.delete", method: "DELETE" },
] as const;
