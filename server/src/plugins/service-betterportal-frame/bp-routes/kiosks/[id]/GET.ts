import type { ApiAuthRequirement } from "@betterportal/framework";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../../.bp-generated/route-runtime.js";
import { IdSchema } from "../../../models.js";
export const title = "Kiosks details";
export const description = "Read one tenant-scoped resource.";
export const operationId = "frame.kiosks.detail.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.kiosks", permissions: ["read"] }],
};
export const ParamsSchema = IdSchema;
export const ResponseSchema = av.object({
  id: av.string(),
  name: av.string(),
  description: av.string(),
  enabled: av.bool(),
});
export default createHandler({ params: ParamsSchema, response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const item = await repo.getKioskById(ctx.params.id);
    if (!item) throw createError({ statusCode: 404, statusMessage: "Resource not found" });
    return { id: item.id, name: item.name, description: item.description ?? "", enabled: item.enabled };
  }),
);

export const dependencies = [
  { operationId: "frame.kiosks.update", method: "PUT" },
  { operationId: "frame.kiosks.power.standby.execute", method: "POST" },
  { operationId: "frame.kiosks.power.wake.execute", method: "POST" },
] as const;
