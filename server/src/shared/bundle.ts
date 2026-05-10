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
  region_name: string;
  content_type: string;
  camera_id: number | null;
  stream_selector: string | null;
  web_url: string | null;
  html_content: string | null;
  cooling_timeout_seconds: number | null;
}

export interface BundleLayout {
  id: number;
  name: string;
  template: {
    id: number;
    name: string;
    regions: unknown;
    grid_cols: number;
    grid_rows: number;
  } | null;
  priority: string;
  cooling_timeout_seconds: number | null;
  preload_camera_ids: number[];
  is_default: boolean;
  resets_idle_timer: boolean;
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

export interface KioskBundle {
  kiosk_id: number;
  kiosk_name: string;
  display: BundleDisplay;
  layouts: BundleLayout[];
  cameras: BundleCamera[];
  version: string;
}

export function generateBundle(
  repo: Repository,
  secrets: SecretsApi,
  kioskId: number,
  clusterKey: string | undefined,
): KioskBundle | null {
  const kiosk = repo.getKioskById(kioskId);
  if (!kiosk || !kiosk.display_id) return null;

  const display = repo.getDisplayById(kiosk.display_id);
  if (!display) return null;

  const layouts = repo.layoutsForDisplayId(display.id);
  const layoutIds = layouts.map((l) => l.id);

  // Collect all cameras referenced by cells in these layouts
  const cameras = repo.camerasForLayoutIds(layoutIds);

  const bundleLayouts: BundleLayout[] = layouts.map((l) => {
    const cells = repo.layoutCells(l.id);
    const template = l.template_id ? repo.getLayoutTemplateById(l.template_id) : null;
    return {
      id: l.id,
      name: l.name,
      template: template ? {
        id: template.id,
        name: template.name,
        regions: template.regions,
        grid_cols: template.grid_cols,
        grid_rows: template.grid_rows,
      } : null,
      priority: l.priority,
      cooling_timeout_seconds: l.cooling_timeout_seconds,
      preload_camera_ids: l.preload_camera_ids,
      is_default: l.is_default,
      resets_idle_timer: l.resets_idle_timer,
      cells: cells.map((c) => ({
        region_name: c.region_name,
        content_type: c.content_type,
        camera_id: c.camera_id,
        stream_selector: c.stream_selector,
        web_url: c.web_url,
        html_content: c.html_content,
        cooling_timeout_seconds: c.cooling_timeout_seconds,
      })),
    };
  });

  const bundleCameras: BundleCamera[] = cameras.map((cam) => {
    const streams = repo.listCameraStreams(cam.id);
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
      stream_policy: cam.stream_policy,
      streams: streams.map((s) => ({
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

  const bundle: KioskBundle = {
    kiosk_id: kioskId,
    kiosk_name: kiosk.name,
    display: {
      id: display.id,
      name: display.name,
      width_px: display.width_px,
      height_px: display.height_px,
      idle_timeout_seconds: display.idle_timeout_seconds,
      sleep_timeout_seconds: display.sleep_timeout_seconds,
      default_layout_id: display.default_layout_id,
    },
    layouts: bundleLayouts,
    cameras: bundleCameras,
    version: "",
  };

  bundle.version = createHash("sha256")
    .update(JSON.stringify(bundle))
    .digest("hex");

  return bundle;
}
