import * as av from "anyvali";
import { createError } from "h3";
import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { IdSchema, ActionSchema } from "../../models.js";
import { bpAudit } from "../../../../shared/admin/bp-audit.js";
import { getCoordinator } from "../../../../shared/coordinator-registry.js";
import { randomUUID } from "node:crypto";
import { getProvider } from "../../../../shared/cloud-cameras/index.js";
export const title = "Add cloud account";
export const description = "Apply a validated change inside the current tenant.";
export const operationId = "frame.cloud.accounts.post";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    { serviceId: "cloud.betterportal.frame", viewId: "frame.cloud.accounts", permissions: ["create"] },
  ],
};
export const ParamsSchema = av.object({});
export const RequestSchema = av.object({
  name: av.string().minLength(1).maxLength(128),
  vendor: av.enum_(["hikconnect", "dahua", "tuya", "uniview", "tplink"] as const),
  credentials: av.record(av.string().maxLength(4096)),
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
        if (deps.sandboxMode)
          throw createError({
            statusCode: 409,
            statusMessage: "External credential checks are disabled in the test deployment",
          });
        const provider = getProvider(body.vendor);
        if (!provider) throw createError({ statusCode: 400, statusMessage: "Unsupported provider" });
        const credentials: Record<string, string> = {};
        for (const field of provider.credentialFields()) {
          const value = body.credentials[field.name]?.trim() ?? "";
          if (field.required && !value)
            throw createError({ statusCode: 400, statusMessage: "Required provider credential missing" });
          if (value) credentials[field.name] = value;
        }
        const test = await provider.testCredentials(credentials);
        if (!test.ok)
          throw createError({ statusCode: 400, statusMessage: "Provider credential verification failed" });
        const id = randomUUID();
        await repo.createCloudAccount({
          id,
          name: body.name,
          vendor: body.vendor,
          credentials_encrypted: deps.secrets.encryptString(JSON.stringify(credentials), "cloud-creds"),
        });
        await bpAudit(deps, ctx, "frame.cloud.accounts.create", id);
        return { id, returnPath: "/cloud-accounts" };
      });
      getCoordinator().notifyBundleChanged();
      return {
        ok: true as const,
        id: result.id,
        message: "Add cloud account successful.",
        returnPath: result.returnPath,
      };
    }),
);
