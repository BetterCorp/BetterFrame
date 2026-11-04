import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ListSchema } from "../../models.js";
export const title = "Cameras";
export const description = "List cameras in the current tenant.";
export const operationId = "frame.cameras.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.cameras", permissions: ["read"] }],
};
export const ResponseSchema = ListSchema;
export default createHandler({ response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const items = await repo.listCameras();
    return {
      title,
      detailPath: "/cameras/:id",
      items: items.map((x) => ({
        id: x.id,
        name: x.name,
        status: x.enabled ? "Enabled" : "Disabled",
        summary: x.type,
      })),
    };
  }),
);

export const dependencies = [{ operationId: "frame.cameras.create", method: "POST" }] as const;
