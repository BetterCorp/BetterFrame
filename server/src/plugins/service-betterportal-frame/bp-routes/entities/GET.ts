import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ListSchema } from "../../models.js";
export const title = "Entities";
export const description = "List entities in the current tenant.";
export const operationId = "frame.entities.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.entities", permissions: ["read"] }],
};
export const ResponseSchema = ListSchema;
export default createHandler({ response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const items = await repo.listEntities();
    return {
      title,
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
