import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ListSchema } from "../../models.js";
export const title = "Labels";
export const description = "List labels in the current tenant.";
export const operationId = "frame.labels.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.labels", permissions: ["read"] }],
};
export const ResponseSchema = ListSchema;
export default createHandler({ response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const items = await repo.listLabels();
    return {
      title,
      detailPath: "/labels/:id",
      items: items.map((x) => ({ id: x.id, name: x.name, status: "", summary: x.description ?? "" })),
    };
  }),
);

export const dependencies = [{ operationId: "frame.labels.create", method: "POST" }] as const;
