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
  AuditLogPage,
  BackupPage,
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
  SystemHealthPage,
  NoderedEmbedPage,
  renderCell,
  renderGrid,
  renderCameraLabels,
  renderKioskLabels,
  renderDisplayLayouts,
  renderDefaultLayoutSelect,
} from "../../web-templates/admin-pages.js";
import { discover as onvifDiscover } from "../../shared/onvif.js";
import { generateBundle } from "../../shared/bundle.js";
import { captureSnapshot } from "../../shared/snapshot.js";
import { stripSecrets } from "../../shared/strip-secrets.js";
import { audit } from "../../shared/audit.js";
import { createBackup, restoreBackup } from "../../shared/backup.js";

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

function jsonResponse(value: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(stripSecrets(value)), {
    status,
    headers: { "content-type": "application/json" },
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

function kioskOnvifSoapTransport(kioskId: number) {
  return async (url: string, action: string, body: string, timeoutMs: number): Promise<string> => {
    if (!Number.isInteger(kioskId) || kioskId <= 0) {
      throw new Error("invalid kiosk selected for discovery");
    }
    const response = await getCoordinator().requestKiosk<{
      type?: string;
      request_id?: string;
      status?: number;
      body?: string;
      error?: string;
    }>(kioskId, {
      type: "onvif-soap-request",
      url,
      action,
      body,
      timeout_ms: timeoutMs,
    }, timeoutMs + 3000);

    if (response.error) throw new Error(response.error);
    const status = Number(response.status ?? 0);
    const text = response.body ?? "";
    if (status < 200 || status >= 300) {
      throw new Error(`ONVIF ${action} via kiosk ${String(kioskId)} HTTP ${String(status)}: ${text.slice(0, 300)}`);
    }
    return text;
  };
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
): number | null {
  if (streams.length === 0) return null;
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
  return cam.id;
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

  // ---- Backup / restore -----------------------------------------------------

  app.get("/admin/backup", (event) => {
    const user = event.context.user!;
    return htmlPage(BackupPage({ user: user.username }));
  });

  app.post("/admin/backup/download", async (event) => {
    const body = await readBody<Record<string, string>>(event);
    const pass = body?.["passphrase"] ?? "";
    let res;
    try {
      res = createBackup(deps.dataDir, pass);
    } catch (err) {
      audit(deps.repo, event as any, "backup.create", {
        result: "failed", metadata: { error: (err as Error).message },
      });
      return htmlPage(BackupPage({ user: event.context.user!.username, error: (err as Error).message }));
    }
    audit(deps.repo, event as any, "backup.create", {
      metadata: { file_count: res.fileCount, size: res.blob.length },
    });
    return new Response(new Uint8Array(res.blob), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${res.filename}"`,
        "content-length": String(res.blob.length),
      },
    });
  });

  app.post("/admin/backup/restore", async (event) => {
    const form = await event.req.formData();
    const file = form.get("blob");
    const pass = String(form.get("passphrase") ?? "");
    if (!(file instanceof File) || !pass) {
      return htmlPage(BackupPage({ user: event.context.user!.username, error: "blob + passphrase required" }));
    }
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      const res = restoreBackup(deps.dataDir, pass, buf);
      audit(deps.repo, event as any, "backup.restore", {
        metadata: { file_count: res.fileCount, files: res.files },
      });
      return htmlPage(BackupPage({
        user: event.context.user!.username,
        success: `Restored ${String(res.fileCount)} files: ${res.files.join(", ")}. RESTART THE SERVER NOW for changes to take effect.`,
      }));
    } catch (err) {
      audit(deps.repo, event as any, "backup.restore", {
        result: "failed", metadata: { error: (err as Error).message },
      });
      return htmlPage(BackupPage({ user: event.context.user!.username, error: (err as Error).message }));
    }
  });

  // ---- Audit log ------------------------------------------------------------

  app.get("/admin/audit", (event) => {
    const user = event.context.user!;
    const url = new URL(event.req.url);
    const filterAction = url.searchParams.get("action")?.trim() || undefined;
    const filterActorType = url.searchParams.get("actor_type")?.trim() || undefined;
    const entries = deps.repo.listAudit({
      limit: 300,
      action_prefix: filterAction,
      actor_type: filterActorType as any || undefined,
    });
    return htmlPage(AuditLogPage({ user: user.username, entries, filterAction, filterActorType }));
  });

  // ---- System Health --------------------------------------------------------

  app.get("/admin/health", (event) => {
    const user = event.context.user!;
    const kiosks = deps.repo.listKiosks();
    const now = Date.now();
    let clusterKey: string | undefined;
    try {
      const enc = deps.repo.getSetupExtra("cluster_key_encrypted") as string | undefined;
      if (enc) clusterKey = deps.secrets.decryptString(enc, "cluster");
    } catch { /* ignore */ }

    const rows = kiosks.map((k) => {
      const online = k.last_seen_at
        ? now - new Date(k.last_seen_at).getTime() < 5 * 60 * 1000
        : false;
      const displays = deps.repo.listDisplaysForKiosk(k.id);
      let expectedBundleVersion: string | null = null;
      try {
        const b = generateBundle(deps.repo, deps.secrets, k.id, clusterKey);
        expectedBundleVersion = b?.version ?? null;
      } catch { /* ignore */ }
      const bundleMismatch =
        expectedBundleVersion != null
        && k.last_bundle_version != null
        && k.last_bundle_version !== expectedBundleVersion;
      return {
        kiosk: k,
        online,
        bundleMismatch,
        expectedBundleVersion,
        displays,
      };
    });

    return htmlPage(SystemHealthPage({ user: user.username, rows }));
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
    deps.nodered.forward("camera.changed", { camera_id: cam.id, event: "created" });

    return new Response(null, {
      status: 302,
      headers: { location: "/admin/cameras" },
    });
  });

  // ---- Camera ONVIF discovery ------------------------------------------------

  app.get("/admin/cameras/discover", (event) => {
    const user = event.context.user!;
    return htmlPage(CameraDiscoverPage({
      user: user.username,
      kiosks: deps.repo.listKiosks(),
    }));
  });

  app.post("/admin/cameras/discover", async (event) => {
    const user = event.context.user!;
    const body = await readBody<Record<string, string>>(event);
    const host = (body?.["host"] ?? "").trim();
    const port = parseInt(body?.["port"] ?? "80", 10) || 80;
    const username = (body?.["username"] ?? "").trim();
    const password = body?.["password"] ?? "";
    const runner = (body?.["discovery_runner"] ?? "server").trim();

    if (!host) {
      return htmlPage(CameraDiscoverPage({
        user: user.username,
        kiosks: deps.repo.listKiosks(),
        error: "Host required.",
        values: body,
      }));
    }

    try {
      const soapTransport = runner.startsWith("kiosk:")
        ? kioskOnvifSoapTransport(Number(runner.slice("kiosk:".length)))
        : undefined;
      const cameras = await onvifDiscover({ host, port, username, password, soapTransport });
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
        kiosks: deps.repo.listKiosks(),
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
        const camId = importDiscoveredCamera(deps, rawName, username, password, streams);
        if (camId != null) {
          deps.nodered.forward("camera.changed", { camera_id: camId, event: "created" });
        }
        imported += 1;
      }
    } else {
      const rawName = formValue(body?.["name"]).trim() || "ONVIF camera";
      const streams = parseDiscoveredStreams(formValue(body?.["streams_json"]));
      if (streams.length > 0) {
        const camId = importDiscoveredCamera(deps, rawName, username, password, streams);
        if (camId != null) {
          deps.nodered.forward("camera.changed", { camera_id: camId, event: "created" });
        }
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

  // Camera snapshot — pulls one frame from the entity's main stream and
  // returns it as JPEG. Used by the EntityEditPage "Test" preview.
  app.get("/admin/entities/:id/snapshot", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const ent = deps.repo.getEntityById(id);
    if (!ent || ent.type !== "camera" || ent.camera_id == null) {
      return new Response("Not a camera entity", { status: 404 });
    }
    const streams = deps.repo.listCameraStreams(ent.camera_id);
    const main = streams.find((s) => s.role === "main") ?? streams[0];
    const cam = deps.repo.getCameraById(ent.camera_id);
    const rtsp = main?.rtsp_uri ?? cam?.rtsp_url ?? null;
    if (!rtsp) return new Response("No RTSP URL", { status: 404 });

    const jpeg = await captureSnapshot(rtsp, { timeoutMs: 8000 });
    if (!jpeg) {
      return new Response("Snapshot failed (camera unreachable or ffmpeg/gst missing)", { status: 502 });
    }
    return new Response(jpeg, {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
      },
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
    const replaceIdRaw = (body?.["replace_kiosk_id"] ?? "").trim();
    const replaceKioskId = replaceIdRaw && replaceIdRaw !== "0" ? Number(replaceIdRaw) : undefined;

    try {
      const result = await confirmPairing(deps.repo, deps.auth, deps.secrets, {
        code,
        nameOverride,
        initialLabels,
        replaceKioskId,
      });
      audit(deps.repo, event as any, replaceKioskId ? "kiosk.replace" : "kiosk.pair", {
        resource_type: "kiosk",
        resource_id: result.kioskId,
        metadata: { name: result.kioskName, code, replaced: !!replaceKioskId },
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

    // stream_selector + spans + fit are still settable on the cell.
    const dimsPatch: Record<string, unknown> = {};
    const streamSelector = body?.["stream_selector"];
    if (streamSelector === "auto" || streamSelector === "main" || streamSelector === "sub") {
      dimsPatch["stream_selector"] = streamSelector;
    }
    const fit = body?.["fit"];
    if (fit === "cover" || fit === "contain" || fit === "fill") {
      dimsPatch["fit"] = fit;
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
      is_enabled: body?.["is_enabled"] === "on" || body?.["is_enabled"] === "1" ? 1 : 0,
    } as any);
    notifyKiosks();
    return new Response(null, { status: 302, headers: { location: `/admin/displays/${id}` } });
  });

  // Render the attached + available layouts region for a display.
  const renderDisplayLayoutsFragment = (displayId: number): Response => {
    const display = deps.repo.getDisplayById(displayId);
    const attached = deps.repo.listLayoutsForDisplay(displayId);
    const attachedIds = new Set(attached.map((l) => l.id));
    const available = deps.repo.listLayouts().filter((l) => !attachedIds.has(l.id));
    return htmlFragment(
      renderDisplayLayouts(displayId, display?.default_layout_id ?? null, attached, available)
      + renderDefaultLayoutSelect(display?.default_layout_id ?? null, attached, true),
    );
  };

  // Attach a layout to a display.
  app.post("/admin/displays/:id/layouts", async (event) => {
    const displayId = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const layoutId = body?.["layout_id"] ? Number(body["layout_id"]) : null;
    if (layoutId && Number.isFinite(layoutId)) {
      deps.repo.attachLayoutToDisplay(displayId, layoutId);
      notifyKiosks();
    }
    if (isHtmxRequest(event)) {
      return renderDisplayLayoutsFragment(displayId);
    }
    return new Response(null, { status: 302, headers: { location: `/admin/displays/${displayId}` } });
  });

  // Detach a layout from a display.
  app.post("/admin/displays/:id/layouts/:layoutId/remove", (event) => {
    const displayId = Number(getRouterParam(event, "id"));
    const layoutId = Number(getRouterParam(event, "layoutId"));
    deps.repo.detachLayoutFromDisplay(displayId, layoutId);
    notifyKiosks();
    if (isHtmxRequest(event)) {
      return renderDisplayLayoutsFragment(displayId);
    }
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
      } else {
        deps.repo.createCameraStream({
          camera_id: id,
          role: "main",
          name: "Main",
          rtsp_uri: rtspUrl,
        });
      }
    }
    notifyKiosks();
    deps.nodered.forward("camera.changed", { camera_id: id, event: "updated" });

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
    if (isHtmxRequest(event)) {
      return htmlFragment(renderCameraLabels(camId, deps.repo.cameraLabelIds(camId), deps.repo.listLabels()));
    }
    return new Response(null, { status: 302, headers: { location: `/admin/cameras/${camId}` } });
  });

  app.post("/admin/cameras/:id/labels/remove", async (event) => {
    const camId = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const labelId = Number(body?.["label_id"]);
    deps.repo.detachCameraLabel(camId, labelId);
    if (isHtmxRequest(event)) {
      return htmlFragment(renderCameraLabels(camId, deps.repo.cameraLabelIds(camId), deps.repo.listLabels()));
    }
    return new Response(null, { status: 302, headers: { location: `/admin/cameras/${camId}` } });
  });

  app.post("/admin/cameras/:id/delete", (event) => {
    const id = Number(getRouterParam(event, "id"));
    deps.repo.deleteCamera(id);
    notifyKiosks();
    deps.nodered.forward("camera.changed", { camera_id: id, event: "deleted" });
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
    const displayLayouts = displays.map((display) => ({
      display,
      layouts: deps.repo.listLayoutsForDisplay(display.id),
    }));
    const gpioBindings = deps.repo.listGpioBindings(id);
    const firmwareReleases = deps.repo.listFirmwareReleases();
    return htmlPage(KioskEditPage({
      user: user.username,
      kiosk,
      labels: kioskLabels,
      allLabels: deps.repo.listLabels(),
      displays,
      displayLayouts,
      gpioBindings,
      firmwareReleases,
    }));
  });

  // ---- GPIO bindings ----------------------------------------------------
  app.post("/admin/kiosks/:id/gpio", async (event) => {
    const kioskId = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const pin = Number(body?.["pin"]);
    const direction = (body?.["direction"] ?? "in") === "out" ? "out" : "in";
    const pullRaw = body?.["pull"];
    const pull = pullRaw === "up" || pullRaw === "down" || pullRaw === "none" ? pullRaw : null;
    const edgeRaw = body?.["edge"];
    const edge = edgeRaw === "rising" || edgeRaw === "falling" || edgeRaw === "both" ? edgeRaw : null;
    const chip = (body?.["chip"] ?? "gpiochip0").trim() || "gpiochip0";
    const topic = (body?.["topic"] ?? "").trim();
    if (Number.isFinite(pin) && topic) {
      deps.repo.createGpioBinding({
        kiosk_id: kioskId,
        chip,
        pin,
        direction,
        pull,
        edge,
        topic,
      });
      notifyKiosks();
    }
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${kioskId}` } });
  });

  app.post("/admin/kiosks/:id/gpio/:bindingId/delete", (event) => {
    const kioskId = Number(getRouterParam(event, "id"));
    const bindingId = Number(getRouterParam(event, "bindingId"));
    deps.repo.deleteGpioBinding(bindingId);
    notifyKiosks();
    if (isHtmxRequest(event)) {
      // Row is swapped via hx-target="closest tr" hx-swap="outerHTML" — empty
      // response collapses the row out of the table.
      return htmlFragment("");
    }
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${kioskId}` } });
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

  // Managed-image device config — admin pushes hostname/timezone/network/wifi
  // for kiosks running our pre-built Pi image. Builds a ManagedConfig object,
  // encrypts the wifi PSK with the cluster key (so it can be stored at rest
  // and delivered as ciphertext that the kiosk decrypts on-device with the
  // cluster key it received at pairing), then bumps managed_config_version
  // so the next heartbeat ships it to the kiosk.
  app.post("/admin/kiosks/:id/managed-config", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const kiosk = deps.repo.getKioskById(id);
    if (!kiosk) throw new Error("kiosk not found");
    if (!kiosk.managed_image) throw new Error("kiosk is not running a managed image");
    const body = await readBody<Record<string, string>>(event);

    const trim = (v: string | undefined) => (v ?? "").trim();
    const cfg: Record<string, unknown> = {};
    const hostname = trim(body?.["hostname"]);
    if (hostname) cfg["hostname"] = hostname;
    const timezone = trim(body?.["timezone"]);
    if (timezone) cfg["timezone"] = timezone;

    const netMode = trim(body?.["network_mode"]);
    if (netMode === "dhcp" || netMode === "static") {
      const net: Record<string, unknown> = { mode: netMode };
      const iface = trim(body?.["network_interface"]);
      if (iface) net["interface"] = iface;
      if (netMode === "static") {
        const ipCidr = trim(body?.["network_ip_cidr"]);
        if (ipCidr) net["ip_cidr"] = ipCidr;
        const gw = trim(body?.["network_gateway"]);
        if (gw) net["gateway"] = gw;
        const dnsRaw = trim(body?.["network_dns"]);
        if (dnsRaw) {
          net["dns"] = dnsRaw.split(",").map((s) => s.trim()).filter(Boolean);
        }
      }
      const vlanRaw = trim(body?.["network_vlan_id"]);
      if (vlanRaw) {
        const vlanId = Number(vlanRaw);
        if (Number.isInteger(vlanId) && vlanId >= 1 && vlanId <= 4094) {
          net["vlan_id"] = vlanId;
        }
      }
      cfg["network"] = net;
    }

    // Wifi: load existing first so blank PSK = "keep current". Re-encrypt PSK
    // only when the operator actually typed one.
    const ssid = trim(body?.["wifi_ssid"]);
    const pskPlaintext = body?.["wifi_psk"] ?? "";
    if (ssid) {
      const prev = kiosk.managed_config_json ? JSON.parse(kiosk.managed_config_json) : null;
      let pskCiphertext: string | null = prev?.wifi?.psk_ciphertext ?? null;
      if (pskPlaintext) {
        pskCiphertext = deps.secrets.encryptString(pskPlaintext, "cluster");
      }
      if (pskCiphertext) {
        cfg["wifi"] = { ssid, psk_ciphertext: pskCiphertext };
      }
    }

    deps.repo.updateKiosk(id, {
      managed_config_json: JSON.stringify(cfg),
      managed_config_version: kiosk.managed_config_version + 1,
      managed_config_error: null,
    } as any);

    audit(deps.repo, event as any, "kiosk.managed_config.update", {
      resource_type: "kiosk",
      resource_id: String(id),
      metadata: { version: kiosk.managed_config_version + 1 },
    });

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
    if (isHtmxRequest(event)) {
      const kioskLabels = deps.repo.listKioskLabels(kioskId).map((kl) => ({
        label_id: kl.label_id,
        name: kl.name,
        role: kl.role,
      }));
      return htmlFragment(renderKioskLabels(kioskId, kioskLabels, deps.repo.listLabels()));
    }
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${kioskId}` } });
  });

  app.post("/admin/kiosks/:id/labels/remove", async (event) => {
    const kioskId = Number(getRouterParam(event, "id"));
    const body = await readBody<Record<string, string>>(event);
    const labelId = Number(body?.["label_id"]);
    deps.repo.detachKioskLabel(kioskId, labelId);
    if (isHtmxRequest(event)) {
      const kioskLabels = deps.repo.listKioskLabels(kioskId).map((kl) => ({
        label_id: kl.label_id,
        name: kl.name,
        role: kl.role,
      }));
      return htmlFragment(renderKioskLabels(kioskId, kioskLabels, deps.repo.listLabels()));
    }
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${kioskId}` } });
  });

  app.post("/admin/kiosks/:id/delete", (event) => {
    const id = Number(getRouterParam(event, "id"));
    deps.repo.deleteKiosk(id);
    return new Response(null, { status: 302, headers: { location: "/admin/kiosks" } });
  });

  // ---- Layout switch ----------------------------------------------------
  const emitLayoutChanged = (displayId: number | null, kioskId: number | null, layoutId: number) => {
    const layout = deps.repo.getLayoutById(layoutId);
    deps.nodered.forward("layout.changed", {
      display_id: displayId,
      kiosk_id: kioskId,
      layout_id: layoutId,
      layout_name: layout?.name ?? null,
    });
  };

  const displayLayoutSwitch = async (event: any) => {
    const displayId = Number(getRouterParam(event, "displayId"));
    let layoutId = Number(getRouterParam(event, "layoutId"));
    if (!Number.isFinite(layoutId) || layoutId <= 0) {
      const body = await readBody<Record<string, string>>(event);
      layoutId = Number(body?.["layout_id"]);
    }
    if (Number.isFinite(displayId) && Number.isFinite(layoutId)) {
      const display = deps.repo.getDisplayById(displayId);
      const attached = deps.repo.listLayoutsForDisplay(displayId);
      const isAttached = attached.some((l) => l.id === layoutId);
      if (display?.kiosk_id && isAttached) {
        getCoordinator().sendToKiosk(display.kiosk_id, {
          type: "layout-switch",
          display_id: displayId,
          layout_id: layoutId,
        });
        emitLayoutChanged(displayId, display.kiosk_id, layoutId);
      }
    }
    return new Response(null, { status: 302, headers: { location: `/admin/displays/${displayId}` } });
  };
  app.post("/admin/displays/:displayId/layout", displayLayoutSwitch);
  app.post("/admin/displays/:displayId/layout/:layoutId", displayLayoutSwitch);
  app.get("/admin/displays/:displayId/layout/:layoutId", displayLayoutSwitch);

  // Node-RED embedded page
  app.get("/admin/nodered", (event) => {
    const user = event.context.user!;
    return htmlPage(NoderedEmbedPage({ user: user.username }));
  });

  // ---- CEC power commands -----------------------------------------------
  const emitDisplayPower = (kioskId: number, state: "on" | "standby") => {
    const displays = deps.repo.listDisplaysForKiosk(kioskId);
    const displayId = displays[0]?.id ?? null;
    deps.nodered.forward("display.power.changed", {
      display_id: displayId,
      kiosk_id: kioskId,
      state,
    });
  };

  app.post("/admin/kiosks/:id/power/standby", (event) => {
    const id = Number(getRouterParam(event, "id"));
    getCoordinator().sendToKiosk(id, { type: "standby" });
    emitDisplayPower(id, "standby");
    audit(deps.repo, event as any, "display.standby", { resource_type: "kiosk", resource_id: id });
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${id}` } });
  });

  app.post("/admin/kiosks/:id/power/wake", (event) => {
    const id = Number(getRouterParam(event, "id"));
    getCoordinator().sendToKiosk(id, { type: "wake" });
    emitDisplayPower(id, "on");
    audit(deps.repo, event as any, "display.wake", { resource_type: "kiosk", resource_id: id });
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

  // ---- JSON API (admin scope) — used by Node-RED bf-* nodes ---------------
  //
  // All payloads run through `stripSecrets` so credential-bearing fields
  // (key_hash, onvif_password, totp_secret_encrypted, etc.) never leak to
  // automation clients. List shapes are kept thin (id/name/type/enabled +
  // labels where useful); detail shapes return the full row minus secrets.

  app.get("/api/admin/cameras", (_event) => {
    const cameras = deps.repo.listCameras();
    const payload = cameras.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      enabled: c.enabled,
      labels: deps.repo.cameraLabelNames(c.id),
    }));
    return jsonResponse({ cameras: payload });
  });

  app.get("/api/admin/cameras/:id", (event) => {
    const id = Number(getRouterParam(event, "id"));
    const cam = deps.repo.getCameraById(id);
    if (!cam) return jsonResponse({ error: "not_found" }, 404);
    const streams = deps.repo.listCameraStreams(id);
    return jsonResponse({
      camera: { ...cam, labels: deps.repo.cameraLabelNames(id), streams },
    });
  });

  app.get("/api/admin/displays", (_event) => {
    const displays = deps.repo.listDisplays();
    return jsonResponse({ displays });
  });

  app.get("/api/admin/displays/:id", (event) => {
    const id = Number(getRouterParam(event, "id"));
    const display = deps.repo.getDisplayById(id);
    if (!display) return jsonResponse({ error: "not_found" }, 404);
    const attachedLayouts = deps.repo.listLayoutsForDisplay(id);
    return jsonResponse({ display: { ...display, attached_layouts: attachedLayouts } });
  });

  app.get("/api/admin/kiosks", (_event) => {
    const kiosks = deps.repo.listKiosks();
    const now = Date.now();
    const payload = kiosks.map((k) => ({
      id: k.id,
      name: k.name,
      enabled: k.enabled,
      hardware_model: k.hardware_model,
      last_seen_at: k.last_seen_at,
      online: k.last_seen_at
        ? now - new Date(k.last_seen_at).getTime() < 5 * 60 * 1000
        : false,
      cpu_temp_c: k.cpu_temp_c,
      fan_rpm: k.fan_rpm,
      fan_pwm: k.fan_pwm,
    }));
    return jsonResponse({ kiosks: payload });
  });

  app.get("/api/admin/kiosks/:id", (event) => {
    const id = Number(getRouterParam(event, "id"));
    const kiosk = deps.repo.getKioskById(id);
    if (!kiosk) return jsonResponse({ error: "not_found" }, 404);
    const displays = deps.repo.listDisplaysForKiosk(id);
    const labels = deps.repo.listKioskLabels(id).map((kl) => ({
      label_id: kl.label_id,
      name: kl.name,
      role: kl.role,
    }));
    return jsonResponse({ kiosk: { ...kiosk, displays, labels } });
  });

  app.get("/api/admin/layouts", (_event) => {
    const layouts = deps.repo.listLayouts();
    return jsonResponse({ layouts });
  });

  app.get("/api/admin/layouts/:id", (event) => {
    const id = Number(getRouterParam(event, "id"));
    const layout = deps.repo.getLayoutById(id);
    if (!layout) return jsonResponse({ error: "not_found" }, 404);
    const cells = deps.repo.layoutCells(id);
    const displays = deps.repo.listDisplaysForLayout(id);
    return jsonResponse({ layout: { ...layout, cells, displays } });
  });

  app.get("/api/admin/entities", (_event) => {
    const entities = deps.repo.listEntities();
    return jsonResponse({ entities });
  });

  app.get("/api/admin/entities/:id", (event) => {
    const id = Number(getRouterParam(event, "id"));
    const entity = deps.repo.getEntityById(id);
    if (!entity) return jsonResponse({ error: "not_found" }, 404);
    return jsonResponse({ entity });
  });

  // ---- JSON mutation API — used by Node-RED bf-config-set node ------------
  //
  // Body shape: { value: <new value> } — keeps the wire format uniform
  // across all set ops. Returns the post-mutation entity.

  app.post("/api/admin/displays/:id/default-layout", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const body = (await readBody<Record<string, unknown>>(event)) ?? {};
    const raw = body["value"] ?? body["default_layout_id"];
    const layoutId = raw == null || raw === "" ? null : Number(raw);
    if (raw != null && raw !== "" && !Number.isFinite(layoutId)) {
      return jsonResponse({ error: "invalid_value" }, 400);
    }
    if (layoutId != null) {
      const attached = deps.repo.listLayoutsForDisplay(id);
      if (!attached.some((l) => l.id === layoutId)) {
        return jsonResponse({ error: "layout_not_attached" }, 400);
      }
    }
    deps.repo.updateDisplay(id, { default_layout_id: layoutId } as any);
    notifyKiosks();
    const display = deps.repo.getDisplayById(id);
    return jsonResponse({ display });
  });

  app.post("/api/admin/kiosks/:id/enabled", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const body = (await readBody<Record<string, unknown>>(event)) ?? {};
    const enabled = Boolean(body["value"] ?? body["enabled"]);
    deps.repo.updateKiosk(id, { enabled } as any);
    const kiosk = deps.repo.getKioskById(id);
    if (!kiosk) return jsonResponse({ error: "not_found" }, 404);
    return jsonResponse({ kiosk });
  });

  app.post("/api/admin/cameras/:id/enabled", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const body = (await readBody<Record<string, unknown>>(event)) ?? {};
    const enabled = Boolean(body["value"] ?? body["enabled"]);
    deps.repo.updateCamera(id, { enabled } as any);
    notifyKiosks();
    deps.nodered.forward("camera.changed", { camera_id: id, event: "updated" });
    const camera = deps.repo.getCameraById(id);
    if (!camera) return jsonResponse({ error: "not_found" }, 404);
    return jsonResponse({ camera });
  });

  app.post("/api/admin/layouts/:id/priority", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const body = (await readBody<Record<string, unknown>>(event)) ?? {};
    const value = String(body["value"] ?? body["priority"] ?? "").toLowerCase();
    if (value !== "hot" && value !== "normal" && value !== "cold") {
      return jsonResponse({ error: "invalid_priority" }, 400);
    }
    deps.repo.updateLayout(id, { priority: value } as any);
    notifyKiosks();
    const layout = deps.repo.getLayoutById(id);
    if (!layout) return jsonResponse({ error: "not_found" }, 404);
    return jsonResponse({ layout });
  });

  app.post("/api/admin/entities/:id/name", async (event) => {
    const id = Number(getRouterParam(event, "id"));
    const body = (await readBody<Record<string, unknown>>(event)) ?? {};
    const name = String(body["value"] ?? body["name"] ?? "").trim();
    if (!name || name.length > 128) {
      return jsonResponse({ error: "invalid_name" }, 400);
    }
    const existing = deps.repo.getEntityByName(name);
    if (existing && existing.id !== id) {
      return jsonResponse({ error: "name_in_use" }, 400);
    }
    deps.repo.updateEntity(id, { name });
    notifyKiosks();
    const entity = deps.repo.getEntityById(id);
    if (!entity) return jsonResponse({ error: "not_found" }, 404);
    return jsonResponse({ entity });
  });

  // ---- Dashboard entity sync — pull tabs from Node-RED, mirror as entities --
  app.post("/admin/entities/sync-dashboards", async (event) => {
    const result = await syncDashboardsFromNodered(deps);
    if (isHtmxRequest(event)) {
      return htmlFragment(
        `<div class="flash flash-success">Synced: +${String(result.added)} added, ${String(result.updated)} updated, ${String(result.total)} total.</div>`,
      );
    }
    return new Response(null, { status: 302, headers: { location: "/admin/entities" } });
  });
}

/**
 * Pull dashboard tabs from the Node-RED runtime and mirror them as `dashboard`
 * entities. Idempotent: existing entities matched by dashboard_id get name
 * updates, new tabs get inserted. Tabs that no longer exist are NOT auto-
 * deleted — admins might still be using a stale layout cell that points to one,
 * and dashboards are cheap to leave around.
 */
async function syncDashboardsFromNodered(
  deps: AdminDeps,
): Promise<{ added: number; updated: number; total: number }> {
  const tabs = await deps.nodered.listDashboards();
  let added = 0;
  let updated = 0;
  for (const tab of tabs) {
    const existing = deps.repo.getEntityForDashboard(tab.id);
    if (existing) {
      if (existing.name !== tab.name) {
        // Avoid name collisions with non-dashboard entities of the same name.
        const collision = deps.repo.getEntityByName(tab.name);
        const safeName = collision && collision.id !== existing.id
          ? `${tab.name} (dash ${tab.id.slice(0, 6)})`
          : tab.name;
        deps.repo.updateEntity(existing.id, { name: safeName });
        updated += 1;
      }
      continue;
    }
    // New dashboard tab — insert.
    let name = tab.name || `Dashboard ${tab.id.slice(0, 6)}`;
    if (deps.repo.getEntityByName(name)) {
      name = `${name} (dash ${tab.id.slice(0, 6)})`;
    }
    deps.repo.createEntity({
      name,
      type: "dashboard",
      dashboard_id: tab.id,
      description: tab.hidden ? "hidden tab" : null,
    });
    added += 1;
  }
  if (added > 0 || updated > 0) {
    try { getCoordinator().notifyBundleChanged(); } catch { /* ignore */ }
  }
  return { added, updated, total: tabs.length };
}
