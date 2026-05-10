/**
 * Wire schema for the kiosk bundle response.
 *
 * GET /api/kiosk/bundle (kiosk-key auth) → this. Contains everything the kiosk
 * needs to operate offline. Camera passwords are cluster-encrypted before
 * being placed here; the kiosk decrypts using `cluster_key` it received during
 * pairing.
 *
 * Cross-language: imported by the Rust kiosk to populate its in-memory
 * configuration. Schema drift will fail loud — `unknownKeys: "reject"`.
 */
import * as av from "@anyvali/js";

const cameraType = av.enum_(["rtsp", "onvif"] as const);
const streamRole = av.enum_(["main", "sub", "other"] as const);
const streamSelector = av.enum_(["auto", "main", "sub"] as const);
const layoutPriority = av.enum_(["hot", "normal", "cold"] as const);
const cellContentType = av.enum_(["camera", "web", "html"] as const);

const cameraStream = av.object(
  {
    id: av.int().min(1),
    role: streamRole,
    name: av.string().minLength(1).maxLength(64),
    rtsp_uri: av.string().minLength(1),
    width: av.optional(av.int().min(1).max(8192)),
    height: av.optional(av.int().min(1).max(8192)),
    encoding: av.optional(av.string().maxLength(32)),
    framerate: av.optional(av.number().min(0)),
    bitrate_kbps: av.optional(av.int().min(0)),
  },
  { unknownKeys: "reject" },
);

const onvifInfo = av.object(
  {
    host: av.string().minLength(1).maxLength(255),
    port: av.int().min(1).max(65535),
    username: av.nullable(av.string().maxLength(128)),
    password_cluster_encrypted: av.nullable(av.string()),
  },
  { unknownKeys: "reject" },
);

const camera = av.object(
  {
    id: av.int().min(1),
    name: av.string().minLength(1).maxLength(128),
    type: cameraType,
    labels: av.array(av.string()),
    should_operate: av.bool(),
    rtsp_url: av.nullable(av.string()),
    stream_policy: av.enum_(["auto", "always_main", "always_sub"] as const),
    onvif: av.nullable(onvifInfo),
    streams: av.array(cameraStream),
    capabilities: av.array(av.string()),
  },
  { unknownKeys: "reject" },
);

const layoutCell = av.object(
  {
    row: av.int().min(0).max(63),
    col: av.int().min(0).max(63),
    row_span: av.int().min(1).max(64),
    col_span: av.int().min(1).max(64),
    content_type: cellContentType,
    camera_id: av.nullable(av.int().min(1)),
    stream_selector: streamSelector,
    web_url: av.nullable(av.string()),
    html_content: av.nullable(av.string()),
    cooling_timeout_seconds: av.nullable(av.int().min(0)),
  },
  { unknownKeys: "reject" },
);

const layout = av.object(
  {
    id: av.int().min(1),
    name: av.string().minLength(1).maxLength(128),
    grid_cols: av.int().min(1).max(64),
    grid_rows: av.int().min(1).max(64),
    priority: layoutPriority,
    cooling_timeout_seconds: av.nullable(av.int().min(0)),
    preload_camera_ids: av.array(av.int().min(1)),
    resets_idle_timer: av.bool(),
    is_default: av.bool(),
    cells: av.array(layoutCell),
  },
  { unknownKeys: "reject" },
);

export const kioskBundle = av.object(
  {
    kiosk_id: av.int().min(1),
    kiosk_name: av.string().minLength(1).maxLength(128),
    labels: av.array(av.string()),
    operate_labels: av.array(av.string()),
    cameras: av.array(camera),
    layouts: av.array(layout),
    version: av.string().minLength(1).maxLength(64),
  },
  { unknownKeys: "reject" },
);

export type KioskBundle = av.Infer<typeof kioskBundle>;
export type BundleCamera = av.Infer<typeof camera>;
export type BundleLayout = av.Infer<typeof layout>;
export type BundleLayoutCell = av.Infer<typeof layoutCell>;
