/**
 * Bundle generation — display-chain routing.
 *
 * kiosk.display_id → layouts for display → cells → cameras
 * No label filtering for v0.1.
 */
import { createHash } from "node:crypto";
import type { Repository } from "../plugins/service-store/repository.js";
import type { SecretsApi } from "./secrets.js";

export interface BundleCamera {
  id: number;
  name: string;
  type: string;
  rtsp_url: string | null;
  onvif_host: string | null;
  onvif_port: number | null;
  onvif_username: string | null;
  onvif_password_encrypted: string | null;
  event_source: string;
  event_sink: string;
  stream_policy: string;
  streams: Array<{
    id: number;
    role: string;
    name: string;
    rtsp_uri: string;
    width: number | null;
    height: number | null;
    encoding: string | null;
    framerate: number | null;
  }>;
}

export interface BundleCell {
  row: number;
  col: number;
  row_span: number;
  col_span: number;
  content_type: string;
  camera_id: number | null;
  stream_selector: string | null;
  web_url: string | null;
  html_content: string | null;
  cooling_timeout_seconds: number | null;
  fit: "cover" | "contain" | "fill";
}

export interface BundleLayout {
  id: number;
  name: string;
  /** Computed from cells: max(col + col_span). 1 if no cells. */
  grid_cols: number;
  /** Computed from cells: max(row + row_span). 1 if no cells. */
  grid_rows: number;
  priority: string;
  cooling_timeout_seconds: number | null;
  preload_camera_ids: number[];
  resets_idle_timer: boolean;
  /** True if the kiosk's display has this layout as its default_layout_id. */
  is_default: boolean;
  cells: BundleCell[];
}

export interface BundleDisplay {
  id: number;
  name: string;
  width_px: number;
  height_px: number;
  idle_timeout_seconds: number;
  sleep_timeout_seconds: number;
  default_layout_id: number | null;
}

export interface BundleDisplayWithLayouts extends BundleDisplay {
  layouts: BundleLayout[];
}

export interface BundleGpioBinding {
  id: number;
  chip: string;
  pin: number;
  direction: "in" | "out";
  pull: "up" | "down" | "none" | null;
  edge: "rising" | "falling" | "both" | null;
  topic: string;
}

export interface KioskBundle {
  kiosk_id: number;
  kiosk_name: string;
  /**
   * @deprecated Use `displays` (array). Kept for backward compat with older
   * kiosk builds that consume a single display. Mirrors `displays[0]`.
   */
  display: BundleDisplay;
  /**
   * @deprecated Use `displays[N].layouts`. Mirrors `displays[0].layouts` for
   * older kiosk builds.
   */
  layouts: BundleLayout[];
  /** All physical displays driven by this kiosk. New (multi-display) shape. */
  displays: BundleDisplayWithLayouts[];
  cameras: BundleCamera[];
  gpio_bindings: BundleGpioBinding[];
  version: string;
}

