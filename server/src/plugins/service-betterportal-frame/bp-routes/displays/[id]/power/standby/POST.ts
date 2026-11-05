import * as av from "anyvali";
import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../../../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../../../../models.js";
import { changePower } from "../../../../../../../shared/admin/bp-workflows.js";
export const operationId = "frame.displays.power.standby.execute";
export const title = "Standby displays";
export const description =
  "Validate ownership and capabilities, deliver command and update state after confirmation.";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    {
      serviceId: "cloud.betterportal.frame",
      viewId: "frame.displays.power.standby",
      permissions: ["update"],
    },
  ],
};
export const ParamsSchema = IdSchema;
export const RequestSchema = av.object({});
export const ResponseSchema = ActionSchema;
export default createHandler(
  { params: ParamsSchema, request: RequestSchema, response: ResponseSchema },
  (ctx) =>
    ctx.plugin.withTenant(ctx, async (deps) => {
      await changePower(deps, ctx, ctx.params.id, "standby", "displays");
      return {
        ok: true as const,
        id: ctx.params.id,
        message: "Power command delivered.",
        returnPath: "/displays/" + encodeURIComponent(ctx.params.id),
      };
    }),
);
