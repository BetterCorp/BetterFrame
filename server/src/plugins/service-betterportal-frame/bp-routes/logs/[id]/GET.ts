import * as av from "anyvali";
import { createError } from "h3";
import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../../.bp-generated/route-runtime.js";
import { IdSchema } from "../../../models.js";
export const title = "Diagnostic log";
export const description = "Read an unexpired log from the current tenant.";
export const operationId = "frame.logs.detail.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.logs", permissions: ["read"] }],
};
export const ParamsSchema = IdSchema;
export const ResponseSchema = av.object({
  id: av.string(),
  kioskId: av.string(),
  level: av.string(),
  message: av.string(),
  loggedAt: av.string(),
});
export default createHandler({ params: ParamsSchema, response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const log = await repo.getKioskLog(ctx.params.id);
    if (!log) throw createError({ statusCode: 404, statusMessage: "Log expired or unavailable" });
    return {
      id: log.id,
      kioskId: log.kiosk_id,
      level: log.level,
      message: log.message,
      loggedAt: log.logged_at,
    };
  }),
);
