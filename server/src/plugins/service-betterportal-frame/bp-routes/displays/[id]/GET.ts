import type { ApiAuthRequirement } from "@betterportal/framework";
import * as av from "anyvali";
import { createError } from "h3";
import { createHandler } from "../../../.bp-generated/route-runtime.js";
import { IdSchema } from "../../../models.js";
export const title = "Displays details";
export const description = "Read one tenant-scoped resource.";
export const operationId = "frame.displays.detail.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.displays", permissions: ["read"] }],
};
export const ParamsSchema = IdSchema;
export const ResponseSchema = av.object({
  id: av.string(),
  name: av.string(),
  layouts: av.array(av.object({ id: av.string(), name: av.string() })),
  availableLayouts: av.array(av.object({ id: av.string(), name: av.string() })),
  is_enabled: av.bool(),
  idle_timeout_seconds: av.int(),
  sleep_timeout_seconds: av.int(),
});
export default createHandler({ params: ParamsSchema, response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const item = await repo.getDisplayById(ctx.params.id);
    if (!item) throw createError({ statusCode: 404, statusMessage: "Resource not found" });
    const [layouts, availableLayouts] = await Promise.all([
      repo.listLayoutsForDisplay(item.id),
      repo.listLayouts(),
    ]);
    return {
      id: item.id,
      name: item.name,
      layouts: layouts.map((x) => ({ id: x.id, name: x.name })),
      availableLayouts: availableLayouts.map((x) => ({ id: x.id, name: x.name })),
      is_enabled: item.is_enabled,
      idle_timeout_seconds: item.idle_timeout_seconds,
      sleep_timeout_seconds: item.sleep_timeout_seconds,
    };
  }),
);

export const dependencies = [
  { operationId: "frame.displays.layouts.post", method: "POST" },
  { operationId: "frame.displays.layouts.delete", method: "DELETE" },
  { operationId: "frame.displays.layout.post", method: "POST" },
  { operationId: "frame.displays.update", method: "PUT" },
  { operationId: "frame.displays.power.standby.execute", method: "POST" },
  { operationId: "frame.displays.power.wake.execute", method: "POST" },
] as const;
