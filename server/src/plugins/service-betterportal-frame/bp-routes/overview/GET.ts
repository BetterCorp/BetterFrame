import type { ApiAuthRequirement } from "@betterportal/framework";
export const title = "Overview";
export const description = "Fleet status for the current tenant.";
import * as av from "anyvali";
import { createHandler } from "../../.bp-generated/route-runtime.js";
export const operationId = "frame.overview.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.overview", permissions: ["read"] }],
};
export const ResponseSchema = av.object({
  title: av.string(),
  cameras: av.int(),
  kiosks: av.int(),
  displays: av.int(),
  layouts: av.int(),
  ioBoxes: av.int(),
});
export default createHandler({ response: ResponseSchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    const [cameras, kiosks, displays, layouts, boxes] = await Promise.all([
      repo.listCameras(),
      repo.listKiosks(),
      repo.listDisplays(),
      repo.listLayouts(),
      repo.listIoBoxes(),
    ]);
    return {
      title: ctx.tenant.title,
      cameras: cameras.length,
      kiosks: kiosks.length,
      displays: displays.length,
      layouts: layouts.length,
      ioBoxes: boxes.length,
    };
  }),
);
