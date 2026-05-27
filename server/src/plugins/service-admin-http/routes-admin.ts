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
  SettingsPage,
} from "../../web-templates/admin-pages.js";
import { discover as onvifDiscover, getEventProperties as onvifGetEventProperties } from "../../shared/onvif.js";
import { generateBundle } from "../../shared/bundle.js";
import { captureSnapshot } from "../../shared/snapshot.js";
import { stripSecrets } from "../../shared/strip-secrets.js";
import { audit } from "../../shared/audit.js";
import { createBackup, restoreBackup } from "../../shared/backup.js";
import { pickKioskLanIp } from "../../shared/kiosk-lan.js";

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

function hostnameFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 63)
    .replace(/^-+|-+$/g, "");
  return slug || "betterframe-kiosk";
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

async function uniqueCameraName(deps: AdminDeps, rawName: string): Promise<string> {
  let name = rawName;
  if (await deps.repo.getCameraByName(name)) {
    let i = 2;
    while (await deps.repo.getCameraByName(`${rawName} (${String(i)})`)) i += 1;
    name = `${rawName} (${String(i)})`;
  }
  return name;
}

/** Decode XML entities that ONVIF SOAP responses may embed in URIs. */
function decodeXmlEntities(raw: string): string {
  return raw.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/**
 * Build a playable RTSP URL by injecting credentials into a raw URI.
 * Used for the legacy `rtsp_uri` column (display / backward compat).
 * For ONVIF-discovered streams the NEW path is: store components separately
 * and build the final URL at bundle time. This function is still used for
 * the camera row's `rtsp_url` and the stream's display-only `rtsp_uri`.
 */
function rtspWithCredentials(raw: string, username: string, password: string): string {
  const clean = decodeXmlEntities(raw);
  if (!username) return clean;
  try {
    const url = new URL(clean);
    if (url.protocol !== "rtsp:" || url.username) return clean;
    url.username = username;
    url.password = password;
    return url.toString();
  } catch {
    return clean;
  }
}

/** Parse an RTSP URI into host / port / path components. */
function parseRtspComponents(raw: string): { host: string | null; port: number | null; path: string | null } {
  const clean = decodeXmlEntities(raw);
  try {
    const url = new URL(clean);
    if (url.protocol !== "rtsp:") return { host: null, port: null, path: null };
    const host = url.hostname || null;
    const port = url.port ? Number(url.port) : 554;
    // path + decoded query string (no hash — RTSP doesn't use fragments)
    let path = url.pathname || "/";
    if (url.search) path += url.search;
    return { host, port, path };
  } catch {
    return { host: null, port: null, path: null };
  }
}

function formValue(v: FormValue): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function formValues(v: FormValue): string[] {
  if (Array.isArray(v)) return v;
  return v ? [v] : [];
}

function kioskOnvifSoapTransport(kioskId: string) {
  return async (url: string, action: string, body: string, timeoutMs: number): Promise<string> => {
    if (!kioskId) {
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

async function importDiscoveredCamera(
  deps: AdminDeps,
  rawName: string,
  onvifHost: string,
  onvifPort: number,
  username: string,
  password: string,
  streams: DiscoverAddStream[],
): Promise<string | null> {
  if (streams.length === 0) return null;
  const main = streams.find((s) => s.role === "main") ?? streams[0]!;
  // Camera row's rtsp_url: full URL with credentials for display / backward compat.
  const mainRtspUrl = rtspWithCredentials(main.stream_uri, username, password);
  const name = await uniqueCameraName(deps, rawName || "ONVIF camera");

  const cam = await deps.repo.createCamera({
    name,
    type: "onvif",
    rtsp_url: mainRtspUrl,
    onvif_host: onvifHost,
    onvif_port: onvifPort,
    onvif_username: username,
    onvif_password: password,
  } as any);
  for (const stream of streams) {
    const width = stream.width == null ? null : Number(stream.width);
    const height = stream.height == null ? null : Number(stream.height);
    const framerate = stream.framerate == null ? null : Number(stream.framerate);

    // Parse RTSP URI into components. Credentials come from the camera row
    // at bundle time — do NOT bake them into the stream's rtsp_uri.
    const cleanUri = decodeXmlEntities(stream.stream_uri);
    const components = parseRtspComponents(stream.stream_uri);

    // Stream rtsp_uri: store the XML-decoded URI WITHOUT credentials for
    // display / backward compat. Bundle generation builds the final
    // playable URL from components + camera credentials.
    let displayUri = cleanUri;
    try {
      const parsed = new URL(cleanUri);
      // Strip any credentials the ONVIF device may have embedded
      parsed.username = "";
      parsed.password = "";
      displayUri = parsed.toString();
    } catch { /* keep cleanUri as-is */ }

    await deps.repo.createCameraStream({
      camera_id: cam.id,
      role: stream.role === "main" || stream.role === "sub" ? stream.role : "other",
      name: stream.profile_name || stream.role,
      rtsp_uri: displayUri,
      rtsp_host: components.host ?? onvifHost,
      rtsp_port: components.port ?? 554,
      rtsp_path: components.path ?? null,
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

function cellsOverlap(
  a: { row: number; col: number; row_span: number; col_span: number },
  b: { row: number; col: number; row_span: number; col_span: number },
): boolean {
  return (
    a.col < b.col + b.col_span &&
    b.col < a.col + a.col_span &&
    a.row < b.row + b.row_span &&
    b.row < a.row + a.row_span
  );
}

interface CellPos {
  id: string;
  row: number;
  col: number;
  row_span: number;
  col_span: number;
}

async function resolveOverlaps(
  deps: AdminDeps,
  layoutId: string,
  anchorId: string,
  pushAxis: "row" | "col",
): Promise<void> {
  const all = await deps.repo.layoutCells(layoutId);
  const positions = new Map<string, CellPos>();
  for (const c of all) {
    positions.set(c.id, { id: c.id, row: c.row, col: c.col, row_span: c.row_span, col_span: c.col_span });
  }

  const maxIter = positions.size * positions.size;
  for (let iter = 0; iter < maxIter; iter++) {
    let moved = false;
    const anchor = positions.get(anchorId);
    if (!anchor) break;

    for (const [id, pos] of positions) {
      if (id === anchorId) continue;
      if (!cellsOverlap(anchor, pos)) continue;

      if (pushAxis === "col") {
        pos.col = anchor.col + anchor.col_span;
      } else {
        pos.row = anchor.row + anchor.row_span;
      }
      moved = true;
    }
    if (!moved) break;

    // Cascade: pushed cells may now overlap each other.
    // Sort by position on push axis so earlier cells push later ones.
    const sorted = [...positions.values()].sort((a, b) =>
      pushAxis === "col" ? a.col - b.col || a.row - b.row : a.row - b.row || a.col - b.col,
    );

    let cascaded = false;
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[i]!.id === sorted[j]!.id) continue;
        if (!cellsOverlap(sorted[i]!, sorted[j]!)) continue;
        if (pushAxis === "col") {
          sorted[j]!.col = sorted[i]!.col + sorted[i]!.col_span;
        } else {
          sorted[j]!.row = sorted[i]!.row + sorted[i]!.row_span;
        }
        cascaded = true;
      }
    }
    if (!cascaded) break;
  }

  for (const pos of positions.values()) {
    const orig = all.find((c) => c.id === pos.id)!;
    if (orig.row !== pos.row || orig.col !== pos.col) {
      await deps.repo.updateLayoutCell(pos.id, { row: pos.row, col: pos.col });
    }
  }
}

async function shiftCellsForExpansion(
  deps: AdminDeps,
  layoutId: string,
  cellId: string,
  direction: "left" | "right" | "above" | "bottom",
): Promise<void> {
  const cell = await deps.repo.getLayoutCellById(cellId);
  if (!cell || cell.layout_id !== layoutId) return;

  if (direction === "right") {
    await deps.repo.updateLayoutCell(cell.id, { col_span: cell.col_span + 1 });
    await resolveOverlaps(deps, layoutId, cell.id, "col");
  } else if (direction === "bottom") {
    await deps.repo.updateLayoutCell(cell.id, { row_span: cell.row_span + 1 });
    await resolveOverlaps(deps, layoutId, cell.id, "row");
  } else if (direction === "left") {
    const newCol = Math.max(0, cell.col - 1);
    await deps.repo.updateLayoutCell(cell.id, { col: newCol, col_span: cell.col_span + 1 });
    await resolveOverlaps(deps, layoutId, cell.id, "col");
  } else if (direction === "above") {
    const newRow = Math.max(0, cell.row - 1);
    await deps.repo.updateLayoutCell(cell.id, { row: newRow, row_span: cell.row_span + 1 });
    await resolveOverlaps(deps, layoutId, cell.id, "row");
  }
}

async function shiftCellsForInsertion(
  deps: AdminDeps,
  layoutId: string,
  axis: "row" | "col",
  fromIndex: number,
  crossStart: number,
  crossEnd: number,
): Promise<void> {
  for (const c of await deps.repo.layoutCells(layoutId)) {
    if (axis === "col") {
      if (c.col >= fromIndex && rangesOverlap(c.row, c.row + c.row_span, crossStart, crossEnd)) {
        await deps.repo.updateLayoutCell(c.id, { col: c.col + 1 });
      }
    } else if (c.row >= fromIndex && rangesOverlap(c.col, c.col + c.col_span, crossStart, crossEnd)) {
      await deps.repo.updateLayoutCell(c.id, { row: c.row + 1 });
    }
  }
}

export function registerAdminRoutes(app: H3, deps: AdminDeps): void {
  // ---- Overview -------------------------------------------------------------

  app.get("/admin/", async (event) => {
    const user = event.context.user!;
    const cameras = await deps.repo.listCameras();
    const kiosks = await deps.repo.listKiosks();
    const layouts = await deps.repo.listDisplays(); // for count
    const events = await deps.repo.recentEvents(10);
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
  app.get("/admin", async () => {
    return new Response(null, { status: 301, headers: { location: "/admin/" } });
  });

  // ---- Backup / restore -----------------------------------------------------

  app.get("/admin/backup", async (event) => {
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
      await audit(deps.repo, event as any, "backup.create", {
        result: "failed", metadata: { error: (err as Error).message },
      });
      return htmlPage(BackupPage({ user: event.context.user!.username, error: (err as Error).message }));
    }
    await audit(deps.repo, event as any, "backup.create", {
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
      await audit(deps.repo, event as any, "backup.restore", {
        metadata: { file_count: res.fileCount, files: res.files },
      });
      return htmlPage(BackupPage({
        user: event.context.user!.username,
        success: `Restored ${String(res.fileCount)} files: ${res.files.join(", ")}. RESTART THE SERVER NOW for changes to take effect.`,
      }));
    } catch (err) {
      await audit(deps.repo, event as any, "backup.restore", {
        result: "failed", metadata: { error: (err as Error).message },
      });
      return htmlPage(BackupPage({ user: event.context.user!.username, error: (err as Error).message }));
    }
  });

  // ---- Audit log ------------------------------------------------------------

  app.get("/admin/audit", async (event) => {
    const user = event.context.user!;
    const url = new URL(event.req.url);
    const filterAction = url.searchParams.get("action")?.trim() || undefined;
    const filterActorType = url.searchParams.get("actor_type")?.trim() || undefined;
    const entries = await deps.repo.listAudit({
      limit: 300,
      action_prefix: filterAction,
      actor_type: filterActorType as any || undefined,
    });
    return htmlPage(AuditLogPage({ user: user.username, entries, filterAction, filterActorType }));
  });

  // ---- System Health --------------------------------------------------------

  app.get("/admin/health", async (event) => {
    const user = event.context.user!;
    const kiosks = await deps.repo.listKiosks();
    const now = Date.now();
    let clusterKey: string | undefined;
    try {
      const enc = await deps.repo.getSetupExtra("cluster_key_encrypted") as string | undefined;
      if (enc) clusterKey = deps.secrets.decryptString(enc, "cluster");
    } catch { /* ignore */ }

    const rows = [];
    for (const k of kiosks) {
      const online = k.last_seen_at
        ? now - new Date(k.last_seen_at).getTime() < 5 * 60 * 1000
        : false;
      const displays = await deps.repo.listDisplaysForKiosk(k.id);
      let expectedBundleVersion: string | null = null;
      try {
        const b = await generateBundle(deps.repo, deps.secrets, k.id, clusterKey);
        expectedBundleVersion = b?.version ?? null;
      } catch { /* ignore */ }
      const bundleMismatch =
        expectedBundleVersion != null
        && k.last_bundle_version != null
        && k.last_bundle_version !== expectedBundleVersion;
      rows.push({
        kiosk: k,
        online,
        bundleMismatch,
        expectedBundleVersion,
        displays,
      });
    }

    return htmlPage(SystemHealthPage({ user: user.username, rows }));
  });

  // ---- Cameras --------------------------------------------------------------

  app.get("/admin/cameras", async (event) => {
    const user = event.context.user!;
    const cameras = await deps.repo.listCameras();
    const streamCounts = new Map<string, number>();
    const activeKiosks = new Map<string, number>(); // camera_id → count of kiosks rendering
    for (const cam of cameras) {
      streamCounts.set(cam.id, (await deps.repo.listCameraStreams(cam.id)).length);
      activeKiosks.set(cam.id, (await deps.repo.listKiosksRenderingCamera(cam.id)).length);
    }
    return htmlPage(CamerasPage({ user: user.username, cameras, streamCounts, activeKiosks }));
  });

  app.get("/admin/cameras/new", async (event) => {
    const user = event.context.user!;
    return htmlPage(CameraNewPage({ user: user.username }));
  });

  app.post("/admin/cameras/new", async (event) => {
    event.context.obs?.log.info("camera create by {user}", { user: event.context.user?.username ?? "unknown" });
    const user = event.context.user!;
    const body = await readBody<Record<string, string>>(event);
    const name = (body?.["name"] ?? "").trim();
    const errors: string[] = [];

    if (!name || name.length > 128) {
      errors.push("Name required (max 128 chars).");
    } else if (await deps.repo.getCameraByName(name)) {
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

    const cam = await deps.repo.createCamera({
      name,
      type: "rtsp",
      rtsp_url: rtspUrl ?? null,
    });

    if (rtspUrl) {
      await deps.repo.createCameraStream({
        camera_id: cam.id,
        role: "main",
        name: "Main",
        rtsp_uri: rtspUrl,
      });
    }
    notifyKiosks();
    deps.nodered.forward("camera.changed", { camera_id: cam.id, event: "created", source: "server" });

    return new Response(null, {
      status: 302,
      headers: { location: "/admin/cameras" },
    });
  });

  // ---- Camera ONVIF discovery ------------------------------------------------

  app.get("/admin/cameras/discover", async (event) => {
    const user = event.context.user!;
    return htmlPage(CameraDiscoverPage({
      user: user.username,
      kiosks: await deps.repo.listKiosks(),
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
        kiosks: await deps.repo.listKiosks(),
        error: "Host required.",
        values: body,
      }));
    }

    try {
      const soapTransport = runner.startsWith("kiosk:")
        ? kioskOnvifSoapTransport(runner.slice("kiosk:".length))
        : undefined;
      const result = await onvifDiscover({ host, port, username, password, soapTransport });
      return htmlPage(CameraDiscoverResultsPage({
        user: user.username,
        host,
        port,
        username,
        password,
        cameras: result.cameras,
        debug: result.debug,
      }));
    } catch (err) {
      const msg = (err as Error).message ?? "unknown error";
      return htmlPage(CameraDiscoverResultsPage({
        user: user.username,
        host,
        port,
        username,
        password,
        cameras: [],
        error: `Discovery failed: ${msg}`,
        debug: msg.includes("response preview:") ? {
          mediaUrl: msg.split("mediaUrl=")[1]?.split(" ")[0] ?? "unknown",
          deviceName: null,
          profileCount: 0,
          rawProfilesXml: msg.split("response preview: ")[1] ?? msg,
          rawCapabilitiesXml: null,
        } : undefined,
      }));
    }
  });

  app.post("/admin/cameras/discover/add", async (event) => {
    const body = await readBody<Record<string, string | string[]>>(event);
    const onvifHost = formValue(body?.["host"]).trim();
    const onvifPort = parseInt(formValue(body?.["port"]) || "80", 10) || 80;
    const username = formValue(body?.["username"]).trim();
    const password = formValue(body?.["password"]);
    let imported = 0;

    const selected = formValues(body?.["selected"]);
    if (selected.length > 0) {
      for (const idx of selected) {
        const rawName = formValue(body?.[`camera_${idx}_name`]).trim() || "ONVIF camera";
        const streams = parseDiscoveredStreams(formValue(body?.[`camera_${idx}_streams_json`]));
        if (streams.length === 0) continue;
        const camId = await importDiscoveredCamera(deps, rawName, onvifHost, onvifPort, username, password, streams);
        if (camId != null) {
          deps.nodered.forward("camera.changed", { camera_id: camId, event: "created", source: "server" });
        }
        imported += 1;
      }
    } else {
      const rawName = formValue(body?.["name"]).trim() || "ONVIF camera";
      const streams = parseDiscoveredStreams(formValue(body?.["streams_json"]));
      if (streams.length > 0) {
        const camId = await importDiscoveredCamera(deps, rawName, onvifHost, onvifPort, username, password, streams);
        if (camId != null) {
          deps.nodered.forward("camera.changed", { camera_id: camId, event: "created", source: "server" });
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

  app.get("/admin/entities", async (event) => {
    const user = event.context.user!;
    syncDashboardsFromNodered(deps).catch(() => {});
    return htmlPage(EntitiesPage({
      user: user.username,
      entities: await deps.repo.listEntities(),
    }));
  });

  app.get("/admin/entities/new", async (event) => {
    const user = event.context.user!;
    return htmlPage(EntityNewPage({
      user: user.username,
      cameras: await deps.repo.listCameras(),
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
    } else if (await deps.repo.getEntityByName(name)) {
      errors.push("Entity name already in use.");
    }
    if (type !== "camera" && type !== "html" && type !== "web") {
      errors.push("Select an entity type.");
    }

    let cameraId: string | null = null;
    let htmlContent: string | null = null;
    let webUrl: string | null = null;
    if (type === "camera") {
      cameraId = body?.["camera_id"] ? String(body["camera_id"] ?? "") : null;
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
        cameras: await deps.repo.listCameras(),
        error: errors.join(" "),
        values: body,
      }));
    }

    await deps.repo.createEntity({
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

  app.get("/admin/entities/:id", async (event) => {
    const user = event.context.user!;
    const id = (getRouterParam(event, "id") ?? "");
    const ent = await deps.repo.getEntityById(id);
    if (!ent) return new Response(null, { status: 302, headers: { location: "/admin/entities" } });
    return htmlPage(EntityEditPage({
      user: user.username,
      entity: ent,
      cameras: await deps.repo.listCameras(),
    }));
  });

  app.post("/admin/entities/:id", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const ent = await deps.repo.getEntityById(id);
    if (!ent) return new Response(null, { status: 302, headers: { location: "/admin/entities" } });
    if ((ent as any).managed) {
      return new Response(null, { status: 302, headers: { location: `/admin/entities/${String(id)}` } });
    }
    const body = await readBody<Record<string, string>>(event);
    const patch: {
      name?: string;
      description?: string | null;
      camera_id?: string | null;
      html_content?: string | null;
      web_url?: string | null;
    } = {
      name: (body?.["name"] ?? ent.name).trim(),
      description: (body?.["description"] ?? "").trim() || null,
    };
    if (ent.type === "camera") {
      patch.camera_id = body?.["camera_id"] ? String(body["camera_id"] ?? "") : null;
    } else if (ent.type === "html") {
      patch.html_content = body?.["html_content"] ?? null;
    } else if (ent.type === "web") {
      patch.web_url = (body?.["web_url"] ?? "").trim() || null;
    }
    await deps.repo.updateEntity(id, patch);
    notifyKiosks();
    return new Response(null, { status: 302, headers: { location: `/admin/entities/${String(id)}` } });
  });

  app.post("/admin/entities/:id/delete", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    await deps.repo.deleteEntity(id);
    notifyKiosks();
    return new Response(null, { status: 302, headers: { location: "/admin/entities" } });
  });

  // Camera snapshot — prefer a kiosk already rendering this camera so we don't
  // double the RTSP load on the source. Fall back to server-direct only when
  // no kiosk currently has the camera in its active layout (or every kiosk
  // attempt times out). Used by the EntityEditPage "Test" preview.
  app.get("/admin/entities/:id/snapshot", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const ent = await deps.repo.getEntityById(id);
    if (!ent || ent.type !== "camera" || ent.camera_id == null) {
      return new Response("Not a camera entity", { status: 404 });
    }
    const cameraId = ent.camera_id;

    // 1. Try kiosks that have this camera in ANY layout (bundle-level).
    // Even if the camera isn't on screen right now, the kiosk is on the
    // same LAN and can open a one-shot RTSP connection for the snapshot.
    // Only fall through to server-direct when NO kiosk has it at all.
    const candidates = await deps.repo.listKiosksWithCameraInBundle(cameraId);
    const STALE_MS = 2 * 60 * 1000; // kiosk silent > 2 min → don't bother
    const now = Date.now();
    for (const k of candidates) {
      if (!k.local_port || !k.local_key) continue;
      if (k.last_seen_at && now - new Date(k.last_seen_at).getTime() > STALE_MS) continue;
      const ip = pickKioskLanIp(k);
      if (!ip) continue;

      const url = `http://${ip}:${String(k.local_port)}/local/snapshot/${String(cameraId)}?key=${encodeURIComponent(k.local_key)}`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          return new Response(bytes, {
            status: 200,
            headers: {
              "content-type": res.headers.get("content-type") ?? "image/jpeg",
              "cache-control": "no-store",
              "x-bf-snapshot-source": `kiosk:${String(k.id)}`,
            },
          });
        }
      } catch {
        // Network error / timeout — try next kiosk.
      }
    }

    // 2. Fall back to server-direct RTSP pull (ffmpeg/gst).
    const streams = await deps.repo.listCameraStreams(cameraId);
    const main = streams.find((s) => s.role === "main") ?? streams[0];
    const cam = await deps.repo.getCameraById(cameraId);
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
        "x-bf-snapshot-source": "server",
      },
    });
  });

  // ---- Kiosks ---------------------------------------------------------------

  app.get("/admin/kiosks", async (event) => {
    const user = event.context.user!;
    const kiosks = await deps.repo.listKiosks();
    const pending = await deps.repo.listPendingPairingCodes();
    return htmlPage(KiosksPage({ user: user.username, kiosks, pendingCodes: pending }));
  });

  app.post("/admin/kiosks/pair", async (event) => {
    event.context.obs?.log.info("kiosk pair by {user}", { user: event.context.user?.username ?? "unknown" });
    const body = await readBody<Record<string, string>>(event);
    const code = (body?.["code"] ?? "").trim().toUpperCase();
    const nameOverride = (body?.["name_override"] ?? "").trim() || undefined;
    const labelsStr = (body?.["initial_labels"] ?? "").trim();
    const initialLabels = labelsStr ? labelsStr.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const replaceIdRaw = (body?.["replace_kiosk_id"] ?? "").trim();
    const replaceKioskId = replaceIdRaw && replaceIdRaw !== "0" ? replaceIdRaw : undefined;
    const force = body?.["force"] === "1";

    try {
      const result = await confirmPairing(deps.repo, deps.auth, deps.secrets, {
        code,
        nameOverride,
        initialLabels,
        replaceKioskId,
        force,
      }, event.context.obs);
      await audit(deps.repo, event as any, replaceKioskId ? "kiosk.replace" : "kiosk.pair", {
        resource_type: "kiosk",
        resource_id: result.kioskId,
        metadata: { name: result.kioskName, code, replaced: !!replaceKioskId },
      });
    } catch (err) {
      const user = event.context.user!;
      const kiosks = await deps.repo.listKiosks();
      const pending = await deps.repo.listPendingPairingCodes();
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

  app.get("/admin/layouts", async (event) => {
    const user = event.context.user!;
    const layouts = await deps.repo.listLayouts();
    // For each layout, how many displays use it (for the list view).
    const displayCounts = new Map<string, number>();
    for (const l of layouts) {
      displayCounts.set(l.id, (await deps.repo.listDisplaysForLayout(l.id)).length);
    }
    return htmlPage(LayoutsPage({ user: user.username, layouts, displayCounts }));
  });

  app.get("/admin/layouts/new", async (event) => {
    const user = event.context.user!;
    return htmlPage(LayoutNewPage({ user: user.username }));
  });

  app.post("/admin/layouts/new", async (event) => {
    event.context.obs?.log.info("layout create by {user}", { user: event.context.user?.username ?? "unknown" });
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

    const layout = await deps.repo.createLayout({
      name,
      description,
      priority,
      resets_idle_timer: resetsIdleTimer,
    });

    return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layout.id}` } });
  });

  app.get("/admin/layouts/:id", async (event) => {
    const user = event.context.user!;
    const id = (getRouterParam(event, "id") ?? "");
    const layout = await deps.repo.getLayoutById(id);
    if (!layout) return new Response(null, { status: 302, headers: { location: "/admin/layouts" } });
    const cells = await deps.repo.layoutCells(id);
    const cameras = await deps.repo.listCameras();
    const entities = await deps.repo.listEntities();
    const displays = await deps.repo.listDisplaysForLayout(id);
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
    event.context.obs?.log.info("layout update {id} by {user}", { id: getRouterParam(event, "id") ?? "?", user: event.context.user?.username ?? "unknown" });
    const id = (getRouterParam(event, "id") ?? "");
    const body = await readBody<Record<string, string>>(event);
    const coolingStr = body?.["cooling_timeout_seconds"] ?? "";
    const coolingTimeout = coolingStr.trim() === "" ? null : parseInt(coolingStr, 10);
    await deps.repo.updateLayout(id, {
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
    const layoutId = (getRouterParam(event, "id") ?? "");
    const body = await readBody<Record<string, string | number | { row: number; col: number }>>(event);

    let row = 0;
    let col = 0;

    const afterCellIdRaw = body?.["after_cell_id"];
    const direction = typeof body?.["direction"] === "string" ? (body["direction"] as string) : "";

    if (afterCellIdRaw && direction) {
      const afterId = String(afterCellIdRaw);
      const cells = await deps.repo.layoutCells(layoutId);
      const ref = cells.find((c) => c.id === afterId);
      if (!ref) {
        if (isHtmxRequest(event)) {
          const cameras = await deps.repo.listCameras();
          const entities = await deps.repo.listEntities();
          return htmlFragment(renderGrid(layoutId, cells, entities, cameras));
        }
        return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layoutId}` } });
      }
      if (direction === "right") {
        row = ref.row;
        col = ref.col + ref.col_span;
        await shiftCellsForInsertion(deps, layoutId, "col", col, row, row + 1);
      } else if (direction === "bottom") {
        row = ref.row + ref.row_span;
        col = ref.col;
        await shiftCellsForInsertion(deps, layoutId, "row", row, col, col + 1);
      } else if (direction === "left") {
        row = ref.row;
        col = Math.max(0, ref.col - 1);
        await shiftCellsForInsertion(deps, layoutId, "col", col, row, row + 1);
      } else if (direction === "above") {
        col = ref.col;
        row = Math.max(0, ref.row - 1);
        await shiftCellsForInsertion(deps, layoutId, "row", row, col, col + 1);
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

    await deps.repo.createLayoutCell({
      layout_id: layoutId,
      row,
      col,
      row_span: 1,
      col_span: 1,
      entity_id: null,
    });
    notifyKiosks();

    if (isHtmxRequest(event)) {
      const cells = await deps.repo.layoutCells(layoutId);
      const cameras = await deps.repo.listCameras();
      const entities = await deps.repo.listEntities();
      return htmlFragment(renderGrid(layoutId, cells, entities, cameras));
    }
    return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layoutId}` } });
  });

  // GET a single cell in read mode (used by htmx Cancel button in inline edit).
  app.get("/admin/layouts/:id/cells/:cellId", async (event) => {
    const layoutId = (getRouterParam(event, "id") ?? "");
    const cellId = (getRouterParam(event, "cellId") ?? "");
    const cell = await deps.repo.getLayoutCellById(cellId);
    if (!cell || cell.layout_id !== layoutId) {
      return new Response("Not Found", { status: 404 });
    }
    const cameras = await deps.repo.listCameras();
    const entities = await deps.repo.listEntities();
    return htmlFragment(renderCell(layoutId, cell, entities, cameras, "read"));
  });

  // GET a single cell in edit mode (htmx swap target for cell click).
  app.get("/admin/layouts/:id/cells/:cellId/edit", async (event) => {
    const layoutId = (getRouterParam(event, "id") ?? "");
    const cellId = (getRouterParam(event, "cellId") ?? "");
    const cell = await deps.repo.getLayoutCellById(cellId);
    if (!cell || cell.layout_id !== layoutId) {
      return new Response("Not Found", { status: 404 });
    }
    const cameras = await deps.repo.listCameras();
    const entities = await deps.repo.listEntities();
    return htmlFragment(renderCell(layoutId, cell, entities, cameras, "edit"));
  });

  // Update a cell's entity binding + dimensions. Legacy content_type/web/html
  // columns are managed by assignCellEntity for bundle compatibility.
  app.post("/admin/layouts/:id/cells/:cellId", async (event) => {
    const layoutId = (getRouterParam(event, "id") ?? "");
    const cellId = (getRouterParam(event, "cellId") ?? "");
    const body = await readBody<Record<string, string>>(event);

    const entityIdRaw = body?.["entity_id"];
    const entityId =
      entityIdRaw && String(entityIdRaw).trim() !== "" ? String(entityIdRaw) : null;
    await deps.repo.assignCellEntity(cellId, entityId != null && entityId !== "" ? entityId : null);

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
    let spansChanged = false;
    if (Object.keys(dimsPatch).length > 0) {
      await deps.repo.updateLayoutCell(cellId, dimsPatch as any);
      if ("col_span" in dimsPatch || "row_span" in dimsPatch) {
        spansChanged = true;
        const axis = "col_span" in dimsPatch ? "col" as const : "row" as const;
        await resolveOverlaps(deps, layoutId, cellId, axis);
      }
    }

    // Parse smart URL steps from the step builder form fields.
    const steps: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 50; i++) {
      const stepType = body?.[`step_${i}_type`];
      const stepValue = body?.[`step_${i}_value`];
      if (!stepType) break;
      const step: Record<string, unknown> = { type: stepType };
      if (stepType === "navigate") step["url"] = stepValue;
      else if (stepType === "fill" && stepValue?.includes("=")) {
        const eqIdx = stepValue.indexOf("=");
        step["selector"] = stepValue.slice(0, eqIdx);
        step["value"] = stepValue.slice(eqIdx + 1);
      }
      else if (stepType === "click" || stepType === "wait_for") step["selector"] = stepValue;
      else if (stepType === "wait") step["delay_ms"] = Number(stepValue) || 1000;
      else if (stepType === "javascript") step["script"] = stepValue;
      steps.push(step);
    }
    const loginDetect = (body?.["smart_url_login_detect"] ?? "").trim();
    const updatedCell = await deps.repo.getLayoutCellById(cellId);
    if (updatedCell) {
      const opts = { ...(updatedCell.options ?? {}) };
      if (steps.length > 0) {
        opts["smart_url"] = {
          steps,
          ...(loginDetect ? { login_detect_url: loginDetect } : {}),
        };
      } else {
        delete opts["smart_url"];
      }
      await deps.repo.updateLayoutCell(cellId, { options: JSON.stringify(opts) } as any);
    }

    notifyKiosks();

    if (isHtmxRequest(event)) {
      if (spansChanged) {
        const cells = await deps.repo.layoutCells(layoutId);
        const cameras = await deps.repo.listCameras();
        const entities = await deps.repo.listEntities();
        const body = String(renderGrid(layoutId, cells, entities, cameras));
        return new Response(body, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "hx-retarget": "#layout-grid",
            "hx-reswap": "innerHTML",
          },
        });
      }
      const cell = await deps.repo.getLayoutCellById(cellId);
      if (!cell) return new Response("", { headers: { "content-type": "text/html; charset=utf-8" } });
      const cameras = await deps.repo.listCameras();
      const entities = await deps.repo.listEntities();
      return htmlFragment(renderCell(layoutId, cell, entities, cameras, "read"));
    }
    return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layoutId}` } });
  });

  // Resize a cell by ±1 on row_span or col_span. Returns the grid fragment.
  app.post("/admin/layouts/:id/cells/:cellId/resize", async (event) => {
    const layoutId = (getRouterParam(event, "id") ?? "");
    const cellId = (getRouterParam(event, "cellId") ?? "");
    const body = await readBody<Record<string, string | number>>(event);
    const dim = String(body?.["dim"] ?? "");
    const delta = Number(body?.["delta"] ?? 0) || 0;
    const direction = String(body?.["direction"] ?? "");

    const cell = await deps.repo.getLayoutCellById(cellId);
    if (
      cell
      && cell.layout_id === layoutId
      && (direction === "left" || direction === "right" || direction === "above" || direction === "bottom")
    ) {
      await shiftCellsForExpansion(deps, layoutId, cellId, direction);
      notifyKiosks();
    } else if (cell && cell.layout_id === layoutId && (dim === "row_span" || dim === "col_span") && delta !== 0) {
      const current = dim === "row_span" ? cell.row_span : cell.col_span;
      const next = Math.max(1, current + delta);
      if (next !== current) {
        await deps.repo.updateLayoutCell(cellId, { [dim]: next } as any);
        await resolveOverlaps(deps, layoutId, cellId, dim === "col_span" ? "col" : "row");
        notifyKiosks();
      }
    }

    const cells = await deps.repo.layoutCells(layoutId);
    const cameras = await deps.repo.listCameras();
    const entities = await deps.repo.listEntities();
    if (isHtmxRequest(event)) {
      return htmlFragment(renderGrid(layoutId, cells, entities, cameras));
    }
    return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layoutId}` } });
  });

  // Visual editor: drag-to-move a cell to a new grid position.
  app.post("/admin/layouts/:id/cells/:cellId/move", async (event) => {
    const layoutId = (getRouterParam(event, "id") ?? "");
    const cellId = (getRouterParam(event, "cellId") ?? "");
    const body = await readBody<{ row: number; col: number }>(event);
    const row = Number(body?.row ?? 0);
    const col = Number(body?.col ?? 0);
    if (Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0) {
      await deps.repo.updateLayoutCell(cellId, { row, col } as any);
      notifyKiosks();
    }
    return { ok: true };
  });

  app.post("/admin/layouts/:id/cells/:cellId/delete", async (event) => {
    const layoutId = (getRouterParam(event, "id") ?? "");
    const cellId = (getRouterParam(event, "cellId") ?? "");
    await deps.repo.deleteLayoutCell(cellId);
    notifyKiosks();
    if (isHtmxRequest(event)) {
      const cells = await deps.repo.layoutCells(layoutId);
      const cameras = await deps.repo.listCameras();
      const entities = await deps.repo.listEntities();
      return htmlFragment(renderGrid(layoutId, cells, entities, cameras));
    }
    return new Response(null, { status: 302, headers: { location: `/admin/layouts/${layoutId}` } });
  });

  app.post("/admin/layouts/:id/clone", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const clone = await deps.repo.cloneLayout(id);
    notifyKiosks();
    return new Response(null, { status: 302, headers: { location: `/admin/layouts/${clone.id}` } });
  });

  app.post("/admin/layouts/:id/delete", async (event) => {
    event.context.obs?.log.info("layout delete {id} by {user}", { id: getRouterParam(event, "id") ?? "?", user: event.context.user?.username ?? "unknown" });
    const id = (getRouterParam(event, "id") ?? "");
    await deps.repo.deleteLayout(id);
    notifyKiosks();
    return new Response(null, { status: 302, headers: { location: "/admin/layouts" } });
  });

  // ---- Displays --------------------------------------------------------------

  app.get("/admin/displays", async (event) => {
    const user = event.context.user!;
    const displays = await deps.repo.listDisplays();
    return htmlPage(DisplaysPage({ user: user.username, displays }));
  });

  app.get("/admin/displays/:id", async (event) => {
    const user = event.context.user!;
    const id = (getRouterParam(event, "id") ?? "");
    const display = await deps.repo.getDisplayById(id);
    if (!display) return new Response(null, { status: 302, headers: { location: "/admin/displays" } });
    const attachedLayouts = await deps.repo.listLayoutsForDisplay(id);
    const attachedIds = new Set(attachedLayouts.map((l) => l.id));
    const availableLayouts = (await deps.repo.listLayouts()).filter((l) => !attachedIds.has(l.id));
    const kiosk = display.kiosk_id ? await deps.repo.getKioskById(display.kiosk_id) : null;
    return htmlPage(DisplayEditPage({
      user: user.username,
      display,
      attachedLayouts,
      availableLayouts,
      kioskName: kiosk?.name ?? null,
    }));
  });

  app.post("/admin/displays/:id", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const body = await readBody<Record<string, string>>(event);
    const defaultLayoutIdRaw = body?.["default_layout_id"];
    const defaultLayoutId = defaultLayoutIdRaw ? String(defaultLayoutIdRaw) : null;

    // Validate default_layout_id is actually attached to this display.
    let validatedDefault: string | null = defaultLayoutId;
    if (defaultLayoutId != null) {
      const attached = await deps.repo.listLayoutsForDisplay(id);
      if (!attached.some((l) => l.id === defaultLayoutId)) {
        validatedDefault = null;
      }
    }

    // width/height are no longer admin-editable — they come from the kiosk's
    // hardware report. Just update the editable fields.
    await deps.repo.updateDisplay(id, {
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
  const renderDisplayLayoutsFragment = async (displayId: string): Promise<Response> => {
    const display = await deps.repo.getDisplayById(displayId);
    const attached = await deps.repo.listLayoutsForDisplay(displayId);
    const attachedIds = new Set(attached.map((l) => l.id));
    const available = (await deps.repo.listLayouts()).filter((l) => !attachedIds.has(l.id));
    return htmlFragment(
      renderDisplayLayouts(displayId, display?.default_layout_id ?? null, attached, available)
      + renderDefaultLayoutSelect(display?.default_layout_id ?? null, attached, true),
    );
  };

  // Attach a layout to a display.
  app.post("/admin/displays/:id/layouts", async (event) => {
    const displayId = (getRouterParam(event, "id") ?? "");
    const body = await readBody<Record<string, string>>(event);
    const layoutId = body?.["layout_id"] ? String(body["layout_id"]) : null;
    if (layoutId && layoutId) {
      await deps.repo.attachLayoutToDisplay(displayId, layoutId);
      notifyKiosks();
    }
    if (isHtmxRequest(event)) {
      return await renderDisplayLayoutsFragment(displayId);
    }
    return new Response(null, { status: 302, headers: { location: `/admin/displays/${displayId}` } });
  });

  // Detach a layout from a display.
  app.post("/admin/displays/:id/layouts/:layoutId/remove", async (event) => {
    const displayId = (getRouterParam(event, "id") ?? "");
    const layoutId = (getRouterParam(event, "layoutId") ?? "");
    await deps.repo.detachLayoutFromDisplay(displayId, layoutId);
    notifyKiosks();
    if (isHtmxRequest(event)) {
      return await renderDisplayLayoutsFragment(displayId);
    }
    return new Response(null, { status: 302, headers: { location: `/admin/displays/${displayId}` } });
  });

  app.get("/admin/labels", async (event) => {
    const user = event.context.user!;
    return htmlPage(LabelsPage({ user: user.username, labels: await deps.repo.listLabels() }));
  });

  app.post("/admin/labels/new", async (event) => {
    const body = await readBody<Record<string, string>>(event);
    const name = (body?.["name"] ?? "").trim().toLowerCase();
    const color = body?.["color"] ?? null;
    if (!name || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
      return htmlPage(LabelsPage({
        user: event.context.user!.username,
        labels: await deps.repo.listLabels(),
        error: "Label name must start with letter/digit and contain only lowercase, digits, hyphens, underscores.",
      }));
    }
    await deps.repo.createLabel({ name, color });
    return new Response(null, { status: 302, headers: { location: "/admin/labels" } });
  });

  app.post("/admin/labels/:id/delete", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    await deps.repo.deleteLabel(id);
    return new Response(null, { status: 302, headers: { location: "/admin/labels" } });
  });

  // ---- Camera edit/delete/labels --------------------------------------------

  app.get("/admin/cameras/:id", async (event) => {
    const user = event.context.user!;
    const id = (getRouterParam(event, "id") ?? "");
    const camera = await deps.repo.getCameraById(id);
    if (!camera) return new Response(null, { status: 302, headers: { location: "/admin/cameras" } });

    // Build subscription list: which kiosks have this camera in any layout?
    const bundleKiosks = await deps.repo.listKiosksWithCameraInBundle(id);
    const activeKiosks = new Set((await deps.repo.listKiosksRenderingCamera(id)).map((k) => k.id));
    const subscriptions = [];
    for (const k of bundleKiosks) {
      // Find layout names that reference this camera on this kiosk's displays
      const displays = await deps.repo.listDisplaysForKiosk(k.id);
      const layoutNames: string[] = [];
      for (const d of displays) {
        const layouts = await deps.repo.listLayoutsForDisplay(d.id);
        for (const l of layouts) {
          const cells = await deps.repo.listLayoutCells(l.id);
          if (cells.some((c) => c.camera_id === id)) {
            layoutNames.push(l.name);
          }
        }
      }
      subscriptions.push({
        kiosk: k,
        layouts: layoutNames,
        active: activeKiosks.has(k.id),
      });
    }

    const eventSubscriptions = await deps.repo.listEventSubscriptions(id);

    return htmlPage(CameraEditPage({
      user: user.username,
      camera,
      labels: await deps.repo.cameraLabelIds(id),
      allLabels: await deps.repo.listLabels(),
      streams: await deps.repo.listCameraStreams(id),
      subscriptions,
      eventSubscriptions,
    }));
  });

  app.post("/admin/cameras/:id", async (event) => {
    event.context.obs?.log.info("camera update {id} by {user}", { id: getRouterParam(event, "id") ?? "?", user: event.context.user?.username ?? "unknown" });
    const id = (getRouterParam(event, "id") ?? "");
    const cam = await deps.repo.getCameraById(id);
    if (cam?.type === "cloud") {
      return new Response(null, { status: 302, headers: { location: `/admin/cameras/${id}` } });
    }
    const body = await readBody<Record<string, string>>(event);

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
    // Event routing config
    if (body?.["event_source"] != null) patch["event_source"] = body["event_source"] || "auto";
    if (body?.["event_sink"] != null) patch["event_sink"] = body["event_sink"] || "auto";
    await deps.repo.updateCamera(id, patch as any);

    // Also update main stream URI for RTSP cameras
    if (cam?.type === "rtsp" && rtspUrl) {
      const streams = await deps.repo.listCameraStreams(id);
      const mainStream = streams.find((s) => s.role === "main");
      if (mainStream) {
        await deps.repo.updateCameraStream(mainStream.id, { rtsp_uri: rtspUrl });
      } else {
        await deps.repo.createCameraStream({
          camera_id: id,
          role: "main",
          name: "Main",
          rtsp_uri: rtspUrl,
        });
      }
    }
    // Sync entity name when camera name changes.
    if (patch["name"]) {
      const ent = await deps.repo.getEntityForCamera(id);
      if (ent && ent.name !== patch["name"]) {
        await deps.repo.updateEntity(ent.id, { name: patch["name"] } as any);
      }
    }

    notifyKiosks();
    deps.nodered.forward("camera.changed", { camera_id: id, event: "updated", source: "server" });

    return new Response(null, { status: 302, headers: { location: `/admin/cameras/${id}` } });
  });

  app.post("/admin/cameras/:id/labels", async (event) => {
    const camId = (getRouterParam(event, "id") ?? "");
    const body = await readBody<Record<string, string>>(event);
    const newLabel = (body?.["new_label"] ?? "").trim().toLowerCase();
    let labelId = body?.["label_id"] ? String(body["label_id"] ?? "") : null;

    if (newLabel) {
      const label = await deps.repo.ensureLabel(newLabel);
      labelId = label.id;
    }
    if (labelId) {
      await deps.repo.attachCameraLabel(camId, labelId);
    }
    if (isHtmxRequest(event)) {
      return htmlFragment(renderCameraLabels(camId, await deps.repo.cameraLabelIds(camId), await deps.repo.listLabels()));
    }
    return new Response(null, { status: 302, headers: { location: `/admin/cameras/${camId}` } });
  });

  app.post("/admin/cameras/:id/labels/remove", async (event) => {
    const camId = (getRouterParam(event, "id") ?? "");
    const body = await readBody<Record<string, string>>(event);
    const labelId = String(body?.["label_id"] ?? "");
    await deps.repo.detachCameraLabel(camId, labelId);
    if (isHtmxRequest(event)) {
      return htmlFragment(renderCameraLabels(camId, await deps.repo.cameraLabelIds(camId), await deps.repo.listLabels()));
    }
    return new Response(null, { status: 302, headers: { location: `/admin/cameras/${camId}` } });
  });

  // Refresh supported ONVIF event topics from the camera.
  // MERGE: new topics are added to the existing list, never removed.
  app.post("/admin/cameras/:id/refresh-events", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const cam = await deps.repo.getCameraById(id);
    if (!cam || cam.type !== "onvif" || !cam.onvif_host) {
      return new Response(null, { status: 302, headers: { location: `/admin/cameras/${id}` } });
    }
    // Determine which kiosk (or server) to run the SOAP call through.
    let runner: string;
    if (cam.event_source === "server") {
      runner = "server";
    } else if (cam.event_source.startsWith("kiosk:")) {
      runner = cam.event_source;
    } else {
      // Auto: pick a kiosk that has this camera in its bundle.
      const kiosks = await deps.repo.listKiosksWithCameraInBundle(id);
      const online = kiosks.find((k) => k.last_seen_at && Date.now() - new Date(k.last_seen_at).getTime() < 120_000);
      runner = online ? `kiosk:${online.id}` : "server";
    }
    const soapTransport = runner.startsWith("kiosk:")
      ? kioskOnvifSoapTransport(runner.slice("kiosk:".length))
      : undefined;
    try {
      const discoveredTopics = await onvifGetEventProperties({
        host: cam.onvif_host,
        port: cam.onvif_port ?? 80,
        username: cam.onvif_username ?? "",
        password: cam.onvif_password ?? "",
        soapTransport,
      });
      // Merge: keep existing topics, add new ones — never remove
      const existingSet = new Set(cam.supported_event_topics);
      for (const t of discoveredTopics) existingSet.add(t);
      const merged = [...existingSet].sort();
      await deps.repo.updateCamera(id, { supported_event_topics: JSON.stringify(merged) } as any);
      // Upsert subscription rows for each discovered topic (additive only)
      for (const topic of discoveredTopics) {
        await deps.repo.upsertEventSubscription({ camera_id: id, topic, status: "inactive" });
      }
    } catch {
      // Camera offline or events not supported — leave existing topics.
    }
    return new Response(null, { status: 302, headers: { location: `/admin/cameras/${id}` } });
  });

  // Subscribe to all inactive event topics for this camera.
  app.post("/admin/cameras/:id/subscribe-events", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const cam = await deps.repo.getCameraById(id);
    if (!cam) {
      return new Response(null, { status: 302, headers: { location: `/admin/cameras/${id}` } });
    }
    await deps.repo.setAllEventSubscriptionsStatus(id, "inactive", "pending");
    return new Response(null, { status: 302, headers: { location: `/admin/cameras/${id}` } });
  });

  app.post("/admin/cameras/:id/delete", async (event) => {
    event.context.obs?.log.info("camera delete {id} by {user}", { id: getRouterParam(event, "id") ?? "?", user: event.context.user?.username ?? "unknown" });
    const id = (getRouterParam(event, "id") ?? "");
    await deps.repo.deleteCamera(id);
    notifyKiosks();
    deps.nodered.forward("camera.changed", { camera_id: id, event: "deleted", source: "server" });
    return new Response(null, { status: 302, headers: { location: "/admin/cameras" } });
  });

  // ---- Camera live event feed (htmx fragment, polled every 5s) ---------------
  const formatTimeShort = (iso: string) => {
    try { return new Date(iso).toLocaleString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "short" }); }
    catch { return iso; }
  };
  const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  app.get("/admin/cameras/:id/events", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const { events } = await deps.repo.queryEvents({
      camera_id: id,
      limit: 20,
    });
    if (events.length === 0) {
      return htmlFragment(
        `<div style="color:#999; font-size:0.85rem; padding:1rem 0">No events yet. ONVIF events appear here as the kiosk receives them.</div>`,
      );
    }
    const rows = events.map((e) => {
      let payload = "";
      try { payload = JSON.stringify(e.payload, null, 1); } catch { payload = String(e.payload); }
      return `<tr>
        <td style="font-size:0.8rem; white-space:nowrap">${formatTimeShort(e.received_at)}</td>
        <td><code style="font-size:0.75rem">${escapeHtml(e.topic)}</code></td>
        <td style="font-size:0.75rem">${escapeHtml(e.source_type)}</td>
        <td><pre style="margin:0; font-size:0.7rem; max-height:80px; overflow:auto; background:#fafafa; padding:2px 4px">${escapeHtml(payload)}</pre></td>
      </tr>`;
    }).join("");
    return htmlFragment(
      `<table><thead><tr><th>Time</th><th>Topic</th><th>Source</th><th>Payload</th></tr></thead><tbody>${rows}</tbody></table>`,
    );
  });

  // ---- Kiosk edit/delete/labels ---------------------------------------------

  app.get("/admin/kiosks/:id", async (event) => {
    const user = event.context.user!;
    const id = (getRouterParam(event, "id") ?? "");
    const kiosk = await deps.repo.getKioskById(id);
    if (!kiosk) return new Response(null, { status: 302, headers: { location: "/admin/kiosks" } });
    const kioskLabels = (await deps.repo.listKioskLabels(id)).map((kl) => ({
      label_id: kl.label_id,
      name: kl.name,
      role: kl.role,
    }));
    const displays = await deps.repo.listDisplaysForKiosk(id);
    const displayLayouts = [];
    for (const display of displays) {
      displayLayouts.push({
        display,
        layouts: await deps.repo.listLayoutsForDisplay(display.id),
      });
    }
    const gpioBindings = await deps.repo.listGpioBindings(id);
    const firmwareReleases = await deps.repo.listFirmwareReleases();
    const osReleases = await deps.repo.listOsUpdateReleases();
    const logResult = await deps.repo.queryKioskLogs({ kiosk_id: id, limit: 50 });
    return htmlPage(KioskEditPage({
      user: user.username,
      kiosk,
      labels: kioskLabels,
      allLabels: await deps.repo.listLabels(),
      displays,
      displayLayouts,
      gpioBindings,
      firmwareReleases,
      osReleases,
      kioskLogs: logResult.logs,
      kioskLogTotal: logResult.total,
    }));
  });

  // ---- GPIO bindings ----------------------------------------------------
  app.post("/admin/kiosks/:id/gpio", async (event) => {
    const kioskId = (getRouterParam(event, "id") ?? "");
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
      await deps.repo.createGpioBinding({
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

  app.post("/admin/kiosks/:id/gpio/:bindingId/delete", async (event) => {
    const kioskId = (getRouterParam(event, "id") ?? "");
    const bindingId = (getRouterParam(event, "bindingId") ?? "");
    await deps.repo.deleteGpioBinding(bindingId);
    notifyKiosks();
    if (isHtmxRequest(event)) {
      // Row is swapped via hx-target="closest tr" hx-swap="outerHTML" — empty
      // response collapses the row out of the table.
      return htmlFragment("");
    }
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${kioskId}` } });
  });

  app.post("/admin/kiosks/:id", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const body = await readBody<Record<string, string>>(event);
    const kiosk = await deps.repo.getKioskById(id);
    await deps.repo.updateKiosk(id, {
      name: body?.["name"],
      enabled: body?.["enabled"] === "1",
    } as any);
    if (kiosk?.managed_image && body?.["name"]) {
      const cfg = kiosk.managed_config_json ? JSON.parse(kiosk.managed_config_json) : {};
      const hostname = hostnameFromName(body["name"]);
      if (cfg?.hostname !== hostname) {
        await deps.repo.updateKiosk(id, {
          managed_config_json: JSON.stringify({ ...cfg, hostname }),
          managed_config_version: kiosk.managed_config_version + 1,
          managed_config_error: null,
        } as any);
      }
    }
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${id}` } });
  });

  // Managed-image device config — admin pushes hostname/timezone/network/wifi
  // for kiosks running our pre-built Pi image. Builds a ManagedConfig object,
  // encrypts the wifi PSK with the cluster key (so it can be stored at rest
  // and delivered as ciphertext that the kiosk decrypts on-device with the
  // cluster key it received at pairing), then bumps managed_config_version
  // so the next heartbeat ships it to the kiosk.
  app.post("/admin/kiosks/:id/managed-config", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const kiosk = await deps.repo.getKioskById(id);
    if (!kiosk) throw new Error("kiosk not found");
    if (!kiosk.managed_image) throw new Error("kiosk is not running a managed image");
    const body = await readBody<Record<string, string>>(event);

    const trim = (v: string | undefined) => (v ?? "").trim();
    const cfg: Record<string, unknown> = {};
    const hostname = trim(body?.["hostname"]) || hostnameFromName(kiosk.name);
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

    await deps.repo.updateKiosk(id, {
      managed_config_json: JSON.stringify(cfg),
      managed_config_version: kiosk.managed_config_version + 1,
      managed_config_error: null,
    } as any);

    await audit(deps.repo, event as any, "kiosk.managed_config.update", {
      resource_type: "kiosk",
      resource_id: String(id),
      metadata: { version: kiosk.managed_config_version + 1 },
    });

    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${id}` } });
  });

  app.post("/admin/kiosks/:id/labels", async (event) => {
    const kioskId = (getRouterParam(event, "id") ?? "");
    const body = await readBody<Record<string, string>>(event);
    const newLabel = (body?.["new_label"] ?? "").trim().toLowerCase();
    const role = (body?.["role"] ?? "consume") as "consume" | "operate";
    let labelId = body?.["label_id"] ? String(body["label_id"] ?? "") : null;

    if (newLabel) {
      const label = await deps.repo.ensureLabel(newLabel);
      labelId = label.id;
    }
    if (labelId) {
      await deps.repo.attachKioskLabel(kioskId, labelId, role);
    }
    if (isHtmxRequest(event)) {
      const kioskLabels = (await deps.repo.listKioskLabels(kioskId)).map((kl) => ({
        label_id: kl.label_id,
        name: kl.name,
        role: kl.role,
      }));
      return htmlFragment(renderKioskLabels(kioskId, kioskLabels, await deps.repo.listLabels()));
    }
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${kioskId}` } });
  });

  app.post("/admin/kiosks/:id/labels/remove", async (event) => {
    const kioskId = (getRouterParam(event, "id") ?? "");
    const body = await readBody<Record<string, string>>(event);
    const labelId = String(body?.["label_id"] ?? "");
    await deps.repo.detachKioskLabel(kioskId, labelId);
    if (isHtmxRequest(event)) {
      const kioskLabels = (await deps.repo.listKioskLabels(kioskId)).map((kl) => ({
        label_id: kl.label_id,
        name: kl.name,
        role: kl.role,
      }));
      return htmlFragment(renderKioskLabels(kioskId, kioskLabels, await deps.repo.listLabels()));
    }
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${kioskId}` } });
  });

  app.post("/admin/kiosks/:id/delete", async (event) => {
    event.context.obs?.log.info("kiosk delete {id} by {user}", { id: getRouterParam(event, "id") ?? "?", user: event.context.user?.username ?? "unknown" });
    const id = (getRouterParam(event, "id") ?? "");
    await deps.repo.deleteKiosk(id);
    return new Response(null, { status: 302, headers: { location: "/admin/kiosks" } });
  });

  // ---- Kiosk debug (journal + terminal) pages ----------------------------
  // These are simple HTML pages that connect to the admin debug WS at
  // /ws/admin/debug/:kioskId and render output. The WS connection is
  // authenticated via the admin's API key.
  app.get("/admin/kiosks/:id/logs", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const kiosk = await deps.repo.getKioskById(id);
    if (!kiosk) return new Response(null, { status: 302, headers: { location: "/admin/kiosks" } });
    if (kiosk.firmware_channel !== "dev" && kiosk.os_update_channel !== "dev") {
      return htmlPage(`<html><body style="font-family:sans-serif;padding:2rem"><h2>Journal Logs Unavailable</h2><p>Remote debug requires firmware channel set to <strong>dev</strong>. Current channel: <strong>${kiosk.firmware_channel}</strong></p><a href="/admin/kiosks/${String(id)}">Back to kiosk</a></body></html>`);
    }
    const user = event.context.user!;
    // Get or create an API key for the WS connection.
    // WS auth: browser sends session cookie automatically on WS upgrade.
    // Coordinator WS endpoint validates via resolveSession.
    return htmlPage(`<html><head><title>Logs: ${kiosk.name}</title>
      <style>body{margin:0;background:#111;color:#0f0;font-family:monospace;font-size:13px;padding:1rem}
      pre{white-space:pre-wrap;word-break:break-all}
      .controls{margin-bottom:1rem}
      button{background:#333;color:#fff;border:1px solid #555;padding:4px 12px;cursor:pointer;margin-right:8px}
      </style></head><body>
      <div class="controls">
        <a href="/admin/kiosks/${id}" style="color:#0f0">← ${kiosk.name}</a>
        <button id="btn-start">Start streaming</button>
        <button id="btn-stop">Stop</button>
        <button id="btn-clear">Clear</button>
      </div>
      <pre id="log"></pre>
      <script>
      (function(){
        var log=document.getElementById('log');
        var ws;
        function connect(){
          // WS to coordinator — proxied through Angie at /ws/admin/debug/:id
          var proto=location.protocol==='https:'?'wss:':'ws:';
          ws=new WebSocket(proto+'//'+location.host+'/admin/ws/debug/${id}');
          ws.onmessage=function(e){
            try{var m=JSON.parse(e.data);
              if(m.type==='journal-line'){log.textContent+=m.line+'\\n';log.scrollTop=log.scrollHeight;}
            }catch{}
          };
          ws.onclose=function(){setTimeout(connect,3000)};
        }
        document.getElementById('btn-start').onclick=function(){
          if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'journal-start'}));
        };
        document.getElementById('btn-stop').onclick=function(){
          if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'journal-stop'}));
        };
        document.getElementById('btn-clear').onclick=function(){log.textContent='';};
        connect();
      })();
      </script></body></html>`);
  });

  app.get("/admin/kiosks/:id/terminal", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const kiosk = await deps.repo.getKioskById(id);
    if (!kiosk) return new Response(null, { status: 302, headers: { location: "/admin/kiosks" } });
    if (kiosk.firmware_channel !== "dev" && kiosk.os_update_channel !== "dev") {
      return htmlPage(`<html><body style="font-family:sans-serif;padding:2rem"><h2>Terminal Unavailable</h2><p>Remote terminal requires firmware channel set to <strong>dev</strong>. Current channel: <strong>${kiosk.firmware_channel}</strong></p><a href="/admin/kiosks/${String(id)}">Back to kiosk</a></body></html>`);
    }
    // WS auth: browser sends session cookie automatically on WS upgrade.
    // Coordinator WS endpoint validates via resolveSession.
    return htmlPage(`<html><head><title>Terminal: ${kiosk.name}</title>
      <style>
        body{margin:0;background:#1a1a1a;color:#e0e0e0;font-family:'Cascadia Code','Fira Code',monospace;font-size:13px;padding:1rem}
        #term{height:calc(100vh - 100px);overflow-y:auto;background:#0d0d0d;padding:12px;border:1px solid #333;border-radius:4px}
        .line{margin:0;white-space:pre-wrap;word-break:break-all;line-height:1.5}
        .prompt{color:#5faf5f}
        .cmd{color:#fff}
        .output{color:#b0b0b0}
        .controls{margin-bottom:0.75rem;display:flex;gap:8px;align-items:center}
        button{background:#333;color:#fff;border:1px solid #555;padding:4px 12px;cursor:pointer;border-radius:3px}
        button:hover{background:#444}
        input{background:#222;color:#fff;border:1px solid #555;padding:4px 8px;font-family:inherit;border-radius:3px}
        #code-input{width:180px}
        .status{color:#666;font-size:11px;margin-left:12px}
        .cmd-line{display:flex;align-items:center;margin-top:4px;background:#0d0d0d;border:1px solid #333;border-radius:4px;padding:4px 8px}
        .cmd-line .prompt-label{color:#5faf5f;margin-right:8px;white-space:nowrap}
        .cmd-line input{flex:1;background:transparent;border:none;color:#fff;outline:none;font-family:inherit;font-size:13px;padding:2px 0}
      </style></head><body>
      <div class="controls">
        <a href="/admin/kiosks/${id}" style="color:#5fafff;text-decoration:none">← ${kiosk.name}</a>
        <button id="btn-request">Request Terminal</button>
        <input id="code-input" placeholder="Enter code from screen" style="display:none" />
        <button id="btn-auth" style="display:none">Auth</button>
        <span class="status" id="status">Disconnected</span>
      </div>
      <div id="term"></div>
      <div class="cmd-line" id="cmd-row" style="display:none">
        <span class="prompt-label" id="prompt-label">$</span>
        <input id="cmd-input" placeholder="" autofocus />
      </div>
      <script>
      (function(){
        var term=document.getElementById('term'),status=document.getElementById('status');
        var codeInput=document.getElementById('code-input'),authBtn=document.getElementById('btn-auth');
        var cmdInput=document.getElementById('cmd-input'),cmdRow=document.getElementById('cmd-row');
        var promptLabel=document.getElementById('prompt-label');
        var ws,cwd='~',outputBuf='';

        function appendOutput(){
          if(!outputBuf)return;
          var div=document.createElement('div');
          div.className='line output';
          div.textContent=outputBuf;
          term.appendChild(div);
          outputBuf='';
          term.scrollTop=term.scrollHeight;
        }

        function appendCmd(cmd){
          appendOutput();
          var div=document.createElement('div');
          div.className='line';
          var p=document.createElement('span');
          p.className='prompt';
          p.textContent=cwd+'$ ';
          var c=document.createElement('span');
          c.className='cmd';
          c.textContent=cmd;
          div.appendChild(p);
          div.appendChild(c);
          term.appendChild(div);
          term.scrollTop=term.scrollHeight;
        }

        function connect(){
          var proto=location.protocol==='https:'?'wss:':'ws:';
          ws=new WebSocket(proto+'//'+location.host+'/admin/ws/debug/${id}');
          ws.onopen=function(){status.textContent='Connected';};
          ws.onmessage=function(e){
            try{var m=JSON.parse(e.data);
              if(m.type==='terminal-challenge'){
                status.textContent='Enter code from kiosk screen';
                codeInput.style.display='';authBtn.style.display='';codeInput.focus();
              }else if(m.type==='terminal-granted'){
                status.textContent='Terminal active';
                codeInput.style.display='none';authBtn.style.display='none';
                cmdRow.style.display='flex';cmdInput.focus();
                // Get initial pwd
                ws.send(JSON.stringify({type:'terminal-data',data:btoa('pwd\\n')}));
              }else if(m.type==='terminal-denied'){
                status.textContent='Denied: '+(m.reason||'unknown');
              }else if(m.type==='terminal-data'){
                var bytes=atob(m.data);
                outputBuf+=bytes;
                // Try to detect pwd from output (last non-empty line after command)
                var lines=outputBuf.split('\\n');
                for(var i=lines.length-1;i>=0;i--){
                  var l=lines[i].trim();
                  if(l&&l.startsWith('/')){cwd=l.replace(/^\\/home\\/bfkiosk/,'~');break;}
                }
                // Flush to display
                appendOutput();
                promptLabel.textContent=cwd+'$ ';
              }
            }catch{}
          };
          ws.onclose=function(){status.textContent='Disconnected';setTimeout(connect,3000)};
        }
        document.getElementById('btn-request').onclick=function(){
          if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'terminal-request'}));
          status.textContent='Requesting...';
        };
        authBtn.onclick=function(){
          if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'terminal-auth',code:codeInput.value.toUpperCase()}));
        };
        codeInput.onkeydown=function(e){
          if(e.key==='Enter')authBtn.click();
        };
        cmdInput.onkeydown=function(e){
          if(e.key==='Enter'&&cmdInput.value){
            var cmd=cmdInput.value;
            appendCmd(cmd);
            ws.send(JSON.stringify({type:'terminal-data',data:btoa(cmd+'\\n')}));
            // After each command, get pwd for prompt update
            setTimeout(function(){
              ws.send(JSON.stringify({type:'terminal-data',data:btoa('pwd\\n')}));
            },200);
            cmdInput.value='';
          }
        };
        connect();
      })();
      </script></body></html>`);
  });

  // ---- Layout switch ----------------------------------------------------
  const emitLayoutChanged = async (displayId: string | null, kioskId: string | null, layoutId: string) => {
    const layout = await deps.repo.getLayoutById(layoutId);
    deps.nodered.forward("layout.changed", {
      display_id: displayId,
      kiosk_id: kioskId,
      layout_id: layoutId,
      layout_name: layout?.name ?? null,
      source: "server",
    });
  };

  const displayLayoutSwitch = async (event: any) => {
    const displayId = (getRouterParam(event, "displayId") ?? "");
    let layoutId = getRouterParam(event, "layoutId") ?? "";
    if (!layoutId) {
      const body = await readBody<Record<string, string>>(event);
      layoutId = String(body?.["layout_id"] ?? "");
    }
    if (displayId && layoutId) {
      const display = await deps.repo.getDisplayById(displayId);
      const attached = await deps.repo.listLayoutsForDisplay(displayId);
      const isAttached = attached.some((l) => l.id === layoutId);
      if (display?.kiosk_id && isAttached) {
        getCoordinator().sendToKiosk(display.kiosk_id, {
          type: "layout-switch",
          display_id: displayId,
          layout_id: layoutId,
        });
        await emitLayoutChanged(displayId, display.kiosk_id, layoutId);
      }
    }
    return new Response(null, { status: 302, headers: { location: `/admin/displays/${displayId}` } });
  };
  app.post("/admin/displays/:displayId/layout", displayLayoutSwitch);
  app.post("/admin/displays/:displayId/layout/:layoutId", displayLayoutSwitch);
  app.get("/admin/displays/:displayId/layout/:layoutId", displayLayoutSwitch);

  const displayPower = async (event: any, state: "on" | "standby") => {
    const id = (getRouterParam(event, "id") ?? "");
    const display = await deps.repo.getDisplayById(id);
    if (display?.kiosk_id) {
      getCoordinator().sendToKiosk(display.kiosk_id, {
        type: state === "on" ? "wake" : "standby",
        display_id: id,
      });
      await deps.repo.updateDisplay(id, {
        actual_power_state: state === "on" ? "awake" : "standby",
        actual_power_state_at: new Date().toISOString(),
      } as any);
      deps.nodered.forward("display.power.changed", {
        display_id: id,
        kiosk_id: display.kiosk_id,
        state,
        source: "server",
      });
    }
    return new Response(null, { status: 302, headers: { location: `/admin/displays/${id}` } });
  };
  app.post("/admin/displays/:id/power/standby", (event) => displayPower(event, "standby"));
  app.post("/admin/displays/:id/power/wake", (event) => displayPower(event, "on"));

  // Node-RED embedded page
  app.get("/admin/nodered", async (event) => {
    const user = event.context.user!;
    return htmlPage(NoderedEmbedPage({ user: user.username }));
  });

  // ---- CEC power commands -----------------------------------------------
  const emitDisplayPower = async (kioskId: string, state: "on" | "standby") => {
    const displays = await deps.repo.listDisplaysForKiosk(kioskId);
    const displayId = displays[0]?.id ?? null;
    const actual = state === "on" ? "awake" : "standby";
    const at = new Date().toISOString();
    for (const display of displays) {
      await deps.repo.updateDisplay(display.id, {
        actual_power_state: actual,
        actual_power_state_at: at,
      } as any);
    }
    deps.nodered.forward("display.power.changed", {
      display_id: displayId,
      kiosk_id: kioskId,
      state,
      source: "server",
    });
  };

  app.post("/admin/kiosks/:id/power/standby", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    getCoordinator().sendToKiosk(id, { type: "standby" });
    await emitDisplayPower(id, "standby");
    await audit(deps.repo, event as any, "display.standby", { resource_type: "kiosk", resource_id: id });
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${id}` } });
  });

  app.post("/admin/kiosks/:id/power/wake", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    getCoordinator().sendToKiosk(id, { type: "wake" });
    await emitDisplayPower(id, "on");
    await audit(deps.repo, event as any, "display.wake", { resource_type: "kiosk", resource_id: id });
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${id}` } });
  });

  // ---- Fan control ------------------------------------------------------
  app.post("/admin/kiosks/:id/fan", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
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

  app.post("/admin/kiosks/:id/tailscale", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const body = await readBody<Record<string, string>>(event);
    const authKey = (body?.["auth_key"] ?? "").trim();
    if (authKey) {
      getCoordinator().sendToKiosk(id, { type: "tailscale-auth", auth_key: authKey });
    }
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${id}` } });
  });

  app.post("/admin/kiosks/:id/reboot", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    getCoordinator().sendToKiosk(id, { type: "reboot" });
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${id}` } });
  });

  app.post("/admin/kiosks/:id/volume", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const body = await readBody<Record<string, string>>(event);
    const action = body?.["action"];
    if (action === "mute") {
      getCoordinator().sendToKiosk(id, { type: "volume-mute", muted: true });
    } else if (action === "unmute") {
      getCoordinator().sendToKiosk(id, { type: "volume-mute", muted: false });
    } else if (action === "output") {
      getCoordinator().sendToKiosk(id, { type: "audio-output", output_id: body?.["output_id"] ?? "" });
    } else {
      const vol = Math.max(0, Math.min(100, Number(body?.["volume"]) || 0));
      getCoordinator().sendToKiosk(id, { type: "volume-set", volume: vol });
    }
    return new Response(null, { status: 302, headers: { location: `/admin/kiosks/${id}` } });
  });

  // ---- Settings page ----------------------------------------------------------

  app.get("/admin/settings", async () => {
    const cloudAccounts = await deps.repo.listCloudAccounts();
    const ablesignAccounts = await deps.repo.listAbleSignAccounts();
    return htmlPage(SettingsPage({ cloudAccounts, ablesignAccounts }));
  });

  // ---- Tenant switcher fragment (htmx) ----------------------------------------
  app.get("/admin/_tenant_switcher", async (event) => {
    const tenants = await deps.repo.listTenants();
    if (tenants.length <= 1) return new Response("", { headers: { "content-type": "text/html" } });
    const current = (event.context as any).tenant?.slug ?? "default";
    const options = tenants.map((t: any) =>
      `<option value="${t.slug as string}"${t.slug === current ? " selected" : ""}>${t.name as string}</option>`
    ).join("");
    const html = `<form method="post" action="/admin/tenants/switch" style="padding:0.5rem 1rem">
      <label style="font-size:0.75rem; color:#888; display:block; margin-bottom:0.25rem">Tenant</label>
      <select name="tenant_slug" style="width:100%; font-size:0.8rem; padding:0.25rem" onchange="this.form.submit()">${options}</select>
    </form>`;
    return new Response(html, { headers: { "content-type": "text/html" } });
  });

  // ---- JSON API (admin scope) — used by Node-RED bf-* nodes ---------------
  //
  // All payloads run through `stripSecrets` so credential-bearing fields
  // (key_hash, onvif_password, totp_secret_encrypted, etc.) never leak to
  // automation clients. List shapes are kept thin (id/name/type/enabled +
  // labels where useful); detail shapes return the full row minus secrets.

  app.get("/api/admin/cameras", async (_event) => {
    const cameras = await deps.repo.listCameras();
    const payload = [];
    for (const c of cameras) {
      payload.push({
        id: c.id,
        name: c.name,
        type: c.type,
        enabled: c.enabled,
        labels: await deps.repo.cameraLabelNames(c.id),
      });
    }
    return jsonResponse({ cameras: payload });
  });

  app.get("/api/admin/cameras/:id", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const cam = await deps.repo.getCameraById(id);
    if (!cam) return jsonResponse({ error: "not_found" }, 404);
    const streams = await deps.repo.listCameraStreams(id);
    return jsonResponse({
      camera: { ...cam, labels: await deps.repo.cameraLabelNames(id), streams },
    });
  });

  app.get("/api/admin/displays", async (_event) => {
    const displays = await deps.repo.listDisplays();
    return jsonResponse({ displays });
  });

  app.get("/api/admin/displays/:id", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const display = await deps.repo.getDisplayById(id);
    if (!display) return jsonResponse({ error: "not_found" }, 404);
    const attachedLayouts = await deps.repo.listLayoutsForDisplay(id);
    return jsonResponse({ display: { ...display, attached_layouts: attachedLayouts } });
  });

  app.get("/api/admin/kiosks", async (_event) => {
    const kiosks = await deps.repo.listKiosks();
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

  app.get("/api/admin/kiosks/:id", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const kiosk = await deps.repo.getKioskById(id);
    if (!kiosk) return jsonResponse({ error: "not_found" }, 404);
    const displays = await deps.repo.listDisplaysForKiosk(id);
    const labels = (await deps.repo.listKioskLabels(id)).map((kl) => ({
      label_id: kl.label_id,
      name: kl.name,
      role: kl.role,
    }));
    return jsonResponse({ kiosk: { ...kiosk, displays, labels } });
  });

  app.get("/api/admin/layouts", async (_event) => {
    const layouts = await deps.repo.listLayouts();
    return jsonResponse({ layouts });
  });

  app.get("/api/admin/layouts/:id", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const layout = await deps.repo.getLayoutById(id);
    if (!layout) return jsonResponse({ error: "not_found" }, 404);
    const cells = await deps.repo.layoutCells(id);
    const displays = await deps.repo.listDisplaysForLayout(id);
    return jsonResponse({ layout: { ...layout, cells, displays } });
  });

  app.get("/api/admin/entities", async (_event) => {
    const entities = await deps.repo.listEntities();
    return jsonResponse({ entities });
  });

  app.get("/api/admin/entities/:id", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const entity = await deps.repo.getEntityById(id);
    if (!entity) return jsonResponse({ error: "not_found" }, 404);
    return jsonResponse({ entity });
  });

  // ---- JSON mutation API — used by Node-RED bf-config-set node ------------
  //
  // Body shape: { value: <new value> } — keeps the wire format uniform
  // across all set ops. Returns the post-mutation entity.

  app.post("/api/admin/displays/:id/default-layout", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const body = (await readBody<Record<string, unknown>>(event)) ?? {};
    const raw = body["value"] ?? body["default_layout_id"];
    const layoutId = raw == null || raw === "" ? null : String(raw);
    if (raw != null && raw !== "" && !layoutId) {
      return jsonResponse({ error: "invalid_value" }, 400);
    }
    if (layoutId != null) {
      const attached = await deps.repo.listLayoutsForDisplay(id);
      if (!attached.some((l) => l.id === layoutId)) {
        return jsonResponse({ error: "layout_not_attached" }, 400);
      }
    }
    await deps.repo.updateDisplay(id, { default_layout_id: layoutId } as any);
    notifyKiosks();
    const display = await deps.repo.getDisplayById(id);
    return jsonResponse({ display });
  });

  app.post("/api/admin/kiosks/:id/enabled", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const body = (await readBody<Record<string, unknown>>(event)) ?? {};
    const enabled = Boolean(body["value"] ?? body["enabled"]);
    await deps.repo.updateKiosk(id, { enabled } as any);
    const kiosk = await deps.repo.getKioskById(id);
    if (!kiosk) return jsonResponse({ error: "not_found" }, 404);
    return jsonResponse({ kiosk });
  });

  app.post("/api/admin/cameras/:id/enabled", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const body = (await readBody<Record<string, unknown>>(event)) ?? {};
    const enabled = Boolean(body["value"] ?? body["enabled"]);
    await deps.repo.updateCamera(id, { enabled } as any);
    notifyKiosks();
    deps.nodered.forward("camera.changed", { camera_id: id, event: "updated", source: "server" });
    const camera = await deps.repo.getCameraById(id);
    if (!camera) return jsonResponse({ error: "not_found" }, 404);
    return jsonResponse({ camera });
  });

  app.post("/api/admin/layouts/:id/priority", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const body = (await readBody<Record<string, unknown>>(event)) ?? {};
    const value = String(body["value"] ?? body["priority"] ?? "").toLowerCase();
    if (value !== "hot" && value !== "normal" && value !== "cold") {
      return jsonResponse({ error: "invalid_priority" }, 400);
    }
    await deps.repo.updateLayout(id, { priority: value } as any);
    notifyKiosks();
    const layout = await deps.repo.getLayoutById(id);
    if (!layout) return jsonResponse({ error: "not_found" }, 404);
    return jsonResponse({ layout });
  });

  app.post("/api/admin/entities/:id/name", async (event) => {
    const id = (getRouterParam(event, "id") ?? "");
    const body = (await readBody<Record<string, unknown>>(event)) ?? {};
    const name = String(body["value"] ?? body["name"] ?? "").trim();
    if (!name || name.length > 128) {
      return jsonResponse({ error: "invalid_name" }, 400);
    }
    const existing = await deps.repo.getEntityByName(name);
    if (existing && existing.id !== id) {
      return jsonResponse({ error: "name_in_use" }, 400);
    }
    await deps.repo.updateEntity(id, { name });
    notifyKiosks();
    const entity = await deps.repo.getEntityById(id);
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
    const existing = await deps.repo.getEntityForDashboard(tab.id);
    if (existing) {
      if (existing.name !== tab.name) {
        // Avoid name collisions with non-dashboard entities of the same name.
        const collision = await deps.repo.getEntityByName(tab.name);
        const safeName = collision && collision.id !== existing.id
          ? `${tab.name} (dash ${tab.id.slice(0, 6)})`
          : tab.name;
        await deps.repo.updateEntity(existing.id, { name: safeName });
        updated += 1;
      }
      continue;
    }
    // New dashboard tab — insert.
    let name = tab.name || `Dashboard ${tab.id.slice(0, 6)}`;
    if (await deps.repo.getEntityByName(name)) {
      name = `${name} (dash ${tab.id.slice(0, 6)})`;
    }
    await deps.repo.createEntity({
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
