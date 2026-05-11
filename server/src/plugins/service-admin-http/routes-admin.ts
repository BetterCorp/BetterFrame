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
  CameraDiscoverPage,
  CameraDiscoverResultsPage,
  EntitiesPage,
  EntityNewPage,
  EntityEditPage,
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
import { discover as onvifDiscover } from "../../shared/onvif.js";

interface DiscoverAddStream {
  profile_name: string;
  profile_token: string;
  source_token: string | null;
  encoding: string | null;
  width: number | null;
  height: number | null;
  framerate: number | null;
  stream_uri: string;
  snapshot_uri?: string | null;
  role: "main" | "sub" | "other";
}

type FormValue = string | string[] | undefined;

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

function uniqueCameraName(deps: AdminDeps, rawName: string): string {
  let name = rawName;
  if (deps.repo.getCameraByName(name)) {
    let i = 2;
    while (deps.repo.getCameraByName(`${rawName} (${String(i)})`)) i += 1;
    name = `${rawName} (${String(i)})`;
  }
  return name;
}

function rtspWithCredentials(raw: string, username: string, password: string): string {
  if (!username) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== "rtsp:" || url.username) return raw;
    url.username = username;
    url.password = password;
    return url.toString();
  } catch {
    return raw;
  }
}

function formValue(v: FormValue): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function formValues(v: FormValue): string[] {
  if (Array.isArray(v)) return v;
  return v ? [v] : [];
}

