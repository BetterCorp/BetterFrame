import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ListSchema } from "../../models.js";
export const title = "Camera devices";
export const description = "List camera devices in the current tenant.";
export const operationId = "frame.camera.devices.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    { serviceId: "cloud.betterportal.frame", viewId: "frame.camera.devices", permissions: ["read"] },
  ],
};
export const ResponseSchema = ListSchema;
export default createHandler({ response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const items = await repo.listCameraDevices();
    return {
      title,
      detailPath: "/camera-devices/:id",
      items: items.map((x) => ({ id: x.id, name: x.name, status: x.type, summary: `${x.host}:${x.port}` })),
    };
  }),
);

export const dependencies = [{ operationId: "frame.camera.devices.create", method: "POST" }] as const;
