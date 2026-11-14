import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ListSchema } from "../../models.js";
export const title = "Layouts";
export const description = "List layouts in the current tenant.";
export const operationId = "frame.layouts.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.layouts", permissions: ["read"] }],
};
export const ResponseSchema = ListSchema;
export default createHandler({ response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const items = await repo.listLayouts();
    return {
      title,
      detailPath: "/layouts/:id",
      items: items.map((x) => ({ id: x.id, name: x.name, status: x.priority, summary: x.description ?? "" })),
    };
  }),
);

export const dependencies = [{ operationId: "frame.layouts.create", method: "POST" }] as const;