function parseDiscoveredStreams(raw: string): DiscoverAddStream[] {
  try {
    const parsed = JSON.parse(raw) as DiscoverAddStream[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function importDiscoveredCamera(
  deps: AdminDeps,
  rawName: string,
  username: string,
  password: string,
  streams: DiscoverAddStream[],
): void {
  if (streams.length === 0) return;
  const main = streams.find((s) => s.role === "main") ?? streams[0]!;
  const mainRtspUrl = rtspWithCredentials(main.stream_uri, username, password);
  const name = uniqueCameraName(deps, rawName || "ONVIF camera");

  const cam = deps.repo.createCamera({
    name,
    type: "rtsp",
    rtsp_url: mainRtspUrl,
  });
  for (const stream of streams) {
    const width = stream.width == null ? null : Number(stream.width);
    const height = stream.height == null ? null : Number(stream.height);
    const framerate = stream.framerate == null ? null : Number(stream.framerate);
    deps.repo.createCameraStream({
      camera_id: cam.id,
      role: stream.role === "main" || stream.role === "sub" ? stream.role : "other",
      name: stream.profile_name || stream.role,
      rtsp_uri: rtspWithCredentials(stream.stream_uri, username, password),
      profile_token: stream.profile_token || null,
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
      encoding: stream.encoding || null,
      framerate: Number.isFinite(framerate) ? framerate : null,
      is_discovered: true,
    });
  }
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function shiftCellsForExpansion(
  deps: AdminDeps,
  layoutId: number,
  cellId: number,
  direction: "left" | "right" | "above" | "bottom",
): void {
  const cell = deps.repo.getLayoutCellById(cellId);
  if (!cell || cell.layout_id !== layoutId) return;

  const cells = deps.repo.layoutCells(layoutId).filter((c) => c.id !== cellId);
  const rowStart = cell.row;
  const rowEnd = cell.row + cell.row_span;
  const colStart = cell.col;
  const colEnd = cell.col + cell.col_span;

  if (direction === "right") {
    for (const c of cells) {
      if (c.col >= colEnd && rangesOverlap(c.row, c.row + c.row_span, rowStart, rowEnd)) {
        deps.repo.updateLayoutCell(c.id, { col: c.col + 1 });
      }
    }
    deps.repo.updateLayoutCell(cell.id, { col_span: cell.col_span + 1 });
  } else if (direction === "bottom") {
    for (const c of cells) {
      if (c.row >= rowEnd && rangesOverlap(c.col, c.col + c.col_span, colStart, colEnd)) {
        deps.repo.updateLayoutCell(c.id, { row: c.row + 1 });
      }
    }
    deps.repo.updateLayoutCell(cell.id, { row_span: cell.row_span + 1 });
  } else if (direction === "left") {
    const insertCol = Math.max(0, cell.col - 1);
    for (const c of cells) {
      if (c.col >= insertCol && rangesOverlap(c.row, c.row + c.row_span, rowStart, rowEnd)) {
        deps.repo.updateLayoutCell(c.id, { col: c.col + 1 });
      }
    }
    deps.repo.updateLayoutCell(cell.id, {
      col: insertCol,
      col_span: cell.col_span + 1,
    });
  } else if (direction === "above") {
    const insertRow = Math.max(0, cell.row - 1);
    for (const c of cells) {
      if (c.row >= insertRow && rangesOverlap(c.col, c.col + c.col_span, colStart, colEnd)) {
        deps.repo.updateLayoutCell(c.id, { row: c.row + 1 });
      }
    }
    deps.repo.updateLayoutCell(cell.id, {
      row: insertRow,
      row_span: cell.row_span + 1,
    });
  }
}

function shiftCellsForInsertion(
  deps: AdminDeps,
  layoutId: number,
  axis: "row" | "col",
  fromIndex: number,
  crossStart: number,
  crossEnd: number,
): void {
  for (const c of deps.repo.layoutCells(layoutId)) {
    if (axis === "col") {
      if (c.col >= fromIndex && rangesOverlap(c.row, c.row + c.row_span, crossStart, crossEnd)) {
        deps.repo.updateLayoutCell(c.id, { col: c.col + 1 });
      }
    } else if (c.row >= fromIndex && rangesOverlap(c.col, c.col + c.col_span, crossStart, crossEnd)) {
      deps.repo.updateLayoutCell(c.id, { row: c.row + 1 });
    }
  }
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
    const errors: string[] = [];

    if (!name || name.length > 128) {
      errors.push("Name required (max 128 chars).");
    } else if (deps.repo.getCameraByName(name)) {
      errors.push("Camera name already in use.");
    }

    const host = (body?.["rtsp_host"] ?? "").trim();
    const port = (body?.["rtsp_port"] ?? "554").trim();
    const path = (body?.["rtsp_path"] ?? "").trim();
    const username = (body?.["rtsp_username"] ?? "").trim();
    const pass = body?.["rtsp_password"] ?? "";
    let rtspUrl: string | undefined;
    if (!host) {
      errors.push("RTSP host required.");
    } else {
      const userPart = username ? `${encodeURIComponent(username)}:${encodeURIComponent(pass)}@` : "";
      const pathPart = path.startsWith("/") ? path : `/${path}`;
      rtspUrl = `rtsp://${userPart}${host}:${port}${pathPart}`;
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
      type: "rtsp",
      rtsp_url: rtspUrl ?? null,
    });

    if (rtspUrl) {
      deps.repo.createCameraStream({
        camera_id: cam.id,
        role: "main",
        name: "Main",
        rtsp_uri: rtspUrl,
      });
    }
    notifyKiosks();

    return new Response(null, {
      status: 302,
      headers: { location: "/admin/cameras" },
    });
  });

  // ---- Camera ONVIF discovery ------------------------------------------------

  app.get("/admin/cameras/discover", (event) => {
    const user = event.context.user!;
    return htmlPage(CameraDiscoverPage({ user: user.username }));
  });

  app.post("/admin/cameras/discover", async (event) => {
    const user = event.context.user!;
    const body = await readBody<Record<string, string>>(event);
    const host = (body?.["host"] ?? "").trim();
    const port = parseInt(body?.["port"] ?? "80", 10) || 80;
    const username = (body?.["username"] ?? "").trim();
    const password = body?.["password"] ?? "";

    if (!host) {
      return htmlPage(CameraDiscoverPage({
        user: user.username,
        error: "Host required.",
        values: body,
      }));
    }

    try {
      const cameras = await onvifDiscover({ host, port, username, password });
      return htmlPage(CameraDiscoverResultsPage({
        user: user.username,
        host,
        username,
        password,
        cameras,
      }));
    } catch (err) {
      return htmlPage(CameraDiscoverPage({
        user: user.username,
        error: `Discovery failed: ${(err as Error).message}`,
        values: body,
      }));
    }
  });

  app.post("/admin/cameras/discover/add", async (event) => {
    const body = await readBody<Record<string, string | string[]>>(event);
    const username = formValue(body?.["username"]).trim();
    const password = formValue(body?.["password"]);
    let imported = 0;

    const selected = formValues(body?.["selected"]);
    if (selected.length > 0) {
      for (const idx of selected) {
        const rawName = formValue(body?.[`camera_${idx}_name`]).trim() || "ONVIF camera";
        const streams = parseDiscoveredStreams(formValue(body?.[`camera_${idx}_streams_json`]));
        if (streams.length === 0) continue;
        importDiscoveredCamera(deps, rawName, username, password, streams);
        imported += 1;
      }
    } else {
      const rawName = formValue(body?.["name"]).trim() || "ONVIF camera";
      const streams = parseDiscoveredStreams(formValue(body?.["streams_json"]));
      if (streams.length > 0) {
        importDiscoveredCamera(deps, rawName, username, password, streams);
        imported += 1;
      }
    }

    if (imported === 0) {
      return new Response(null, { status: 302, headers: { location: "/admin/cameras/discover" } });
    }
    notifyKiosks();

    return new Response(null, { status: 302, headers: { location: "/admin/cameras" } });
  });

  // ---- Entities --------------------------------------------------------------

  app.get("/admin/entities", (event) => {
    const user = event.context.user!;
    return htmlPage(EntitiesPage({
      user: user.username,
      entities: deps.repo.listEntities(),
    }));
  });

  app.get("/admin/entities/new", (event) => {
    const user = event.context.user!;
    return htmlPage(EntityNewPage({
      user: user.username,
      cameras: deps.repo.listCameras(),
    }));
  });

  app.post("/admin/entities/new", async (event) => {
    const user = event.context.user!;
    const body = await readBody<Record<string, string>>(event);
    const name = (body?.["name"] ?? "").trim();
    const type = body?.["type"] as "camera" | "html" | "web" | undefined;
    const description = (body?.["description"] ?? "").trim() || null;
    const errors: string[] = [];

    if (!name || name.length > 128) {
      errors.push("Name required (max 128 chars).");
    } else if (deps.repo.getEntityByName(name)) {
      errors.push("Entity name already in use.");
    }
    if (type !== "camera" && type !== "html" && type !== "web") {
      errors.push("Select an entity type.");
    }

    let cameraId: number | null = null;
    let htmlContent: string | null = null;
    let webUrl: string | null = null;
    if (type === "camera") {
      cameraId = body?.["camera_id"] ? Number(body["camera_id"]) : null;
      if (!cameraId) errors.push("Pick a camera.");
    } else if (type === "html") {
      htmlContent = body?.["html_content"] ?? null;
    } else if (type === "web") {
      webUrl = (body?.["web_url"] ?? "").trim() || null;
      if (!webUrl) errors.push("URL required.");
    }

    if (errors.length > 0) {
      return htmlPage(EntityNewPage({
        user: user.username,
        cameras: deps.repo.listCameras(),
        error: errors.join(" "),
        values: body,
      }));
    }

    deps.repo.createEntity({
      name,
      type: type!,
      description,
      camera_id: cameraId,
      html_content: htmlContent,
      web_url: webUrl,
    });
    notifyKiosks();
    return new Response(null, { status: 302, headers: { location: "/admin/entities" } });
  });

  app.get("/admin/entities/:id", (event) => {
    const user = event.context.user!;
    const id = Number(getRouterParam(event, "id"));
    const ent = deps.repo.getEntityById(id);
    if (!ent) return new Response(null, { status: 302, headers: { location: "/admin/entities" } });
    return htmlPage(EntityEditPage({
      user: user.username,
      entity: ent,
      cameras: deps.repo.listCameras(),
    }));
  });

  app.post("/admin/entities/:id", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const ent = deps.repo.getEntityById(id);
    if (!ent) return new Response(null, { status: 302, headers: { location: "/admin/entities" } });
    const body = await readBody<Record<string, string>>(event);
    const patch: {
      name?: string;
      description?: string | null;
      camera_id?: number | null;
      html_content?: string | null;
      web_url?: string | null;
    } = {
      name: (body?.["name"] ?? ent.name).trim(),
      description: (body?.["description"] ?? "").trim() || null,
    };
    if (ent.type === "camera") {
      patch.camera_id = body?.["camera_id"] ? Number(body["camera_id"]) : null;
    } else if (ent.type === "html") {
      patch.html_content = body?.["html_content"] ?? null;
    } else if (ent.type === "web") {
      patch.web_url = (body?.["web_url"] ?? "").trim() || null;
    }
    deps.repo.updateEntity(id, patch);
    notifyKiosks();
    return new Response(null, { status: 302, headers: { location: `/admin/entities/${String(id)}` } });
  });

  app.post("/admin/entities/:id/delete", (event) => {
    const id = Number(getRouterParam(event, "id"));
    deps.repo.deleteEntity(id);
    notifyKiosks();
    return new Response(null, { status: 302, headers: { location: "/admin/entities" } });
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
    const entities = deps.repo.listEntities();
    const displays = deps.repo.listDisplaysForLayout(id);
    return htmlPage(LayoutEditPage({
      user: user.username,
      layout,
      displays,
      cells,
      cameras,
      entities,
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
          const entities = deps.repo.listEntities();
          return htmlFragment(renderGrid(layoutId, cells, entities, cameras));
        }
        return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layoutId}` } });
      }
      if (direction === "right") {
        row = ref.row;
        col = ref.col + ref.col_span;
        shiftCellsForInsertion(deps, layoutId, "col", col, row, row + 1);
      } else if (direction === "bottom") {
        row = ref.row + ref.row_span;
        col = ref.col;
        shiftCellsForInsertion(deps, layoutId, "row", row, col, col + 1);
      } else if (direction === "left") {
        row = ref.row;
        col = Math.max(0, ref.col - 1);
        shiftCellsForInsertion(deps, layoutId, "col", col, row, row + 1);
      } else if (direction === "above") {
        col = ref.col;
        row = Math.max(0, ref.row - 1);
        shiftCellsForInsertion(deps, layoutId, "row", row, col, col + 1);
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
      entity_id: null,
    });
    notifyKiosks();

    if (isHtmxRequest(event)) {
      const cells = deps.repo.layoutCells(layoutId);
      const cameras = deps.repo.listCameras();
      const entities = deps.repo.listEntities();
      return htmlFragment(renderGrid(layoutId, cells, entities, cameras));
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
    const entities = deps.repo.listEntities();
    return htmlFragment(renderCell(layoutId, cell, entities, cameras, "read"));
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
    const entities = deps.repo.listEntities();
    return htmlFragment(renderCell(layoutId, cell, entities, cameras, "edit"));
  });

  // Update a cell's entity binding + dimensions. Legacy content_type/web/html
  // columns are managed by assignCellEntity for bundle compatibility.
  app.post("/admin/layouts/:id/cells/:cellId", async (event) => {
    const layoutId = Number(getRouterParam(event, "id"));
    const cellId = Number(getRouterParam(event, "cellId"));
    const body = await readBody<Record<string, string>>(event);

    const entityIdRaw = body?.["entity_id"];
    const entityId =
      entityIdRaw && String(entityIdRaw).trim() !== "" ? Number(entityIdRaw) : null;
    deps.repo.assignCellEntity(cellId, Number.isFinite(entityId) ? entityId : null);

    // stream_selector + spans are still settable on the cell.
    const dimsPatch: Record<string, unknown> = {};
    const streamSelector = body?.["stream_selector"];
    if (streamSelector === "auto" || streamSelector === "main" || streamSelector === "sub") {
      dimsPatch["stream_selector"] = streamSelector;
    }
    const colSpanRaw = body?.["col_span"];
    const rowSpanRaw = body?.["row_span"];
    if (colSpanRaw != null && String(colSpanRaw).trim() !== "") {
      dimsPatch["col_span"] = Math.max(1, Number(colSpanRaw) || 1);
    }
    if (rowSpanRaw != null && String(rowSpanRaw).trim() !== "") {
      dimsPatch["row_span"] = Math.max(1, Number(rowSpanRaw) || 1);
    }
    if (Object.keys(dimsPatch).length > 0) {
      deps.repo.updateLayoutCell(cellId, dimsPatch as any);
    }
    notifyKiosks();

    if (isHtmxRequest(event)) {
      const cell = deps.repo.getLayoutCellById(cellId);
      if (!cell) return new Response("", { headers: { "content-type": "text/html; charset=utf-8" } });
      const cameras = deps.repo.listCameras();
      const entities = deps.repo.listEntities();
      return htmlFragment(renderCell(layoutId, cell, entities, cameras, "read"));
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
    const direction = String(body?.["direction"] ?? "");

    const cell = deps.repo.getLayoutCellById(cellId);
    if (
      cell
      && cell.layout_id === layoutId
      && (direction === "left" || direction === "right" || direction === "above" || direction === "bottom")
    ) {
      shiftCellsForExpansion(deps, layoutId, cellId, direction);
      notifyKiosks();
    } else if (cell && cell.layout_id === layoutId && (dim === "row_span" || dim === "col_span") && delta !== 0) {
      const current = dim === "row_span" ? cell.row_span : cell.col_span;
      const next = Math.max(1, current + delta);
      if (next !== current) {
        deps.repo.updateLayoutCell(cellId, { [dim]: next } as any);
        notifyKiosks();
      }
    }

    const cells = deps.repo.layoutCells(layoutId);
    const cameras = deps.repo.listCameras();
    const entities = deps.repo.listEntities();
    if (isHtmxRequest(event)) {
      return htmlFragment(renderGrid(layoutId, cells, entities, cameras));
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
      const entities = deps.repo.listEntities();
      return htmlFragment(renderGrid(layoutId, cells, entities, cameras));
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

  // ---- Fan control ------------------------------------------------------
  app.post("/admin/kiosks/:id/fan", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const mode = body?.["mode"];
    if (mode === "auto") {
      getCoordinator().sendToKiosk(id, { type: "fan", mode: "auto" });
    } else {
      const pwm = Math.max(0, Math.min(255, Number(body?.["pwm"]) || 0));
      getCoordinator().sendToKiosk(id, { type: "fan", pwm });
    }
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${id}` } });
  });
}
