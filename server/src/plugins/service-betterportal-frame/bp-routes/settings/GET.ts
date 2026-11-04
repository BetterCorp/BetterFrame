import * as av from "anyvali";
import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { normalizeUpdateSchedule } from "../../../../shared/update-schedule.js";
export const title = "Settings";
export const description = "Update windows and display defaults for this tenant.";
export const operationId = "frame.settings.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.settings", permissions: ["read"] }],
};
export const ResponseSchema = av.object({
  schedule: av.object({
    mode: av.enum_(["always", "windows"] as const),
    windows: av
      .array(
        av.object({
          day: av.int().min(0).max(6).coerce(),
          start: av.string().pattern("^([01][0-9]|2[0-3]):[0-5][0-9]$"),
          end: av.string().pattern("^([01][0-9]|2[0-3]):[0-5][0-9]$"),
        }),
      )
      .default([]),
  }),
  layouts: av.array(av.object({ id: av.string(), name: av.string() })),
  layoutIds: av.array(av.string()),
  defaultLayoutId: av.string(),
});
export const dependencies = [
  { operationId: "frame.settings.schedule.post", method: "POST" },
  { operationId: "frame.settings.display.defaults.post", method: "POST" },
] as const;
export default createHandler({ response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const [raw, defaults, layouts] = await Promise.all([
      repo.getSetupExtra("update_schedule"),
      repo.getDisplayDefaults(),
      repo.listLayouts(),
    ]);
    return {
      schedule: normalizeUpdateSchedule(raw),
      layouts: layouts.map((l) => ({ id: l.id, name: l.name })),
      layoutIds: defaults.layoutIds,
      defaultLayoutId: defaults.defaultLayoutId ?? "",
    };
  }),
);
