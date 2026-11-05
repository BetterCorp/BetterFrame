import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ListSchema } from "../../models.js";
export const title = "Firmware";
export const description = "List firmware in the current tenant.";
export const operationId = "frame.firmware.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.firmware", permissions: ["read"] }],
};
export const ResponseSchema = ListSchema;
export default createHandler({ response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const items = await repo.listFirmwareReleases();
    return {
      title,
      items: items.map((x) => ({
        id: x.id,
        name: x.version,
        status: x.yanked_at ? "Withdrawn" : x.channel,
        summary: x.arch,
      })),
    };
  }),
);
