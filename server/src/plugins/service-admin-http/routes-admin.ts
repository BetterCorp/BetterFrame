/**
 * Admin page routes — overview, cameras, kiosks, labels, etc.
 */
import { type H3, readBody, getRouterParam } from "h3";
import { htmlPage } from "./html-response.js";
import type { AdminDeps } from "./index.js";
import { confirmPairing } from "../../shared/pairing.js";
import {
  OverviewPage,
  CamerasPage,
  CameraNewPage,
  CameraEditPage,
  KiosksPage,
  KioskEditPage,
  LabelsPage,
  TemplatesPage,
  TemplateNewPage,
  TemplateEditPage,
  LayoutsPage,
  LayoutNewPage,
  LayoutEditPage,
  DisplaysPage,
  DisplayEditPage,
} from "../../web-templates/admin-pages.js";
import type { LayoutTemplate, Display } from "../../shared/types.js";

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
      rtspUrl = sanitizeRtspUrl((body?.["rtsp_url"] ?? "").trim());
      if (!rtspUrl) errors.push("RTSP URL required.");
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

  // ---- Templates (Layout Templates) ------------------------------------------

  app.get("/admin/templates", (event) => {
    const user = event.context.user!;
    const templates = deps.repo.listLayoutTemplates();
    return htmlPage(TemplatesPage({ user: user.username, templates }));
  });

  app.get("/admin/templates/new", (event) => {
    const user = event.context.user!;
    return htmlPage(TemplateNewPage({ user: user.username }));
  });

  app.post("/admin/templates/new", async (event) => {
    const user = event.context.user!;
    const body = await readBody<Record<string, string>>(event);
    const preset = body?.["preset"] ?? "custom";
    let name = (body?.["name"] ?? "").trim();
    const errors: string[] = [];

    if (!name || name.length > 128) {
      errors.push("Name required (max 128 chars).");
    }

    let regions: Array<{ name: string; row: number; col: number; rowSpan: number; colSpan: number }> = [];
    let gridCols = 12;
    let gridRows = 12;

    if (preset === "fullscreen") {
      gridCols = 1;
      gridRows = 1;
      regions = [{ name: "main", row: 0, col: 0, rowSpan: 1, colSpan: 1 }];
    } else if (preset === "2x2") {
      gridCols = 2;
      gridRows = 2;
      regions = [
        { name: "tl", row: 0, col: 0, rowSpan: 1, colSpan: 1 },
        { name: "tr", row: 0, col: 1, rowSpan: 1, colSpan: 1 },
        { name: "bl", row: 1, col: 0, rowSpan: 1, colSpan: 1 },
        { name: "br", row: 1, col: 1, rowSpan: 1, colSpan: 1 },
      ];
    } else if (preset === "1plus3") {
      gridCols = 2;
      gridRows = 3;
      regions = [
        { name: "main", row: 0, col: 0, rowSpan: 3, colSpan: 1 },
        { name: "r1", row: 0, col: 1, rowSpan: 1, colSpan: 1 },
        { name: "r2", row: 1, col: 1, rowSpan: 1, colSpan: 1 },
        { name: "r3", row: 2, col: 1, rowSpan: 1, colSpan: 1 },
      ];
    } else if (preset === "3x3") {
      gridCols = 3;
      gridRows = 3;
      regions = [
        { name: "r1", row: 0, col: 0, rowSpan: 1, colSpan: 1 },
        { name: "r2", row: 0, col: 1, rowSpan: 1, colSpan: 1 },
        { name: "r3", row: 0, col: 2, rowSpan: 1, colSpan: 1 },
        { name: "r4", row: 1, col: 0, rowSpan: 1, colSpan: 1 },
        { name: "r5", row: 1, col: 1, rowSpan: 1, colSpan: 1 },
        { name: "r6", row: 1, col: 2, rowSpan: 1, colSpan: 1 },
        { name: "r7", row: 2, col: 0, rowSpan: 1, colSpan: 1 },
        { name: "r8", row: 2, col: 1, rowSpan: 1, colSpan: 1 },
        { name: "r9", row: 2, col: 2, rowSpan: 1, colSpan: 1 },
      ];
    } else {
      // Custom
      gridCols = parseInt(body?.["grid_cols"] ?? "12", 10);
      gridRows = parseInt(body?.["grid_rows"] ?? "12", 10);
      if (isNaN(gridCols) || gridCols < 1 || gridCols > 12) errors.push("Grid columns must be 1-12.");
      if (isNaN(gridRows) || gridRows < 1 || gridRows > 12) errors.push("Grid rows must be 1-12.");

      const regionsStr = (body?.["regions"] ?? "").trim();
      if (!regionsStr) {
        errors.push("Regions JSON is required for custom templates.");
      } else {
        try {
          regions = JSON.parse(regionsStr);
          if (!Array.isArray(regions) || regions.length === 0) {
            errors.push("Regions must be a non-empty JSON array.");
          }
        } catch {
          errors.push("Invalid JSON in regions field.");
        }
      }
    }

    if (errors.length > 0) {
      return htmlPage(TemplateNewPage({
        user: user.username,
        error: errors.join(" "),
        values: body,
      }));
    }

    deps.repo.createLayoutTemplate({
      name,
      regions,
      grid_cols: gridCols,
      grid_rows: gridRows,
    });

    return new Response(null, { status: 302, headers: { location: "/admin/templates" } });
  });

  app.get("/admin/templates/:id", (event) => {
    const user = event.context.user!;
    const id = Number(getRouterParam(event, "id"));
    const template = deps.repo.getLayoutTemplateById(id);
    if (!template) return new Response(null, { status: 302, headers: { location: "/admin/templates" } });
    return htmlPage(TemplateEditPage({ user: user.username, template }));
  });

  app.post("/admin/templates/:id", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    deps.repo.updateLayoutTemplate(id, {
      name: body?.["name"],
      description: body?.["description"] || null,
    });
    return new Response(null, { status: 302, headers: { location: `/admin/templates/${id}` } });
  });

  app.post("/admin/templates/:id/delete", (event) => {
    const id = Number(getRouterParam(event, "id"));
    deps.repo.deleteLayoutTemplate(id);
    return new Response(null, { status: 302, headers: { location: "/admin/templates" } });
  });

  // ---- Layouts ---------------------------------------------------------------

  app.get("/admin/layouts", (event) => {
    const user = event.context.user!;
    const layouts = deps.repo.listLayouts();
    const templateIds = [...new Set(layouts.map((l) => l.template_id))];
    const displayIds = [...new Set(layouts.map((l) => l.display_id))];
    const templates = new Map<number, LayoutTemplate>();
    for (const tid of templateIds) {
      const t = deps.repo.getLayoutTemplateById(tid);
      if (t) templates.set(tid, t);
    }
    const displays = new Map<number, Display>();
    for (const did of displayIds) {
      const d = deps.repo.getDisplayById(did);
      if (d) displays.set(did, d);
    }
    return htmlPage(LayoutsPage({ user: user.username, layouts, templates, displays }));
  });

  app.get("/admin/layouts/new", (event) => {
    const user = event.context.user!;
    return htmlPage(LayoutNewPage({
      user: user.username,
      templates: deps.repo.listLayoutTemplates(),
      displays: deps.repo.listDisplays(),
    }));
  });

  app.post("/admin/layouts/new", async (event) => {
    const user = event.context.user!;
    const body = await readBody<Record<string, string>>(event);
    const name = (body?.["name"] ?? "").trim();
    const templateId = parseInt(body?.["template_id"] ?? "", 10);
    const displayId = parseInt(body?.["display_id"] ?? "", 10);
    const priority = body?.["priority"] ?? "normal";
    const description = (body?.["description"] ?? "").trim() || null;
    const isDefault = body?.["is_default"] === "1";
    const resetsIdleTimer = body?.["resets_idle_timer"] === "1";
    const errors: string[] = [];

    if (!name || name.length > 128) errors.push("Name required (max 128 chars).");
    if (isNaN(templateId)) errors.push("Select a template.");
    if (isNaN(displayId)) errors.push("Select a display.");

    if (errors.length > 0) {
      return htmlPage(LayoutNewPage({
        user: user.username,
        templates: deps.repo.listLayoutTemplates(),
        displays: deps.repo.listDisplays(),
        error: errors.join(" "),
        values: body,
      }));
    }

    const layout = deps.repo.createLayout({
      name,
      description,
      template_id: templateId,
      display_id: displayId,
      priority,
      is_default: isDefault,
      resets_idle_timer: resetsIdleTimer,
    });

    return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layout.id}` } });
  });

  app.get("/admin/layouts/:id", (event) => {
    const user = event.context.user!;
    const id = Number(getRouterParam(event, "id"));
    const layout = deps.repo.getLayoutById(id);
    if (!layout) return new Response(null, { status: 302, headers: { location: "/admin/layouts" } });
    const template = deps.repo.getLayoutTemplateById(layout.template_id);
    if (!template) return new Response(null, { status: 302, headers: { location: "/admin/layouts" } });
    const display = deps.repo.getDisplayById(layout.display_id);
    if (!display) return new Response(null, { status: 302, headers: { location: "/admin/layouts" } });
    const cells = deps.repo.layoutCells(id);
    const cameras = deps.repo.listCameras();
    return htmlPage(LayoutEditPage({
      user: user.username,
      layout,
      template,
      display,
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
      is_default: body?.["is_default"] === "1",
      resets_idle_timer: body?.["resets_idle_timer"] === "1",
    });
    return new Response(null, { status: 302, headers: { location: `/admin/layouts/${id}` } });
  });

  app.post("/admin/layouts/:id/cells", async (event) => {
    const layoutId = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const regionName = (body?.["region_name"] ?? "").trim();
    const contentType = body?.["content_type"] ?? "camera";

    if (!regionName) {
      return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layoutId}` } });
    }

    deps.repo.createLayoutCell({
      layout_id: layoutId,
      region_name: regionName,
      content_type: contentType,
      camera_id: contentType === "camera" && body?.["camera_id"] ? Number(body["camera_id"]) : null,
      stream_selector: contentType === "camera" ? (body?.["stream_selector"] ?? "auto") : null,
      web_url: contentType === "web" ? (body?.["web_url"] ?? null) : null,
      html_content: contentType === "html" ? (body?.["html_content"] ?? null) : null,
    });

    return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layoutId}` } });
  });

  app.post("/admin/layouts/:id/cells/:cellId/delete", (event) => {
    const layoutId = Number(getRouterParam(event, "id"));
    const cellId = Number(getRouterParam(event, "cellId"));
    deps.repo.deleteLayoutCell(cellId);
    return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layoutId}` } });
  });

  app.post("/admin/layouts/:id/delete", (event) => {
    const id = Number(getRouterParam(event, "id"));
    deps.repo.deleteLayout(id);
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
    const layouts = deps.repo.layoutsForDisplay(id);
    return htmlPage(DisplayEditPage({ user: user.username, display, layouts }));
  });

  app.post("/admin/displays/:id", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const defaultLayoutId = body?.["default_layout_id"] ? Number(body["default_layout_id"]) : null;
    deps.repo.updateDisplay(id, {
      name: body?.["name"],
      default_layout_id: defaultLayoutId,
      idle_timeout_seconds: parseInt(body?.["idle_timeout_seconds"] ?? "0", 10),
      sleep_timeout_seconds: parseInt(body?.["sleep_timeout_seconds"] ?? "0", 10),
      width_px: body?.["width_px"] ? parseInt(body["width_px"], 10) : undefined,
      height_px: body?.["height_px"] ? parseInt(body["height_px"], 10) : undefined,
    } as any);
    return new Response(null, { status: 302, headers: { location: `/admin/displays/${id}` } });
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
    deps.repo.updateCamera(id, {
      name: body?.["name"],
      rtsp_url: body?.["rtsp_url"] ? sanitizeRtspUrl(body["rtsp_url"]) : null,
      onvif_host: body?.["onvif_host"] || null,
      onvif_port: body?.["onvif_port"] ? Number(body["onvif_port"]) : null,
      onvif_username: body?.["onvif_username"] || null,
      onvif_password: body?.["onvif_password"] || undefined,
      enabled: body?.["enabled"] === "1",
    } as any);
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
    return htmlPage(KioskEditPage({
      user: user.username,
      kiosk,
      labels: kioskLabels,
      allLabels: deps.repo.listLabels(),
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
}
