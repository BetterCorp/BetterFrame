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
  SimpleListPage,
} from "../../web-templates/admin-pages.js";

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
      rtspUrl = (body?.["rtsp_url"] ?? "").trim();
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

  // ---- Simple list pages (templates, layouts, displays, labels) -------------

  app.get("/admin/templates", (event) => {
    const user = event.context.user!;
    return htmlPage(SimpleListPage({
      user: user.username,
      pageTitle: "Layout Templates",
      description: "Templates define named regions on a 12x12 grid. A visual template designer is coming.",
      activeNav: "templates",
      items: [], // TODO: list templates
    }));
  });

  app.get("/admin/layouts", (event) => {
    const user = event.context.user!;
    return htmlPage(SimpleListPage({
      user: user.username,
      pageTitle: "Layouts",
      description: "A layout binds cameras and other content into a template's regions for one display.",
      activeNav: "layouts",
      items: [], // TODO: list layouts
    }));
  });

  app.get("/admin/displays", (event) => {
    const user = event.context.user!;
    const displays = deps.repo.listDisplays();
    return htmlPage(SimpleListPage({
      user: user.username,
      pageTitle: "Displays",
      description: "Physical HDMI displays. Primary display created during setup.",
      activeNav: "displays",
      items: displays.map((d) => ({
        name: d.name,
        detail: `${d.width_px}x${d.height_px} — index ${d.index}`,
      })),
    }));
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
      rtsp_url: body?.["rtsp_url"] || null,
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
