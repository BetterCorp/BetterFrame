import * as av from "anyvali";
import { createError } from "h3";
import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../../models.js";
import { bpAudit } from "../../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../../shared/coordinator-registry.js";

export const title = "Save update schedule";
export const description = "Apply a validated change inside the current tenant.";
export const operationId = "frame.settings.schedule.post";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    { serviceId: "cloud.betterportal.frame", viewId: "frame.settings.schedule", permissions: ["update"] },
  ],
};
export const ParamsSchema = av.object({});
export const RequestSchema = av.object({
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
});
export const ResponseSchema = ActionSchema;
export default createHandler(
  { params: ParamsSchema, request: RequestSchema, response: ResponseSchema },
  (ctx) =>
    ctx.plugin.withTenant(ctx, async (deps) => {
      const { repo } = deps;
      const body = RequestSchema.parse(ctx.request);
      const params = ParamsSchema.parse(ctx.params);
      const result = await repo.transact(async () => {
        if (
          body.schedule.mode === "windows" &&
          (!body.schedule.windows.length || body.schedule.windows.some((w) => w.start === w.end))
        )
          throw createError({
            statusCode: 400,
            statusMessage: "At least one nonempty update window required",
          });
        await repo.setSetupExtra("update_schedule", body.schedule);
        await bpAudit(deps, ctx, "frame.settings.schedule.update", "schedule");
        return { id: "schedule", returnPath: "/settings" };
      });
      getCoordinator().notifyBundleChanged();
      return {
        ok: true as const,
        id: result.id,
        message: "Save update schedule successful.",
        returnPath: result.returnPath,
      };
    }),
);
