import * as av from "@anyvali/js";

const id = av.string().minLength(1).maxLength(128);
const streamRole = av.enum_(["main", "sub", "other"] as const);
const streamSelector = av.enum_(["auto", "main", "sub"] as const);
const layoutPriority = av.enum_(["hot", "normal", "cold"] as const);
const cellContentType = av.enum_(["none", "camera", "web", "html", "ablesign"] as const);

const cameraStream = av.object(
  {
    id,
    role: streamRole,
    name: av.string().minLength(1).maxLength(128),
    rtsp_uri: av.string().minLength(1),
    width: av.nullable(av.int().min(1).max(8192)),
    height: av.nullable(av.int().min(1).max(8192)),
    encoding: av.nullable(av.string().maxLength(64)),
    framerate: av.nullable(av.number().min(0)),
  },
  { unknownKeys: "reject" },
);

const bundleCamera = av.object(
  {
    id,
    name: av.string().minLength(1).maxLength(128),
    type: av.string().minLength(1).maxLength(32),
    onvif_host: av.nullable(av.string().maxLength(255)),
    onvif_port: av.nullable(av.int().min(1).max(65535)),
    onvif_username: av.nullable(av.string().maxLength(128)),
    onvif_password_encrypted: av.nullable(av.string()),
    playback_username: av.nullable(av.string().maxLength(128)),
    playback_password_encrypted: av.nullable(av.string()),
    event_source: av.string().minLength(1).maxLength(128),
    event_sink: av.string().minLength(1).maxLength(128),
    stream_policy: av.string().minLength(1).maxLength(32),
    streams: av.array(cameraStream),
  },
  { unknownKeys: "reject" },
);

const smartUrlStep = av.object(
  {
    type: av.string().minLength(1).maxLength(32),
    url: av.optional(av.string()),
    selector: av.optional(av.string()),
    value: av.optional(av.string()),
    value_encrypted: av.optional(av.string()),
    delay_ms: av.optional(av.int().min(0)),
    timeout_ms: av.optional(av.int().min(0)),
    script: av.optional(av.string()),
  },
  { unknownKeys: "reject" },
);

const smartUrl = av.object(
  {
    steps: av.array(smartUrlStep),
    login_detect_url: av.optional(av.string()),
    session_check_interval_ms: av.optional(av.int().min(0)),
  },
  { unknownKeys: "reject" },
);

const bundleCell = av.object(
  {
    view_id: id,
    entity_id: av.nullable(id),
    row: av.int().min(0).max(63),
    col: av.int().min(0).max(63),
    row_span: av.int().min(1).max(64),
    col_span: av.int().min(1).max(64),
    content_type: cellContentType,
    camera_id: av.nullable(id),
    stream_selector: av.nullable(streamSelector),
    web_url: av.nullable(av.string()),
    html_content: av.nullable(av.string()),
    cooling_timeout_seconds: av.nullable(av.int().min(0)),
    fit: av.enum_(["cover", "contain", "fill"] as const),
    smart_url: av.optional(smartUrl),
    local_storage: av.optional(av.record(av.string())),
  },
  { unknownKeys: "reject" },
);

const bundleLayout = av.object(
  {
    id,
    name: av.string().minLength(1).maxLength(128),
    grid_cols: av.int().min(1).max(64),
    grid_rows: av.int().min(1).max(64),
    priority: layoutPriority,
    cooling_timeout_seconds: av.nullable(av.int().min(0)),
    idle_timeout_seconds: av.nullable(av.int().min(0)),
    preload_camera_ids: av.array(id),
    resets_idle_timer: av.bool(),
    is_default: av.bool(),
    cells: av.array(bundleCell),
  },
  { unknownKeys: "reject" },
);

const bundleDisplay = av.object(
  {
    id,
    name: av.string().minLength(1).maxLength(128),
    width_px: av.int().min(1),
    height_px: av.int().min(1),
    idle_timeout_seconds: av.int().min(0),
    sleep_timeout_seconds: av.int().min(0),
    default_layout_id: av.nullable(id),
  },
  { unknownKeys: "reject" },
);

const bundleDisplayWithLayouts = av.object(
  {
    id,
    name: av.string().minLength(1).maxLength(128),
    width_px: av.int().min(1),
    height_px: av.int().min(1),
    idle_timeout_seconds: av.int().min(0),
    sleep_timeout_seconds: av.int().min(0),
    default_layout_id: av.nullable(id),
    layouts: av.array(bundleLayout),
  },
  { unknownKeys: "reject" },
);

const gpioBinding = av.object(
  {
    id,
    chip: av.string().minLength(1).maxLength(128),
    pin: av.int().min(0),
    direction: av.enum_(["in", "out"] as const),
    pull: av.nullable(av.enum_(["up", "down", "none"] as const)),
    edge: av.nullable(av.enum_(["rising", "falling", "both"] as const)),
    topic: av.string().minLength(1).maxLength(256),
  },
  { unknownKeys: "reject" },
);

export const kioskBundle = av.object(
  {
    kiosk_id: id,
    kiosk_name: av.string().minLength(1).maxLength(128),
    display: bundleDisplay,
    layouts: av.array(bundleLayout),
    displays: av.array(bundleDisplayWithLayouts),
    cameras: av.array(bundleCamera),
    gpio_bindings: av.array(gpioBinding),
    version: av.string().minLength(1).maxLength(128),
  },
  { unknownKeys: "reject" },
);

export type KioskBundle = av.Infer<typeof kioskBundle>;
