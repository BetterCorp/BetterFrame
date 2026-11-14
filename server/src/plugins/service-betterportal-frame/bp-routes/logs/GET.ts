import type { ApiAuthRequirement } from "@betterportal/framework";
import { createHandler } from "../../.bp-generated/route-runtime.js";
import { ListSchema } from "../../models.js";
import { encodeLogCursor, parseLogFilters } from "../../../../shared/kiosk-log-view.js";
import * as av from "anyvali";
export const QuerySchema = av.object({
  q: av.optional(av.string().maxLength(256)),
  level: av.optional(av.enum_(["", "debug", "info", "warn", "error"] as const)),
  kiosk: av.optional(av.string().maxLength(128)),
  from: av.optional(av.string()),
  until: av.optional(av.string()),
  before: av.optional(av.string()),
  source: av.optional(av.enum_(["", "app", "os"] as const)),
  limit: av.optional(av.string()),
});

export const title = "Diagnostic logs";
export const description = "Read tenant-scoped records without exposing credentials.";
export const operationId = "frame.logs.read";
export const auth: ApiAuthRequirement = {
  required: true,
  permissions: [{ serviceId: "cloud.betterportal.frame", viewId: "frame.logs", permissions: ["read"] }],
};
export const ResponseSchema = av.object({
  title: av.string(),
  items: av.array(
    av.object({ id: av.string(), name: av.string(), status: av.string(), summary: av.string(), timestamp: av.string() }),
  ),
  detailPath: av.string(),
  nextCursor: av.string(),
  until: av.string(),
});
export default createHandler({ response: ResponseSchema, query: QuerySchema }, (ctx) =>
  ctx.plugin.withTenant(ctx, async ({ repo }) => {
    ctx.responseHeaders?.set("cache-control", "no-store");
    const filters = parseLogFilters(QuerySchema.parse(ctx.query));
    const page = await repo.queryKioskLogs(filters);
    const items = page.logs;
    const last = items.at(-1);
    return {
      title,
      detailPath: "/logs/:id",
      until: filters.until,
      nextCursor: page.hasMore && last ? encodeLogCursor({ time: last.cursor_time, id: last.id }) : "",
      items: items.map((x) => ({ id: x.id, name: x.kiosk_name, status: x.level, summary: x.preview, timestamp: x.cursor_time })),
    };
  }),
);

export const dependencies = [{ operationId: "frame.logs.detail.read", method: "GET" }] as const;
