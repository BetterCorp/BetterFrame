/**
 * Wire schemas for kiosk-emitted reports.
 *
 *   POST /api/kiosk/heartbeat → liveness, version, applied bundle hash
 *   POST /api/kiosk/event     → forward a hardware event (ONVIF, GPIO, etc.)
 *
 * The server logs all events to event_log and forwards them to Node-RED for
 * rule processing. Cross-language: imported by Rust kiosk for outbound calls
 * and by the Node-RED bridge to validate inbound payloads.
 */
import * as av from "anyvali";

export const kioskHeartbeat = av.object(
  {
    bundle_version: av.optional(av.string().maxLength(64)),
    kiosk_app_version: av.optional(av.string().maxLength(64)),
    firmware_target: av.optional(av.string().maxLength(128)),
    os_version: av.optional(av.string().maxLength(128)),
    os_update_compatibility: av.optional(av.string().maxLength(128)),
    uptime_seconds: av.optional(av.int().min(0)),
    cpu_load: av.optional(av.number().min(0).max(100)),
    cpu_load_percent: av.optional(av.number().min(0).max(100)),
    cpu_temp_c: av.optional(av.number()),
    memory_used_mb: av.optional(av.int().min(0)),
    memory_total_mb: av.optional(av.int().min(0)),
    disk_total_mb: av.optional(av.int().min(0)),
    disk_free_mb: av.optional(av.int().min(0)),
    disk_used_percent: av.optional(av.number().min(0).max(100)),
    displays: av.optional(av.array(av.object({
      index: av.optional(av.int().min(0)),
      name: av.string().minLength(1).maxLength(128),
      width_px: av.int().min(0),
      height_px: av.int().min(0),
      power_state: av.optional(av.enum_(["awake", "standby", "unknown"] as const)),
    }))),
    active_layout_id: av.optional(av.int().min(1)),
    streams_warm: av.optional(av.int().min(0)),
    streams_hot: av.optional(av.int().min(0)),
    // Kiosk-reported network identity — host sees only the proxy IP behind
    // Docker/Angie. reported_hostname lets the admin verify the helper applied
    // the desired hostname. network_interfaces lists every non-loopback iface
    // with its IPs (v4/v6, with CIDR), MAC, and operstate from `ip -j addr`.
    reported_hostname: av.optional(av.string().maxLength(253)),
    network_interfaces: av.optional(av.array(av.object({
      name: av.string().minLength(1).maxLength(64),
      mac: av.optional(av.string().maxLength(32)),
      operstate: av.optional(av.string().maxLength(32)),
      ips: av.array(av.string().minLength(1).maxLength(64)),
    }, { unknownKeys: "strip" }))),
  },
  { unknownKeys: "strip" },
);

export const eventSourceType = av.enum_(["onvif", "gpio", "synthetic", "system", "io", "interaction"] as const);

export const kioskEvent = av.object(
  {
    topic: av.string().minLength(1).maxLength(256),
    source_type: eventSourceType,
    camera_id: av.optional(av.int().min(1)),
    property_op: av.optional(av.enum_(["initial", "changed"] as const)),
    payload: av.record(av.unknown()),
    occurred_at: av.optional(av.string().format("date-time")),
  },
  { unknownKeys: "reject" },
);

export const kioskHeartbeatResponse = av.object(
  {
    ok: av.bool(),
    now: av.string().format("date-time"),
    /** If non-null and != current bundle, kiosk should refetch. */
    bundle_version_current: av.optional(av.string().maxLength(64)),
  },
  { unknownKeys: "reject" },
);

export const kioskEventResponse = av.object(
  {
    ok: av.bool(),
    event_id: av.optional(av.int().min(1)),
    error: av.optional(av.string()),
  },
  { unknownKeys: "reject" },
);

export type KioskHeartbeat = av.Infer<typeof kioskHeartbeat>;
export type KioskEvent = av.Infer<typeof kioskEvent>;
export type KioskHeartbeatResponse = av.Infer<typeof kioskHeartbeatResponse>;
export type KioskEventResponse = av.Infer<typeof kioskEventResponse>;
