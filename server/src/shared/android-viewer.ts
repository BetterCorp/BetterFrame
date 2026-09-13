import type { Repository } from "./db/repository.js";
import type { Kiosk } from "./types.js";

export function isAndroidViewer(kiosk: Pick<Kiosk, "capabilities"> | null | undefined): boolean {
  return kiosk?.capabilities?.includes("android-viewer") === true;
}

/** Positive lists ensure future control endpoints are unavailable by default. */
export function androidViewerRouteAllowed(path: string, method: string): boolean {
  return (method === "GET" && ["/api/kiosk/bundle", "/api/kiosk/_check"].includes(path))
    || (method === "POST" && ["/api/kiosk/heartbeat", "/api/kiosk/logs", "/api/kiosk/display-session"].includes(path));
}

export function androidViewerCommandAllowed(message: object, assignedLayoutIds?: ReadonlySet<string>): boolean {
  const msg = message as Record<string, unknown>;
  if (["reload-bundle", "ping", "connected"].includes(String(msg["type"]))) return true;
  return msg["type"] === "layout-switch" && typeof msg["layout_id"] === "string"
    && assignedLayoutIds?.has(msg["layout_id"]) === true;
}

export async function viewerAssignment(repo: Repository, kiosk: Kiosk) {
  const found = await repo.listDisplaysForKiosk(kiosk.id);
  const displays = found.length ? found : kiosk.display_id ? [await repo.getDisplayById(kiosk.display_id)].filter(Boolean) : [];
  const display = displays.find((item) => item?.is_enabled);
  const layouts = display ? await repo.layoutsForDisplayId(display.id) : [];
  const layoutIds = new Set(layouts.map((layout) => layout.id));
  const dashboardPaths = new Set<string>();
  for (const layout of layouts) {
    for (const cell of await repo.layoutCells(layout.id)) {
      const entity = cell.entity_id ? await repo.getEntityById(cell.entity_id) : null;
      if (entity) layoutIds.add(entity.id); // assigned fullscreen virtual layout
      const url = entity
        ? entity.type === "dashboard" && entity.dashboard_id ? `/dash/${entity.dashboard_id}`
          : entity.type === "web" || entity.type === "ablesign" ? entity.web_url : null
        : cell.content_type === "web" ? cell.web_url : null;
      if (url?.startsWith("/dash/") && !url.includes("?") && !url.includes("#")) dashboardPaths.add(url.replace(/\/$/, ""));
    }
  }
  return { display, layoutIds, dashboardPaths };
}
