import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ListSchema } from "../../models.js";
export const title = "AbleSign";
export const description = "List ablesign in the current tenant.";
export const operationId = "frame.ablesign.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.ablesign", permissions: ["read"] }],
};
export const ResponseSchema = ListSchema;
export default createHandler({ response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const items = await repo.listAbleSignAccounts();
    return {
      title,
      items: items.map((x) => ({
        id: String(x.id),
        name: String(x.name),
        status: "Configured",
        summary: "AbleSign account",
      })),
    };
  }),
);
