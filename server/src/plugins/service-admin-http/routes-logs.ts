import { type H3, type H3Event, getQuery, getRouterParam, createError } from "h3";
import type { AdminDeps } from "./index.js";
import { htmlPage } from "./html-response.js";
import { parseLogFilters } from "../../shared/kiosk-log-view.js";
import { KioskLogViewer } from "../../web-templates/kiosk-log-viewer.js";

export function registerLogRoutes(app: H3, deps: Pick<AdminDeps, "repo">): void {
  const view = (pinned: boolean) => async (event: H3Event) => {
    const id = pinned ? getRouterParam(event, "id") : undefined;
    const devices = await deps.repo.listKioskLogDevices(id);
    const kiosk = id ? devices.find(device => device.id === id) : undefined;
    if (pinned && !kiosk) throw createError({ statusCode: 404, statusMessage: "Kiosk not found" });
    const filters = parseLogFilters(getQuery(event), id);
    const page = await deps.repo.queryKioskLogs(filters);
    const response = htmlPage(KioskLogViewer({ user: event.context.user!.username, kiosk, devices, filters, page }));
    response.headers.set("cache-control", "no-store");
    return response;
  };
  app.get("/admin/logs", view(false));
  app.get("/admin/kiosks/:id/diagnostics", view(true));
  app.get("/admin/logs/:id", async (event) => {
    // The repository uses the same authenticated tenant search_path as the list.
    const log = await deps.repo.getKioskLog(getRouterParam(event, "id") ?? "");
    if (!log) throw createError({ statusCode: 404, statusMessage: "Log expired or unavailable" });
    return Response.json(log, { headers: { "cache-control": "no-store" } });
  });
}
