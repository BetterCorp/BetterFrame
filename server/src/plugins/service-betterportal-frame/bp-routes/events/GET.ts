import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ListSchema } from "../../models.js";

export const title = "Events";
export const description = "Read tenant-scoped records without exposing credentials.";
export const operationId = "frame.events.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.events", permissions: ["read"] }],
};
export const ResponseSchema = ListSchema;
export default createHandler({ response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const { events: items } = await repo.queryEvents({ limit: 200 });
    return {
      title,
      items: items.map((x) => ({ id: x.id, name: x.topic, status: x.source_type, summary: x.received_at })),
    };
  }),
);
