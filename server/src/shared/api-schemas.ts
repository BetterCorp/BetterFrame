/**
 * Anyvali input schemas for all external-facing API endpoints.
 * Applied via validateBody() / validateQuery() helpers.
 */
import * as av from "anyvali";

// ---- Kiosk API (service-api-http) -------------------------------------------

export const PairInitiateBody = av.object(
  {
    proposed_name: av.string().maxLength(128).default(""),
    hardware_model: av.string().maxLength(128).default(""),
    firmware_target: av.string().maxLength(128).default(""),
    capabilities: av.array(av.string().maxLength(64)).default([]),
    managed_image: av.bool().default(false),
  },
  { unknownKeys: "strip" },
);

export const PairClaimBody = av.object(
  {
    code: av.string().minLength(1).maxLength(16),
  },
  { unknownKeys: "strip" },
);

const HeartbeatDisplay = av.object(
  {
    index: av.int().min(0).max(32).default(0),
    name: av.string().maxLength(128).default(""),
    width_px: av.int().min(0).max(16384).default(0),
    height_px: av.int().min(0).max(16384).default(0),
    power_state: av.string().maxLength(16).default("unknown"),
  },
  { unknownKeys: "strip" },
);

const HeartbeatPartition = av.object(
  {
    device: av.string().maxLength(128).default(""),
    mountpoint: av.string().maxLength(256).default(""),
    total_mb: av.int().min(0).default(0),
    used_mb: av.int().min(0).default(0),
    free_mb: av.int().min(0).default(0),
    used_percent: av.number().min(0).max(100).default(0),
  },
  { unknownKeys: "strip" },
);

export const HeartbeatBody = av.object(
  {
    bundle_version: av.optional(av.nullable(av.string().maxLength(128))),
    kiosk_app_version: av.string().maxLength(64).default(""),
    firmware_target: av.string().maxLength(128).default(""),
    os_version: av.string().maxLength(64).default(""),
    os_update_compatibility: av.string().maxLength(128).default(""),
    displays: av.array(HeartbeatDisplay).default([]),
    cpu_temp_c: av.optional(av.nullable(av.number().min(-40).max(150))),
    cpu_load_percent: av.optional(av.nullable(av.number().min(0).max(100))),
    gpu_load_percent: av.optional(av.nullable(av.number().min(0).max(100))),
    fan_rpm: av.optional(av.nullable(av.int().min(0).max(50000))),
    fan_pwm: av.optional(av.nullable(av.int().min(0).max(255))),
    memory_total_mb: av.optional(av.nullable(av.int().min(0))),
    memory_used_mb: av.optional(av.nullable(av.int().min(0))),
    disk_total_mb: av.optional(av.nullable(av.int().min(0))),
    disk_free_mb: av.optional(av.nullable(av.int().min(0))),
    disk_used_percent: av.optional(av.nullable(av.number().min(0).max(100))),
    local_key: av.optional(av.nullable(av.string().maxLength(256))),
    local_port: av.optional(av.nullable(av.int().min(1).max(65535))),
    reported_hostname: av.optional(av.nullable(av.string().maxLength(256))),
    network_interfaces: av.array(av.any()).default([]),
    logging: av.optional(av.any()),
    partitions: av.array(HeartbeatPartition).default([]),
    managed_config_applied_version: av.optional(av.int().min(0)),
    managed_config_error: av.optional(av.nullable(av.string().maxLength(4096))),
    onvif_subscriptions: av.optional(av.any()),
    pipeline_stats: av.array(av.any()).default([]),
  },
  { unknownKeys: "strip" },
);

export const EventBody = av.object(
  {
    topic: av.string().minLength(1).maxLength(512),
    source_type: av.string().maxLength(32).default("system"),
    camera_id: av.optional(av.nullable(av.string().maxLength(64))).default(null),
    property_op: av.optional(av.nullable(av.string().maxLength(32))).default(null),
    payload: av.any().default({}),
  },
  { unknownKeys: "strip" },
);

const KioskLogEntry = av.object(
  {
    level: av.string().maxLength(16).default("info"),
    message: av.string().maxLength(4096).default(""),
    context: av.any().default({}),
    logged_at: av.optional(av.string().maxLength(64)),
  },
  { unknownKeys: "strip" },
);

