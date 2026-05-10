/**
 * Admin page routes — overview, cameras, kiosks, labels, etc.
 */
import { type H3, readBody, getRouterParam, getRequestHeader } from "h3";
import { htmlPage } from "./html-response.js";
import type { AdminDeps } from "./index.js";
import { confirmPairing } from "../../shared/pairing.js";
import { getCoordinator } from "../../shared/coordinator-registry.js";
import {
  OverviewPage,
  CamerasPage,
  CameraNewPage,
  CameraEditPage,
  KiosksPage,
  KioskEditPage,
  LabelsPage,
  LayoutsPage,
  LayoutNewPage,
  LayoutEditPage,
  DisplaysPage,
  DisplayEditPage,
  renderCell,
  renderGrid,
} from "../../web-templates/admin-pages.js";

function htmlFragment(markup: unknown): Response {
  return new Response(String(markup), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isHtmxRequest(event: Parameters<typeof getRequestHeader>[0]): boolean {
  return getRequestHeader(event, "hx-request") === "true";
}

function notifyKiosks(): void {
  try { getCoordinator().notifyBundleChanged(); } catch { /* ignore */ }
}

function sanitizeRtspUrl(raw: string): string {
  const match = raw.match(/^(rtsp:\/\/)([^@]+)@(.+)$/);
  if (!match) return raw;
  const [, scheme, userinfo, rest] = match;
  const colonIdx = userinfo!.indexOf(":");
  if (colonIdx < 0) return raw;
  const user = encodeURIComponent(userinfo!.slice(0, colonIdx));
  const pass = encodeURIComponent(userinfo!.slice(colonIdx + 1));
  return `${scheme}${user}:${pass}@${rest}`;
}

export function registerAdminRoutes(app: H3, deps: AdminDeps): void {
  // ---- Overview -------------------------------------------------------------

  app.get("/admin/", (event) => {
    const user = event.context.user!;
    const cameras = deps.repo.listCameras();
    const kiosks = deps.repo.listKiosks();
    const layouts = deps.repo.listDisplays(); // for count
    const events = deps.repo.recentEvents(10);
    const onlineKiosks = kiosks.filter((k) => {
      if (!k.last_seen_at) return false;
      return Date.now() - new Date(k.last_seen_at).getTime() < 5 * 60 * 1000;
    });

    return htmlPage(OverviewPage({
      user: user.username,
      cameraCount: cameras.length,
      kioskCount: kiosks.length,
      onlineKioskCount: onlineKiosks.length,
      layoutCount: layouts.length,
      events,
    }));
  });

  // Redirect /admin to /admin/
  app.get("/admin", () => {
    return new Response(null, { status: 301, headers: { location: "/admin/" } });
  });

  // ---- Cameras --------------------------------------------------------------

  app.get("/admin/cameras", (event) => {
    const user = event.context.user!;
    const cameras = deps.repo.listCameras();
    const streamCounts = new Map<number, number>();
    for (const cam of cameras) {
      streamCounts.set(cam.id, deps.repo.listCameraStreams(cam.id).length);
    }
    return htmlPage(CamerasPage({ user: user.username, cameras, streamCounts }));
  });

  app.get("/admin/cameras/new", (event) => {
    const user = event.context.user!;
    return htmlPage(CameraNewPage({ user: user.username }));
  });

  app.post("/admin/cameras/new", async (event) => {
    const user = event.context.user!;
    const body = await readBody<Record<string, string>>(event);
    const name = (body?.["name"] ?? "").trim();
    const type = body?.["type"] as "rtsp" | "onvif" | undefined;
    const errors: string[] = [];

    if (!name || name.length > 128) {
      errors.push("Name required (max 128 chars).");
    } else if (deps.repo.getCameraByName(name)) {
      errors.push("Camera name already in use.");
    }

    if (type !== "rtsp" && type !== "onvif") {
      errors.push("Select camera type.");
    }

    let rtspUrl: string | undefined;
    let onvifHost: string | undefined;
    let onvifPort: number | undefined;
    let onvifUser: string | undefined;
    let onvifPass: string | undefined;

    if (type === "rtsp") {
      const host = (body?.["rtsp_host"] ?? "").trim();
      const port = (body?.["rtsp_port"] ?? "554").trim();
      const path = (body?.["rtsp_path"] ?? "").trim();
      const user = (body?.["rtsp_username"] ?? "").trim();
      const pass = body?.["rtsp_password"] ?? "";
      if (!host) {
        errors.push("RTSP host required.");
      } else {
        const userPart = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
        const pathPart = path.startsWith("/") ? path : `/${path}`;
        rtspUrl = `rtsp://${userPart}${host}:${port}${pathPart}`;
      }
    } else if (type === "onvif") {
      onvifHost = (body?.["onvif_host"] ?? "").trim();
      onvifPort = parseInt(body?.["onvif_port"] ?? "80", 10);
      onvifUser = (body?.["onvif_username"] ?? "").trim();
      onvifPass = body?.["onvif_password"] ?? "";
      if (!onvifHost) errors.push("ONVIF host required.");
    }

    if (errors.length > 0) {
      return htmlPage(CameraNewPage({
        user: user.username,
        error: errors.join(" "),
        values: body,
      }));
    }

    const cam = deps.repo.createCamera({
      name,
      type: type!,
      rtsp_url: rtspUrl ?? null,
      onvif_host: onvifHost ?? null,
      onvif_port: onvifPort ?? null,
      onvif_username: onvifUser ?? null,
      onvif_password: onvifPass ?? null,
    });

    // Create default main stream for RTSP cameras
    if (type === "rtsp" && rtspUrl) {
      deps.repo.createCameraStream({
        camera_id: cam.id,
        role: "main",
        name: "Main",
        rtsp_uri: rtspUrl,
      });
    }

    return new Response(null, {
      status: 302,
      headers: { location: "/admin/cameras" },
    });
  });

  // ---- Kiosks ---------------------------------------------------------------

  app.get("/admin/kiosks", (event) => {
    const user = event.context.user!;
    const kiosks = deps.repo.listKiosks();
    const pending = deps.repo.listPendingPairingCodes();
    return htmlPage(KiosksPage({ user: user.username, kiosks, pendingCodes: pending }));
  });

  app.post("/admin/kiosks/pair", async (event) => {
    const body = await readBody<Record<string, string>>(event);
    const code = (body?.["code"] ?? "").trim().toUpperCase();
    const nameOverride = (body?.["name_override"] ?? "").trim() || undefined;
    const labelsStr = (body?.["initial_labels"] ?? "").trim();
    const initialLabels = labelsStr ? labelsStr.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

    try {
      await confirmPairing(deps.repo, deps.auth, deps.secrets, {
        code,
        nameOverride,
        initialLabels,
      });
    } catch (err) {
      const user = event.context.user!;
      const kiosks = deps.repo.listKiosks();
      const pending = deps.repo.listPendingPairingCodes();
      return htmlPage(KiosksPage({
        user: user.username,
        kiosks,
        pendingCodes: pending,
        error: (err as Error).message,
      }));
    }

    return new Response(null, { status: 302, headers: { location: "/admin/kiosks" } });
  });

  // ---- Layouts ---------------------------------------------------------------

  app.get("/admin/layouts", (event) => {
    const user = event.context.user!;
    const layouts = deps.repo.listLayouts();
    // For each layout, how many displays use it (for the list view).
    const displayCounts = new Map<number, number>();
    for (const l of layouts) {
      displayCounts.set(l.id, deps.repo.listDisplaysForLayout(l.id).length);
    }
    return htmlPage(LayoutsPage({ user: user.username, layouts, displayCounts }));
  });

  app.get("/admin/layouts/new", (event) => {
    const user = event.context.user!;
    return htmlPage(LayoutNewPage({ user: user.username }));
  });

  app.post("/admin/layouts/new", async (event) => {
    const user = event.context.user!;
    const body = await readBody<Record<string, string>>(event);
    const name = (body?.["name"] ?? "").trim();
    const priority = body?.["priority"] ?? "normal";
    const description = (body?.["description"] ?? "").trim() || null;
    const resetsIdleTimer = body?.["resets_idle_timer"] === "1";
    const errors: string[] = [];

    if (!name || name.length > 128) errors.push("Name required (max 128 chars).");
    if (priority !== "hot" && priority !== "normal" && priority !== "cold") {
      errors.push("Priority must be hot/normal/cold.");
    }

    if (errors.length > 0) {
      return htmlPage(LayoutNewPage({
        user: user.username,
        error: errors.join(" "),
        values: body,
      }));
    }

    const layout = deps.repo.createLayout({
      name,
      description,
      priority,
      resets_idle_timer: resetsIdleTimer,
    });

    return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layout.id}` } });
  });

  app.get("/admin/layouts/:id", (event) => {
    const user = event.context.user!;
    const id = Number(getRouterParam(event, "id"));
    const layout = deps.repo.getLayoutById(id);
    if (!layout) return new Response(null, { status: 302, headers: { location: "/admin/layouts" } });
    const cells = deps.repo.layoutCells(id);
    const cameras = deps.repo.listCameras();
    const displays = deps.repo.listDisplaysForLayout(id);
    return htmlPage(LayoutEditPage({
      user: user.username,
      layout,
      displays,
      cells,
      cameras,
    }));
  });

  app.post("/admin/layouts/:id", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const coolingStr = body?.["cooling_timeout_seconds"] ?? "";
    const coolingTimeout = coolingStr.trim() === "" ? null : parseInt(coolingStr, 10);
    deps.repo.updateLayout(id, {
      name: body?.["name"],
      description: body?.["description"] || null,
      priority: (body?.["priority"] ?? "normal") as any,
      cooling_timeout_seconds: coolingTimeout,
      resets_idle_timer: body?.["resets_idle_timer"] === "1",
    });
    notifyKiosks();
    return new Response(null, { status: 302, headers: { location: `/admin/layouts/${id}` } });
  });

  // Create a new 1x1 cell. Two body shapes:
  //   { position: { row, col } }  — explicit position, may shift others.
  //   { after_cell_id, direction } — relative to existing cell (right/below/left/above).
  // For htmx requests (hx-request header), returns the grid fragment; otherwise
  // returns a 302 to the layout edit page.
  app.post("/admin/layouts/:id/cells", async (event) => {
    const layoutId = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string | number | { row: number; col: number }>>(event);

    let row = 0;
    let col = 0;

    const afterCellIdRaw = body?.["after_cell_id"];
    const direction = typeof body?.["direction"] === "string" ? (body["direction"] as string) : "";

    if (afterCellIdRaw && direction) {
      const afterId = Number(afterCellIdRaw);
      const cells = deps.repo.layoutCells(layoutId);
      const ref = cells.find((c) => c.id === afterId);
      if (!ref) {
        if (isHtmxRequest(event)) {
          const cameras = deps.repo.listCameras();
          return htmlFragment(renderGrid(layoutId, cells, cameras));
        }
        return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layoutId}` } });
      }
      if (direction === "right") {
        row = ref.row;
        col = ref.col + ref.col_span;
      } else if (direction === "bottom") {
        row = ref.row + ref.row_span;
        col = ref.col;
      } else if (direction === "left") {
        row = ref.row;
        if (ref.col === 0) {
          deps.repo.shiftCellsForLayout(layoutId, "col", 0, 1);
          col = 0;
        } else {
          col = ref.col - 1;
        }
      } else if (direction === "above") {
        col = ref.col;
        if (ref.row === 0) {
          deps.repo.shiftCellsForLayout(layoutId, "row", 0, 1);
          row = 0;
        } else {
          row = ref.row - 1;
        }
      }
    } else {
      // Explicit position — accept top-level row/col or nested position.
      const pos = body?.["position"];
      if (pos && typeof pos === "object" && !Array.isArray(pos)) {
        row = Number((pos as { row: number; col: number }).row) || 0;
        col = Number((pos as { row: number; col: number }).col) || 0;
      } else {
        row = Number(body?.["row"] ?? 0) || 0;
        col = Number(body?.["col"] ?? 0) || 0;
      }
    }

    deps.repo.createLayoutCell({
      layout_id: layoutId,
      row,
      col,
      row_span: 1,
      col_span: 1,
      content_type: "html",
      html_content: null,
    });
    notifyKiosks();

    if (isHtmxRequest(event)) {
      const cells = deps.repo.layoutCells(layoutId);
      const cameras = deps.repo.listCameras();
      return htmlFragment(renderGrid(layoutId, cells, cameras));
    }
    return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layoutId}` } });
  });

  // GET a single cell in read mode (used by htmx Cancel button in inline edit).
  app.get("/admin/layouts/:id/cells/:cellId", (event) => {
    const layoutId = Number(getRouterParam(event, "id"));
    const cellId = Number(getRouterParam(event, "cellId"));
    const cell = deps.repo.getLayoutCellById(cellId);
    if (!cell || cell.layout_id !== layoutId) {
      return new Response("Not Found", { status: 404 });
    }
    const cameras = deps.repo.listCameras();
    return htmlFragment(renderCell(layoutId, cell, cameras, "read"));
  });

  // GET a single cell in edit mode (htmx swap target for cell click).
  app.get("/admin/layouts/:id/cells/:cellId/edit", (event) => {
    const layoutId = Number(getRouterParam(event, "id"));
    const cellId = Number(getRouterParam(event, "cellId"));
    const cell = deps.repo.getLayoutCellById(cellId);
    if (!cell || cell.layout_id !== layoutId) {
      return new Response("Not Found", { status: 404 });
    }
    const cameras = deps.repo.listCameras();
    return htmlFragment(renderCell(layoutId, cell, cameras, "edit"));
  });

  // Update a cell's content assignment + dimensions.
  // For htmx requests, returns the updated cell HTML (read mode) for outerHTML
  // swap onto the cell element. For normal POSTs, returns 302.
  app.post("/admin/layouts/:id/cells/:cellId", async (event) => {
    const layoutId = Number(getRouterParam(event, "id"));
    const cellId = Number(getRouterParam(event, "cellId"));
    const body = await readBody<Record<string, string>>(event);
    const contentType = (body?.["content_type"] ?? "html") as "camera" | "web" | "html";

    const patch: Record<string, unknown> = {
      content_type: contentType,
      camera_id: contentType === "camera" && body?.["camera_id"] ? Number(body["camera_id"]) : null,
      stream_selector: contentType === "camera"
        ? ((body?.["stream_selector"] as "auto" | "main" | "sub") ?? "auto")
        : "auto",
      web_url: contentType === "web" ? (body?.["web_url"] ?? null) : null,
      html_content: contentType === "html" ? (body?.["html_content"] ?? null) : null,
    };

    const colSpanRaw = body?.["col_span"];
    const rowSpanRaw = body?.["row_span"];
    if (colSpanRaw != null && String(colSpanRaw).trim() !== "") {
      const v = Math.max(1, Number(colSpanRaw) || 1);
      patch["col_span"] = v;
    }
    if (rowSpanRaw != null && String(rowSpanRaw).trim() !== "") {
      const v = Math.max(1, Number(rowSpanRaw) || 1);
      patch["row_span"] = v;
    }

    deps.repo.updateLayoutCell(cellId, patch as any);
    notifyKiosks();

    if (isHtmxRequest(event)) {
      const cell = deps.repo.getLayoutCellById(cellId);
      if (!cell) return new Response("", { headers: { "content-type": "text/html; charset=utf-8" } });
      const cameras = deps.repo.listCameras();
      return htmlFragment(renderCell(layoutId, cell, cameras, "read"));
    }
    return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layoutId}` } });
  });

  // Resize a cell by ±1 on row_span or col_span. Returns the grid fragment.
  app.post("/admin/layouts/:id/cells/:cellId/resize", async (event) => {
    const layoutId = Number(getRouterParam(event, "id"));
    const cellId = Number(getRouterParam(event, "cellId"));
    const body = await readBody<Record<string, string | number>>(event);
    const dim = String(body?.["dim"] ?? "");
    const delta = Number(body?.["delta"] ?? 0) || 0;

    const cell = deps.repo.getLayoutCellById(cellId);
    if (cell && cell.layout_id === layoutId && (dim === "row_span" || dim === "col_span") && delta !== 0) {
      const current = dim === "row_span" ? cell.row_span : cell.col_span;
      const next = Math.max(1, current + delta);
      if (next !== current) {
        deps.repo.updateLayoutCell(cellId, { [dim]: next } as any);
        notifyKiosks();
      }
    }

    const cells = deps.repo.layoutCells(layoutId);
    const cameras = deps.repo.listCameras();
    if (isHtmxRequest(event)) {
      return htmlFragment(renderGrid(layoutId, cells, cameras));
    }
    return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layoutId}` } });
  });

  app.post("/admin/layouts/:id/cells/:cellId/delete", (event) => {
    const layoutId = Number(getRouterParam(event, "id"));
    const cellId = Number(getRouterParam(event, "cellId"));
    deps.repo.deleteLayoutCell(cellId);
    notifyKiosks();
    if (isHtmxRequest(event)) {
      const cells = deps.repo.layoutCells(layoutId);
      const cameras = deps.repo.listCameras();
      return htmlFragment(renderGrid(layoutId, cells, cameras));
    }
    return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layoutId}` } });
  });

  app.post("/admin/layouts/:id/delete", (event) => {
    const id = Number(getRouterParam(event, "id"));
    deps.repo.deleteLayout(id);
    notifyKiosks();
    return new Response(null, { status: 302, headers: { location: "/admin/layouts" } });
  });

  // ---- Displays --------------------------------------------------------------

  app.get("/admin/displays", (event) => {
    const user = event.context.user!;
    const displays = deps.repo.listDisplays();
    return htmlPage(DisplaysPage({ user: user.username, displays }));
  });

  app.get("/admin/displays/:id", (event) => {
    const user = event.context.user!;
    const id = Number(getRouterParam(event, "id"));
    const display = deps.repo.getDisplayById(id);
    if (!display) return new Response(null, { status: 302, headers: { location: "/admin/displays" } });
    const attachedLayouts = deps.repo.listLayoutsForDisplay(id);
    const attachedIds = new Set(attachedLayouts.map((l) => l.id));
    const availableLayouts = deps.repo.listLayouts().filter((l) => !attachedIds.has(l.id));
    const kiosk = display.kiosk_id ? deps.repo.getKioskById(display.kiosk_id) : null;
    return htmlPage(DisplayEditPage({
      user: user.username,
      display,
      attachedLayouts,
      availableLayouts,
      kioskName: kiosk?.name ?? null,
    }));
  });

  app.post("/admin/displays/:id", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const defaultLayoutIdRaw = body?.["default_layout_id"];
    const defaultLayoutId = defaultLayoutIdRaw ? Number(defaultLayoutIdRaw) : null;

    // Validate default_layout_id is actually attached to this display.
    let validatedDefault: number | null = defaultLayoutId;
    if (defaultLayoutId != null) {
      const attached = deps.repo.listLayoutsForDisplay(id);
      if (!attached.some((l) => l.id === defaultLayoutId)) {
        validatedDefault = null;
      }
    }

    // width/height are no longer admin-editable — they come from the kiosk's
    // hardware report. Just update the editable fields.
    deps.repo.updateDisplay(id, {
      name: body?.["name"],
      default_layout_id: validatedDefault,
      idle_timeout_seconds: parseInt(body?.["idle_timeout_seconds"] ?? "0", 10),
      sleep_timeout_seconds: parseInt(body?.["sleep_timeout_seconds"] ?? "0", 10),
    } as any);
    notifyKiosks();
    return new Response(null, { status: 302, headers: { location: `/admin/displays/${id}` } });
  });

  // Attach a layout to a display.
  app.post("/admin/displays/:id/layouts", async (event) => {
    const displayId = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const layoutId = body?.["layout_id"] ? Number(body["layout_id"]) : null;
    if (layoutId && Number.isFinite(layoutId)) {
      deps.repo.attachLayoutToDisplay(displayId, layoutId);
      notifyKiosks();
    }
    return new Response(null, { status: 302, headers: { location: `/admin/displays/${displayId}` } });
  });

  // Detach a layout from a display.
  app.post("/admin/displays/:id/layouts/:layoutId/remove", (event) => {
    const displayId = Number(getRouterParam(event, "id"));
    const layoutId = Number(getRouterParam(event, "layoutId"));
    deps.repo.detachLayoutFromDisplay(displayId, layoutId);
    notifyKiosks();
    return new Response(null, { status: 302, headers: { location: `/admin/displays/${displayId}` } });
  });

  app.get("/admin/labels", (event) => {
    const user = event.context.user!;
    return htmlPage(LabelsPage({ user: user.username, labels: deps.repo.listLabels() }));
  });

  app.post("/admin/labels/new", async (event) => {
    const body = await readBody<Record<string, string>>(event);
    const name = (body?.["name"] ?? "").trim().toLowerCase();
    const color = body?.["color"] ?? null;
    if (!name || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
      return htmlPage(LabelsPage({
        user: event.context.user!.username,
        labels: deps.repo.listLabels(),
        error: "Label name must start with letter/digit and contain only lowercase, digits, hyphens, underscores.",
      }));
    }
    deps.repo.createLabel({ name, color });
    return new Response(null, { status: 302, headers: { location: "/admin/labels" } });
  });

  app.post("/admin/labels/:id/delete", (event) => {
    const id = Number(getRouterParam(event, "id"));
    deps.repo.deleteLabel(id);
    return new Response(null, { status: 302, headers: { location: "/admin/labels" } });
  });

  // ---- Camera edit/delete/labels --------------------------------------------

  app.get("/admin/cameras/:id", (event) => {
    const user = event.context.user!;
    const id = Number(getRouterParam(event, "id"));
    const camera = deps.repo.getCameraById(id);
    if (!camera) return new Response(null, { status: 302, headers: { location: "/admin/cameras" } });
    return htmlPage(CameraEditPage({
      user: user.username,
      camera,
      labels: deps.repo.cameraLabelIds(id),
      allLabels: deps.repo.listLabels(),
      streams: deps.repo.listCameraStreams(id),
    }));
  });

  app.post("/admin/cameras/:id", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const cam = deps.repo.getCameraById(id);

    let rtspUrl: string | null = null;
    if (cam?.type === "rtsp") {
      const host = (body?.["rtsp_host"] ?? "").trim();
      const port = (body?.["rtsp_port"] ?? "554").trim();
      const path = (body?.["rtsp_path"] ?? "").trim();
      const user = (body?.["rtsp_username"] ?? "").trim();
      const pass = body?.["rtsp_password"] ?? "";
      if (host) {
        // If password blank, keep old URL (password unchanged)
        if (!pass && cam.rtsp_url) {
          const oldParts = cam.rtsp_url.match(/^rtsp:\/\/(?:([^@]+)@)?/);
          const oldUserinfo = oldParts?.[1] ?? "";
          const userPart = oldUserinfo ? `${oldUserinfo}@` : "";
          const pathPart = path.startsWith("/") ? path : `/${path}`;
          rtspUrl = `rtsp://${userPart}${host}:${port}${pathPart}`;
        } else {
          const userPart = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
          const pathPart = path.startsWith("/") ? path : `/${path}`;
          rtspUrl = `rtsp://${userPart}${host}:${port}${pathPart}`;
        }
      }
    }

    const patch: Record<string, unknown> = {
      name: body?.["name"],
      enabled: body?.["enabled"] === "1",
    };
    if (cam?.type === "rtsp" && rtspUrl) {
      patch["rtsp_url"] = rtspUrl;
    } else if (cam?.type === "onvif") {
      patch["onvif_host"] = body?.["onvif_host"] || null;
      patch["onvif_port"] = body?.["onvif_port"] ? Number(body["onvif_port"]) : null;
      patch["onvif_username"] = body?.["onvif_username"] || null;
      if (body?.["onvif_password"]) patch["onvif_password"] = body["onvif_password"];
    }
    deps.repo.updateCamera(id, patch as any);

    // Also update main stream URI for RTSP cameras
    if (cam?.type === "rtsp" && rtspUrl) {
      const streams = deps.repo.listCameraStreams(id);
      const mainStream = streams.find((s) => s.role === "main");
      if (mainStream) {
        deps.repo.updateCameraStream(mainStream.id, { rtsp_uri: rtspUrl });
      }
    }
    notifyKiosks();

    return new Response(null, { status: 302, headers: { location: `/admin/cameras/${id}` } });
  });

  app.post("/admin/cameras/:id/labels", async (event) => {
    const camId = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const newLabel = (body?.["new_label"] ?? "").trim().toLowerCase();
    let labelId = body?.["label_id"] ? Number(body["label_id"]) : null;

    if (newLabel) {
      const label = deps.repo.ensureLabel(newLabel);
      labelId = label.id;
    }
    if (labelId) {
      deps.repo.attachCameraLabel(camId, labelId);
    }
    return new Response(null, { status: 302, headers: { location: `/admin/cameras/${camId}` } });
  });

  app.post("/admin/cameras/:id/labels/remove", async (event) => {
    const camId = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const labelId = Number(body?.["label_id"]);
    deps.repo.detachCameraLabel(camId, labelId);
    return new Response(null, { status: 302, headers: { location: `/admin/cameras/${camId}` } });
  });

  app.post("/admin/cameras/:id/delete", (event) => {
    const id = Number(getRouterParam(event, "id"));
    deps.repo.deleteCamera(id);
    notifyKiosks();
    return new Response(null, { status: 302, headers: { location: "/admin/cameras" } });
  });

  // ---- Kiosk edit/delete/labels ---------------------------------------------

  app.get("/admin/kiosks/:id", (event) => {
    const user = event.context.user!;
    const id = Number(getRouterParam(event, "id"));
    const kiosk = deps.repo.getKioskById(id);
    if (!kiosk) return new Response(null, { status: 302, headers: { location: "/admin/kiosks" } });
    const kioskLabels = deps.repo.listKioskLabels(id).map((kl) => ({
      label_id: kl.label_id,
      name: kl.name,
      role: kl.role,
    }));
    const displays = deps.repo.listDisplaysForKiosk(id);
    return htmlPage(KioskEditPage({
      user: user.username,
      kiosk,
      labels: kioskLabels,
      allLabels: deps.repo.listLabels(),
      displays,
    }));
  });

  app.post("/admin/kiosks/:id", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    deps.repo.updateKiosk(id, {
      name: body?.["name"],
      enabled: body?.["enabled"] === "1",
    } as any);
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${id}` } });
  });

  app.post("/admin/kiosks/:id/labels", async (event) => {
    const kioskId = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const newLabel = (body?.["new_label"] ?? "").trim().toLowerCase();
    const role = (body?.["role"] ?? "consume") as "consume" | "operate";
    let labelId = body?.["label_id"] ? Number(body["label_id"]) : null;

    if (newLabel) {
      const label = deps.repo.ensureLabel(newLabel);
      labelId = label.id;
    }
    if (labelId) {
      deps.repo.attachKioskLabel(kioskId, labelId, role);
    }
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${kioskId}` } });
  });

  app.post("/admin/kiosks/:id/labels/remove", async (event) => {
    const kioskId = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const labelId = Number(body?.["label_id"]);
    deps.repo.detachKioskLabel(kioskId, labelId);
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${kioskId}` } });
  });

  app.post("/admin/kiosks/:id/delete", (event) => {
    const id = Number(getRouterParam(event, "id"));
    deps.repo.deleteKiosk(id);
    return new Response(null, { status: 302, headers: { location: "/admin/kiosks" } });
  });

  // ---- CEC power commands -----------------------------------------------
  app.post("/admin/kiosks/:id/power/standby", (event) => {
    const id = Number(getRouterParam(event, "id"));
    getCoordinator().sendToKiosk(id, { type: "standby" });
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${id}` } });
  });

  app.post("/admin/kiosks/:id/power/wake", (event) => {
    const id = Number(getRouterParam(event, "id"));
    getCoordinator().sendToKiosk(id, { type: "wake" });
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${id}` } });
  });
}
