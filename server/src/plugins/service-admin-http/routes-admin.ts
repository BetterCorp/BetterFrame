/**
 * Admin page routes — overview, cameras, kiosks, labels, etc.
 */
import { type H3, readBody } from "h3";
import { htmlPage } from "./html-response.js";
import type { AdminDeps } from "./index.js";
import {
  OverviewPage,
  CamerasPage,
  CameraNewPage,
  KiosksPage,
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
    const labels = deps.repo.listLabels();
    return htmlPage(SimpleListPage({
      user: user.username,
      pageTitle: "Labels",
      description: "Labels route cameras, layouts, and kiosks to each other across sites.",
      activeNav: "labels",
      items: labels.map((l) => ({
        name: l.name,
        detail: l.description ?? "",
        badge: l.color ?? undefined,
      })),
    }));
  });
}
