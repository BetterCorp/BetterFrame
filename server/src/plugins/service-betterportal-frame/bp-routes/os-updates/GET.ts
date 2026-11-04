import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ListSchema } from "../../models.js";
export const title = "OS updates";
export const description = "List os updates in the current tenant.";
export const operationId = "frame.os.updates.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.os.updates", permissions: ["read"] }],
};
export const ResponseSchema = ListSchema;
export default createHandler({ response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const items = await repo.listOsUpdateReleases();
    return {
      title,
      items: items.map((x) => ({
        id: x.id,
        name: x.version,
        status: x.yanked_at ? "Withdrawn" : x.channel,
        summary: x.compatibility,
      })),
    };
  }),
);
