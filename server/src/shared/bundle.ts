/**
 * Label-scoped bundle generation — shared module.
 *
 * Queries cameras/layouts/templates for a kiosk's label set,
 * encrypts ONVIF passwords with cluster key, returns versioned bundle.
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

export interface BundleLayout {
  id: number;
  name: string;
  template_id: number | null;
  display_id: number | null;
  priority: string;
  cooling_timeout_seconds: number | null;
  preload_camera_ids: number[];
  is_default: boolean;
  resets_idle_timer: boolean;
  cells: Array<{
    region_name: string;
    content_type: string;
    camera_id: number | null;
    stream_selector: string | null;
    web_url: string | null;
    html_content: string | null;
  }>;
}

export interface KioskBundle {
  kiosk_id: number;
  kiosk_name: string;
  labels: string[];
  operate_labels: string[];
  cameras: BundleCamera[];
  layouts: BundleLayout[];
  templates: Array<{
    id: number;
    name: string;
    regions: unknown;
    grid_cols: number;
    grid_rows: number;
  }>;
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

  const scope = repo.bundleScope(kioskId);
  const cameras = repo.camerasForLabelIds(scope.labelIds);
  const layouts = repo.layoutsForLabelIds(scope.labelIds);

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

  const templateIds = [...new Set(layouts.map((l) => l.template_id).filter((id): id is number => id !== null))];
  const templates = templateIds.length > 0 ? repo.layoutTemplates(templateIds) : [];

  const bundleLayouts: BundleLayout[] = layouts.map((l) => {
    const cells = repo.layoutCells(l.id);
    return {
      id: l.id,
      name: l.name,
      template_id: l.template_id,
      display_id: l.display_id,
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
      })),
    };
  });

  const bundle: KioskBundle = {
    kiosk_id: kioskId,
    kiosk_name: kiosk.name,
    labels: scope.labelNames,
    operate_labels: scope.operateLabelNames,
    cameras: bundleCameras,
    layouts: bundleLayouts,
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      regions: t.regions,
      grid_cols: t.grid_cols,
      grid_rows: t.grid_rows,
    })),
    version: "",
  };

  bundle.version = createHash("sha256")
    .update(JSON.stringify(bundle))
    .digest("hex");

  return bundle;
}
