import type { ApiAuthRequirement } from "@betterportal/framework";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../../.bp-generated/route-runtime.js";
import { IdSchema } from "../../../models.js";
export const title = "Camera devices details";
export const description = "Read one tenant-scoped resource.";
export const operationId = "frame.camera.devices.detail.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    { serviceId: "cloud.betterportal.frame", viewId: "frame.camera.devices", permissions: ["read"] },
  ],
};
export const ParamsSchema = IdSchema;
export const ResponseSchema = av.object({
  id: av.string(),
  name: av.string(),
  host: av.string(),
  port: av.int(),
});
export default createHandler({ params: ParamsSchema, response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const item = await repo.getCameraDeviceById(ctx.params.id);
    if (!item) throw createError({ statusCode: 404, statusMessage: "Resource not found" });
    return { id: item.id, name: item.name, host: item.host, port: item.port };
  }),
);

export const dependencies = [
  { operationId: "frame.camera.devices.update", method: "PUT" },
  { operationId: "frame.camera.devices.delete", method: "DELETE" },
] as const;
