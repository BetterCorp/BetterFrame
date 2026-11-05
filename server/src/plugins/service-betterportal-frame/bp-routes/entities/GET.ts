import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import * as av from "anyvali";
import { ItemSchema } from "../../models.js";
import { isBpAdmin } from "../../../../shared/admin/bp-access.js";
export const title = "Entities";
export const description = "List entities in the current tenant.";
export const operationId = "frame.entities.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    {
      serviceId: "cloud.betterportal.frame",
      viewId: "frame.entities",
      permissions: ["read"],
    },
  ],
};
export const ResponseSchema = av.object({
  title: av.string(),
  detailPath: av.string(),
  items: av.array(ItemSchema),
  canUseNodeRed: av.bool(),
  cameras: av.array(av.object({ id: av.string(), name: av.string() })),
});
export default createHandler({ response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const items = await repo.listEntities();
    return {
      title,
      canUseNodeRed: isBpAdmin(ctx),
      cameras: (await repo.listCameras()).map((camera) => ({
        id: camera.id,
        name: camera.name,
      })),
      detailPath: "/entities/:id",
      items: items.map((x) => ({
        id: x.id,
        name: x.name,
        status: x.managed ? "Managed" : "Custom",
        summary: x.type,
      })),
    };
  }),
);

export const dependencies = [{ operationId: "frame.entities.create", method: "POST" }] as const;
