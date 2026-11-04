import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ListSchema } from "../../models.js";
export const title = "ioBOX";
export const description = "List iobox in the current tenant.";
export const operationId = "frame.iobox.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.iobox", permissions: ["read"] }],
};
export const ResponseSchema = ListSchema;
export default createHandler({ response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const items = await repo.listIoBoxes();
    return {
      title,
      detailPath: "/iobox/:id",
      items: items.map((x) => ({
        id: x.id,
        name: x.name,
        status: x.enabled ? x.route_mode : "Disabled",
        summary: `${x.serial} · ${x.model_id}`,
      })),
    };
  }),
);
