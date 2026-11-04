import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ListSchema } from "../../models.js";
export const title = "Displays";
export const description = "List displays in the current tenant.";
export const operationId = "frame.displays.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.displays", permissions: ["read"] }],
};
export const ResponseSchema = ListSchema;
export default createHandler({ response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const items = await repo.listDisplays();
    return {
      title,
      detailPath: "/displays/:id",
      items: items.map((x) => ({
        id: x.id,
        name: x.name,
        status: x.is_enabled ? x.actual_power_state : "Disabled",
        summary: `${x.width_px} × ${x.height_px}`,
      })),
    };
  }),
);