export const KioskLogsBody = av.object(
  {
    entries: av.array(KioskLogEntry).default([]),
  },
  { unknownKeys: "strip" },
);

export const FirmwareAppliedBody = av.object(
  {
    version: av.string().minLength(1).maxLength(64),
    error: av.optional(av.string().maxLength(4096)),
  },
  { unknownKeys: "strip" },
);

export const OsAppliedBody = av.object(
  {
    version: av.string().minLength(1).maxLength(64),
    error: av.optional(av.string().maxLength(4096)),
  },
  { unknownKeys: "strip" },
);

export const OsStatusBody = av.object(
  {
    version: av.string().minLength(1).maxLength(64),
    state: av.enum_(["installed", "pending_reboot", "confirmed", "rolled_back", "failed"] as const),
    error: av.optional(av.string().maxLength(4096)),
  },
  { unknownKeys: "strip" },
);

// ---- ioBOX API --------------------------------------------------------------

export const IoBoxAnnounceBody = av.object(
  {
    serial: av.string().minLength(1).maxLength(128),
    firmware_version: av.string().maxLength(64).default(""),
    firmware_arch: av.string().maxLength(64).default("esp32s3"),
    hardware_variant_detected: av.string().maxLength(32).default(""),
    network: av.any().default({}),
  },
  { unknownKeys: "strip" },
);

export const IoBoxPairClaimBody = av.object(
  {
    serial: av.string().minLength(1).maxLength(128),
    name: av.string().maxLength(128).default(""),
    assigned_display_id: av.optional(av.nullable(av.string().maxLength(128))).default(null),
  },
  { unknownKeys: "strip" },
);

export const IoBoxHeartbeatBody = av.object(
  {
    firmware_version: av.string().maxLength(64).default(""),
    config_applied_version: av.optional(av.int().min(0)),
    config_error: av.optional(av.nullable(av.string().maxLength(4096))),
    route_mode: av.string().maxLength(16).default("unknown"),
    network: av.any().default({}),
    inputs: av.any().default({}),
  },
  { unknownKeys: "strip" },
);

export const IoBoxEventBody = av.object(
  {
    event_id: av.optional(av.string().maxLength(128)),
    topic: av.string().minLength(1).maxLength(512),
    kind: av.string().maxLength(64).default("unknown"),
    action: av.optional(av.nullable(av.string().maxLength(64))).default(null),
    code: av.optional(av.nullable(av.string().maxLength(128))).default(null),
    value: av.optional(av.any()),
    display_id: av.optional(av.nullable(av.string().maxLength(128))).default(null),
    payload: av.any().default({}),
    route: av.optional(av.string().maxLength(32)),
  },
  { unknownKeys: "strip" },
);

// ---- Auth (routes-auth, routes-setup) ----------------------------------------

export const LoginBody = av.object(
  {
    username: av.string().minLength(1).maxLength(128),
    password: av.string().minLength(1).maxLength(1024),
  },
  { unknownKeys: "strip" },
);

export const TotpBody = av.object(
  {
    code: av.string().minLength(1).maxLength(16),
  },
  { unknownKeys: "strip" },
);

export const SetupBody = av.object(
  {
    username: av.string().minLength(3).maxLength(64),
    password: av.string().minLength(12).maxLength(1024),
  },
  { unknownKeys: "strip" },
);

export const PasswordChangeBody = av.object(
  {
    current_password: av.string().minLength(1).maxLength(1024),
    new_password: av.string().minLength(12).maxLength(1024),
  },
  { unknownKeys: "strip" },
);

// ---- Helper -----------------------------------------------------------------

export function validateBody<T>(schema: { safeParse(input: unknown): { success: boolean; data?: T; error?: unknown } }, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    let msg = "invalid request body";
    const err = result.error as any;
    if (err?.issues) {
      msg = err.issues.map((i: any) => `${i.path?.join?.(".") ?? "?"}: ${i.message}`).join("; ");
    } else if (err?.message) {
      msg = String(err.message);
    }
    throw Object.assign(new Error(msg), { status: 400, statusText: "Bad Request" });
  }
  return result.data as T;
}
