/**
 * Anyvali input schemas for all external-facing API endpoints.
 * Applied via validateBody() / validateQuery() helpers.
 */
import * as av from "@anyvali/js";

// ---- Kiosk API (service-api-http) -------------------------------------------

export const PairInitiateBody = av.object(
  {
    proposed_name: av.string().maxLength(128).default(""),
    hardware_model: av.string().maxLength(128).default(""),
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
    bundle_version: av.string().maxLength(128).default(""),
    kiosk_app_version: av.string().maxLength(64).default(""),
    os_version: av.string().maxLength(64).default(""),
    displays: av.array(HeartbeatDisplay).default([]),
    cpu_temp_c: av.nullable(av.number().min(-40).max(150)).default(null),
    cpu_load_percent: av.nullable(av.number().min(0).max(100)).default(null),
    fan_rpm: av.nullable(av.int().min(0).max(50000)).default(null),
    fan_pwm: av.nullable(av.int().min(0).max(255)).default(null),
    memory_total_mb: av.nullable(av.int().min(0)).default(null),
    memory_used_mb: av.nullable(av.int().min(0)).default(null),
    disk_total_mb: av.nullable(av.int().min(0)).default(null),
    disk_free_mb: av.nullable(av.int().min(0)).default(null),
    disk_used_percent: av.nullable(av.number().min(0).max(100)).default(null),
    local_key: av.nullable(av.string().maxLength(256)).default(null),
    local_port: av.nullable(av.int().min(1).max(65535)).default(null),
    reported_hostname: av.nullable(av.string().maxLength(256)).default(null),
    network_interfaces: av.array(av.any()).default([]),
    partitions: av.array(HeartbeatPartition).default([]),
    managed_config_applied_version: av.optional(av.int().min(0)),
    managed_config_error: av.optional(av.nullable(av.string().maxLength(4096))),
    onvif_subscriptions: av.optional(av.any()),
  },
  { unknownKeys: "strip" },
);

export const EventBody = av.object(
  {
    topic: av.string().minLength(1).maxLength(512),
    source_type: av.string().maxLength(32).default("system"),
    camera_id: av.nullable(av.string().maxLength(64)).default(null),
    property_op: av.nullable(av.string().maxLength(32)).default(null),
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
    const msg = typeof result.error === "object" && result.error && "message" in result.error
      ? String((result.error as any).message)
      : "invalid request body";
    throw Object.assign(new Error(msg), { status: 400, statusText: "Bad Request" });
  }
  return result.data as T;
}
