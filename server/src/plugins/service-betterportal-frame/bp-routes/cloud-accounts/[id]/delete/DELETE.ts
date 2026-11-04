import * as av from "anyvali";
import { createError } from "h3";
import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../../../models.js";
import { bpAudit } from "../../../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../../../shared/coordinator-registry.js";
import { syncCloudAccount } from "../../../../../../shared/admin/cloud.js";
export const title = "Delete cloud account";
export const description = "Apply a validated change inside the current tenant.";
export const operationId = "frame.cloud.accounts.delete.delete";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    { serviceId: "cloud.betterportal.frame", viewId: "frame.cloud.accounts.delete", permissions: ["delete"] },
  ],
};
export const ParamsSchema = IdSchema;
export const RequestSchema = av.object({});
export const ResponseSchema = ActionSchema;
export default createHandler(
  { params: ParamsSchema, request: RequestSchema, response: ResponseSchema },
  (ctx) =>
    ctx.plugin.withTenant(ctx, async (deps) => {
      const { repo } = deps;
      const body = RequestSchema.parse(ctx.request);
      const params = ParamsSchema.parse(ctx.params);
      const result = await repo.transact(async () => {
        if (!(await repo.getCloudAccount(params.id)))
          throw createError({ statusCode: 404, statusMessage: "Account not found" });
        await repo.deleteCloudAccount(params.id);
        await bpAudit(deps, ctx, "frame.cloud.accounts.delete", params.id);
        return { id: params.id, returnPath: "/cloud-accounts" };
      });
      getCoordinator().notifyBundleChanged();
      return {
        ok: true as const,
        id: result.id,
        message: "Delete cloud account successful.",
        returnPath: result.returnPath,
      };
    }),
);