export function generateBundle(
  repo: Repository,
  secrets: SecretsApi,
  kioskId: number,
  clusterKey: string | undefined,
): KioskBundle | null {
  const kiosk = repo.getKioskById(kioskId);
  if (!kiosk) return null;

  // Find all displays for this kiosk (displays now point to kiosks via kiosk_id)
  const kioskDisplays = repo.listDisplaysForKiosk(kioskId);
  // Fall back to legacy kiosk.display_id if no displays point to this kiosk yet
  const allDisplays = kioskDisplays.length > 0
    ? kioskDisplays
    : (kiosk.display_id ? [repo.getDisplayById(kiosk.display_id)].filter((d): d is NonNullable<typeof d> => d != null) : []);

  // Admin can disable a display — kiosk must never open a window on it.
  const displays = allDisplays.filter((d) => d.is_enabled);
  if (displays.length === 0) return null;

  // Collect camera IDs across ALL displays' layouts (de-duped).
  const allLayoutIds = new Set<number>();
  for (const d of displays) {
    for (const l of repo.layoutsForDisplayId(d.id)) allLayoutIds.add(l.id);
  }
  const cameras = repo.camerasForLayoutIds([...allLayoutIds]);

  function buildLayouts(displayId: number, defaultLayoutId: number | null): BundleLayout[] {
    const layouts = repo.layoutsForDisplayId(displayId);
    return layouts.map((l) => {
      const cells = repo.layoutCells(l.id);
      let gridCols = 1;
      let gridRows = 1;
      for (const c of cells) {
        const right = c.col + c.col_span;
        const bottom = c.row + c.row_span;
        if (right > gridCols) gridCols = right;
        if (bottom > gridRows) gridRows = bottom;
      }
      return {
        id: l.id,
        name: l.name,
        grid_cols: gridCols,
        grid_rows: gridRows,
        priority: l.priority,
        cooling_timeout_seconds: l.cooling_timeout_seconds,
        preload_camera_ids: l.preload_camera_ids,
        resets_idle_timer: l.resets_idle_timer,
        is_default: defaultLayoutId === l.id,
        cells: cells.map((c) => {
          // If the cell has an entity, prefer its current content so admin
          // edits to the entity propagate without forcing a cell-touch. The
          // bundle still ships the legacy camera_id/web_url/html_content shape
          // so the existing Rust kiosk consumes it unchanged.
          let contentType = c.content_type;
          let cameraId = c.camera_id;
          let webUrl = c.web_url;
          let htmlContent = c.html_content;
          if (c.entity_id != null) {
            const ent = repo.getEntityById(c.entity_id);
            if (ent) {
              // Dashboard entities are surfaced to the kiosk as `web` cells
              // pointing at /dash/<dashboard_id> — kiosk WebKit handles them
              // identically to user-supplied web cells.
              contentType = ent.type === "dashboard" ? "web" : ent.type;
              cameraId = ent.type === "camera" ? ent.camera_id : null;
              webUrl =
                ent.type === "web" ? ent.web_url :
                ent.type === "dashboard" && ent.dashboard_id ? `/dash/${ent.dashboard_id}` :
                null;
              htmlContent = ent.type === "html" ? ent.html_content : null;
            }
          }
          return {
            row: c.row,
            col: c.col,
            row_span: c.row_span,
            col_span: c.col_span,
            content_type: contentType,
            camera_id: cameraId,
            stream_selector: c.stream_selector,
            web_url: webUrl,
            html_content: htmlContent,
            cooling_timeout_seconds: c.cooling_timeout_seconds,
            fit: c.fit,
          };
        }),
      };
    });
  }

  const bundleDisplays: BundleDisplayWithLayouts[] = displays.map((display) => ({
    id: display.id,
    name: display.name,
    width_px: display.width_px,
    height_px: display.height_px,
    idle_timeout_seconds: display.idle_timeout_seconds,
    sleep_timeout_seconds: display.sleep_timeout_seconds,
    default_layout_id: display.default_layout_id,
    layouts: buildLayouts(display.id, display.default_layout_id),
  }));

  const bundleCameras: BundleCamera[] = cameras.map((cam) => {
    const streams = repo.listCameraStreams(cam.id);
    const effectiveStreams = streams.length > 0 ? streams : (
      cam.type === "rtsp" && cam.rtsp_url
        ? [{
          id: 0,
          role: "main" as const,
          name: "Main",
          rtsp_uri: cam.rtsp_url,
          width: null,
          height: null,
          encoding: null,
          framerate: null,
        }]
        : []
    );
    let onvifPwEncrypted: string | null = null;
    if (cam.onvif_password && clusterKey) {
      onvifPwEncrypted = secrets.encryptForCluster(cam.onvif_password, clusterKey);
    }
    return {
      id: cam.id,
      name: cam.name,
      type: cam.type,
      rtsp_url: cam.rtsp_url,
      onvif_host: cam.onvif_host,
      onvif_port: cam.onvif_port,
      onvif_username: cam.onvif_username,
      onvif_password_encrypted: onvifPwEncrypted,
      event_source: cam.event_source,
      event_sink: cam.event_sink,
      stream_policy: cam.stream_policy,
      streams: effectiveStreams.map((s) => ({
        id: s.id,
        role: s.role,
        name: s.name,
        rtsp_uri: s.rtsp_uri,
        width: s.width,
        height: s.height,
        encoding: s.encoding,
        framerate: s.framerate,
      })),
    };
  });

  const gpioBindings: BundleGpioBinding[] = repo.listGpioBindings(kioskId).map((g) => ({
    id: g.id,
    chip: g.chip,
    pin: g.pin,
    direction: g.direction,
    pull: g.pull,
    edge: g.edge,
    topic: g.topic,
  }));

  // Mirror first display into the legacy top-level `display` + `layouts` so
  // older kiosk builds keep working unchanged. New builds should read
  // `displays`.
  const primary = bundleDisplays[0]!;
  const bundle: KioskBundle = {
    kiosk_id: kioskId,
    kiosk_name: kiosk.name,
    display: {
      id: primary.id,
      name: primary.name,
      width_px: primary.width_px,
      height_px: primary.height_px,
      idle_timeout_seconds: primary.idle_timeout_seconds,
      sleep_timeout_seconds: primary.sleep_timeout_seconds,
      default_layout_id: primary.default_layout_id,
    },
    layouts: primary.layouts,
    displays: bundleDisplays,
    cameras: bundleCameras,
    gpio_bindings: gpioBindings,
    version: "",
  };

  bundle.version = createHash("sha256")
    .update(JSON.stringify(bundle))
    .digest("hex");

  return bundle;
}
