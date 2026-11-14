import * as av from "anyvali";
import { listProviders } from "../../../../shared/cloud-cameras/index.js";
import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ListSchema } from "../../models.js";
export const title = "Cloud accounts";
export const description = "List cloud accounts in the current tenant.";
export const operationId = "frame.cloud.accounts.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [
    { serviceId: "cloud.betterportal.frame", viewId: "frame.cloud.accounts", permissions: ["read"] },
  ],
};
export const ResponseSchema = av.object({
  title: av.string(),
  items: av.array(
    av.object({ id: av.string(), name: av.string(), status: av.string(), summary: av.string() }),
  ),
  providers: av.array(
    av.object({
      vendor: av.string(),
      fields: av.array(
        av.object({ name: av.string(), label: av.string(), secret: av.bool(), required: av.bool() }),
      ),
    }),
  ),
});
export default createHandler({ response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const items = await repo.listCloudAccounts();
    return {
      title,
      providers: listProviders().map((p) => ({
        vendor: p.vendor,
        fields: p
          .credentialFields()
          .map((f) => ({
            name: f.name,
            label: f.label,
            secret: f.type === "password",
            required: f.required === true,
          })),
      })),
      items: items.map((x) => ({ id: x.id, name: x.name, status: "Configured", summary: x.vendor })),
    };
  }),
);

export const dependencies = [
  { operationId: "frame.cloud.accounts.post", method: "POST" },
  { operationId: "frame.cloud.accounts.sync.post", method: "POST" },
  { operationId: "frame.cloud.accounts.delete.delete", method: "DELETE" },
] as const;
