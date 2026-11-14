import type { ApiAuthRequirement } from "@betterportal/framework";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../../.bp-generated/route-runtime.js";
import { IdSchema } from "../../../models.js";
export const title = "Entities details";
export const description = "Read one tenant-scoped resource.";
export const operationId = "frame.entities.detail.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.entities", permissions: ["read"] }],
};
export const ParamsSchema = IdSchema;
export const ResponseSchema = av.object({
  id: av.string(),
  name: av.string(),
  description: av.string(),
  html_content: av.string(),
  web_url: av.string(),
});
export default createHandler({ params: ParamsSchema, response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const item = await repo.getEntityById(ctx.params.id);
    if (!item) throw createError({ statusCode: 404, statusMessage: "Resource not found" });
    return {
      id: item.id,
      name: item.name,
      description: item.description ?? "",
      html_content: item.html_content ?? "",
      web_url: item.web_url ?? "",
    };
  }),
);

export const dependencies = [
  { operationId: "frame.entities.update", method: "PUT" },
  { operationId: "frame.entities.delete", method: "DELETE" },
] as const;
