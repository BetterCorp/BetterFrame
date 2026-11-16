import { type H3, assertBodySize, getRouterParam, readBody } from "h3";
import type { AdminDeps } from "./index.js";
import { getCoordinator } from "../../shared/coordinator-registry.js";
import { bundleWebActions, WEB_ACTION_NAME } from "../../shared/web-actions.js";
import { simpleVmsLayoutAllowed } from "../../shared/simple-vms-access.js";
import { randomUUID } from "node:crypto";

export function registerWebActionRoutes(app: H3, deps: AdminDeps): void {
  app.post("/api/displays/:id/web-actions/:group", async event => {
    await assertBodySize(event, 4096);
    const displayId = getRouterParam(event, "id") ?? "";
    const group = getRouterParam(event, "group") ?? "";
    const body = await readBody<Record<string, unknown>>(event);
    const layoutId = typeof body?.["layout_id"] === "string" ? body["layout_id"] : "";
    const cellId = typeof body?.["cell_id"] === "string" ? body["cell_id"] : "";
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    if (!layoutId || !cellId || !WEB_ACTION_NAME.test(group)) return json({ error: "invalid_web_action" }, 400);
    const display = await deps.repo.getDisplayById(displayId);
    if (!display?.kiosk_id) return json({ error: "display_not_found" }, 404);
    const layouts = await deps.repo.layoutsForDisplayId(displayId);
    if (!layouts.some(layout => layout.id === layoutId)) return json({ error: "layout_not_assigned" }, 404);
    if (!await simpleVmsLayoutAllowed(deps.repo.adapter, layoutId, display.kiosk_id)) return json({ error: "layout_unavailable" }, 403);
    const cell = await deps.repo.getLayoutCellById(cellId);
    if (!cell || cell.layout_id !== layoutId) return json({ error: "block_not_found" }, 404);
    const entity = cell.entity_id ? await deps.repo.getEntityById(cell.entity_id) : null;
    const config = bundleWebActions(cell, entity, deps.secrets);
    if (!config || !Object.hasOwn(config.groups, group)) return json({ error: "group_not_found" }, 404);
    const kiosk = await deps.repo.getKioskById(display.kiosk_id);
    if (!kiosk?.capabilities?.includes("web-action-groups-v1")) return json({ error: "player_does_not_support_web_actions" }, 409);
    const requestId = randomUUID();
    const sent = getCoordinator().sendToKiosk(display.kiosk_id, {
      type: "web-action", request_id: requestId, display_id: displayId,
      layout_id: layoutId, cell_id: cellId, group, revision: config.revision,
    }, false);
    return sent ? json({ accepted: true, request_id: requestId }, 202) : json({ error: "kiosk_offline" }, 503);
  });
}
