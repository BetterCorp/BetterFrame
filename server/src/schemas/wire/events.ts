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
import * as av from "@anyvali/js";

export const kioskHeartbeat = av.object(
  {
    bundle_version: av.optional(av.string().maxLength(64)),
    kiosk_app_version: av.optional(av.string().maxLength(64)),
    os_version: av.optional(av.string().maxLength(128)),
    uptime_seconds: av.optional(av.int().min(0)),
    cpu_load: av.optional(av.number().min(0).max(100)),
    cpu_load_percent: av.optional(av.number().min(0).max(100)),
    cpu_temp_c: av.optional(av.number()),
    memory_used_mb: av.optional(av.int().min(0)),
    memory_total_mb: av.optional(av.int().min(0)),
    disk_total_mb: av.optional(av.int().min(0)),
    disk_free_mb: av.optional(av.int().min(0)),
    disk_used_percent: av.optional(av.number().min(0).max(100)),
    active_layout_id: av.optional(av.int().min(1)),
    streams_warm: av.optional(av.int().min(0)),
    streams_hot: av.optional(av.int().min(0)),
  },
  { unknownKeys: "strip" },
);

export const eventSourceType = av.enum_(["onvif", "gpio", "synthetic", "system"] as const);

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
