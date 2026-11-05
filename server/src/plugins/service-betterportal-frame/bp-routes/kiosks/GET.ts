import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ListSchema } from "../../models.js";
export const title = "Kiosks";
export const description = "List kiosks in the current tenant.";
export const operationId = "frame.kiosks.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.kiosks", permissions: ["read"] }],
};
export const ResponseSchema = ListSchema;
export default createHandler({ response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const items = await repo.listKiosks();
    return {
      title,
      detailPath: "/kiosks/:id",
      items: items.map((x) => ({
        id: x.id,
        name: x.name,
        status: x.enabled ? "Enabled" : "Disabled",
        summary: [x.hardware_model, x.kiosk_app_version].filter(Boolean).join(" · "),
      })),
    };
  }),
);

export const dependencies = [{ operationId: "frame.kiosks.pair.post", method: "POST" }] as const;
