/**
 * Row-to-domain mappers. Pure functions, no DB access.
 *
 * Every mapper accepts `unknown` (because node:sqlite returns row objects
 * typed as Record<string, SqliteValue>) and returns a fully-typed domain
 * object from shared/types.ts.
 */
import type {
  ApiKey,
  ApiKeyScope,
  AuditActorType,
  AuditEntry,
  AuditResult,
  Camera,
  CameraStream,
  CameraType,
  CellContentType,
  DesiredPowerState,
  ActualPowerState,
  Display,
  Entity,
  EntityType,
  EventLog,
  EventSourceType,
  FirmwareChannel,
  FirmwareRelease,
  FirmwareRollout,
  FirmwareRolloutState,
  GpioDirection,
  GpioEdge,
  GpioPull,
  Kiosk,
  KioskGpioBinding,
  KioskLabel,
  Label,
  LabelRole,
  Layout,
  LayoutCell,
  LayoutPriority,
  LayoutRegion,
  LayoutTemplate,
  OsUpdateRelease,
  OsUpdateRollout,
  OsUpdateRolloutState,
  PairingCode,
  Session,
  SetupState,
  StreamPolicy,
  StreamRole,
  StreamSelector,
  User,
  UserRole,
} from "../../shared/types.js";
import { b, j } from "./util.js";

type Row = Record<string, unknown>;

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const sn = (v: unknown): string | null => (typeof v === "string" ? v : null);
const n = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
const nn = (v: unknown): number | null =>
  v === null || v === undefined ? null : typeof v === "number" ? v : Number(v) || null;

export function rowToUser(r: Row): User {
  return {
    id: n(r["id"]),
    username: s(r["username"]),
    password_hash: s(r["password_hash"]),
    role: s(r["role"]) as UserRole,
    is_active: b(r["is_active"]),
    totp_enabled: b(r["totp_enabled"]),
    totp_secret_encrypted: sn(r["totp_secret_encrypted"]),
    recovery_codes_hashed: j<string[]>(r["recovery_codes_hashed"], []),
    must_change_password: b(r["must_change_password"]),
    failed_login_count: n(r["failed_login_count"]),
    locked_until: sn(r["locked_until"]),
    last_login_at: sn(r["last_login_at"]),
    created_at: s(r["created_at"]),
  };
}

export function rowToSession(r: Row): Session {
  return {
    id: s(r["id"]),
    user_id: n(r["user_id"]),
    csrf_token: s(r["csrf_token"]),
    totp_pending: b(r["totp_pending"]),
    user_agent: sn(r["user_agent"]),
    ip_address: sn(r["ip_address"]),
    issued_at: s(r["issued_at"]),
    last_seen_at: s(r["last_seen_at"]),
    expires_at: s(r["expires_at"]),
    revoked_at: sn(r["revoked_at"]),
  };
}

export function rowToApiKey(r: Row): ApiKey {
  return {
    id: n(r["id"]),
    name: s(r["name"]),
    key_hash: s(r["key_hash"]),
    key_prefix: s(r["key_prefix"]),
    scopes: j<ApiKeyScope[]>(r["scopes"], []),
    expires_at: sn(r["expires_at"]),
    last_used_at: sn(r["last_used_at"]),
    last_used_ip: sn(r["last_used_ip"]),
    created_at: s(r["created_at"]),
    revoked_at: sn(r["revoked_at"]),
  };
}

export function rowToSetupState(r: Row): SetupState {
  return {
    id: 1,
    is_complete: b(r["is_complete"]),
    cluster_key_provisioned: b(r["cluster_key_provisioned"]),
    nodered_flows_deployed: b(r["nodered_flows_deployed"]),
    completed_at: sn(r["completed_at"]),
    extras: j<Record<string, unknown>>(r["extras"], {}),
  };
}

export function rowToDisplay(r: Row): Display {
  return {
    id: n(r["id"]),
    name: s(r["name"]),
    index: n(r["index"]),
    is_primary: b(r["is_primary"]),
    kiosk_id: nn(r["kiosk_id"]),
    width_px: n(r["width_px"]),
    height_px: n(r["height_px"]),
    default_layout_id: nn(r["default_layout_id"]),
    idle_timeout_seconds: n(r["idle_timeout_seconds"]),
    sleep_timeout_seconds: n(r["sleep_timeout_seconds"]),
    cec_enabled: b(r["cec_enabled"]),
    cec_device_path: sn(r["cec_device_path"]),
    cec_logical_address: nn(r["cec_logical_address"]),
    desired_power_state: s(r["desired_power_state"]) as DesiredPowerState,
    actual_power_state: s(r["actual_power_state"] ?? "unknown") as ActualPowerState,
    actual_power_state_at: sn(r["actual_power_state_at"]),
    state_check_enabled: b(r["state_check_enabled"]),
    state_check_interval_seconds: n(r["state_check_interval_seconds"]),
    is_enabled: b(r["is_enabled"]),
    active_layout_id: nn(r["active_layout_id"]),
  };
}

export function rowToCamera(r: Row): Camera {
  return {
    id: n(r["id"]),
    name: s(r["name"]),
    type: s(r["type"]) as CameraType,
    rtsp_url: sn(r["rtsp_url"]),
    onvif_host: sn(r["onvif_host"]),
    onvif_port: nn(r["onvif_port"]),
    onvif_username: sn(r["onvif_username"]),
    onvif_password: sn(r["onvif_password"]),
    capabilities: j<string[]>(r["capabilities"], []),
    stream_policy: s(r["stream_policy"]) as StreamPolicy,
    enabled: b(r["enabled"]),
    last_seen_at: sn(r["last_seen_at"]),
    created_at: s(r["created_at"]),
  };
}

export function rowToCameraStream(r: Row): CameraStream {
  return {
    id: n(r["id"]),
    camera_id: n(r["camera_id"]),
    role: s(r["role"]) as StreamRole,
    name: s(r["name"]),
    profile_token: sn(r["profile_token"]),
    rtsp_uri: s(r["rtsp_uri"]),
    width: nn(r["width"]),
    height: nn(r["height"]),
    encoding: sn(r["encoding"]),
    framerate: nn(r["framerate"]),
    bitrate_kbps: nn(r["bitrate_kbps"]),
    is_discovered: b(r["is_discovered"]),
  };
}

export function rowToLayoutTemplate(r: Row): LayoutTemplate {
  return {
    id: n(r["id"]),
    name: s(r["name"]),
    description: sn(r["description"]),
    regions: j<LayoutRegion[]>(r["regions"], []),
    grid_cols: n(r["grid_cols"]),
    grid_rows: n(r["grid_rows"]),
    is_builtin: b(r["is_builtin"]),
  };
}

export function rowToLayout(r: Row): Layout {
  return {
    id: n(r["id"]),
    name: s(r["name"]),
    description: sn(r["description"]),
    template_id: nn(r["template_id"]),
    regions: j<LayoutRegion[]>(r["regions"], []),
    grid_cols: n(r["grid_cols"]) || 1,
    grid_rows: n(r["grid_rows"]) || 1,
    display_id: nn(r["display_id"]),
    priority: s(r["priority"]) as LayoutPriority,
    cooling_timeout_seconds: nn(r["cooling_timeout_seconds"]),
    preload_camera_ids: j<number[]>(r["preload_camera_ids"], []),
    is_default: b(r["is_default"]),
    resets_idle_timer: b(r["resets_idle_timer"]),
  };
}

export function rowToLayoutCell(r: Row): LayoutCell {
  return {
    id: n(r["id"]),
    layout_id: n(r["layout_id"]),
    region_name: s(r["region_name"]),
    row: n(r["row"]),
    col: n(r["col"]),
    row_span: n(r["row_span"]) || 1,
    col_span: n(r["col_span"]) || 1,
    content_type: s(r["content_type"]) as CellContentType,
    camera_id: nn(r["camera_id"]),
    stream_selector: s(r["stream_selector"]) as StreamSelector,
    web_url: sn(r["web_url"]),
    html_content: sn(r["html_content"]),
    cooling_timeout_seconds: nn(r["cooling_timeout_seconds"]),
    options: j<Record<string, unknown>>(r["options"], {}),
    entity_id: nn(r["entity_id"]),
    fit: (s(r["fit"]) || "cover") as "cover" | "contain" | "fill",
  };
}

export function rowToEntity(r: Row): Entity {
  return {
    id: n(r["id"]),
    name: s(r["name"]),
    type: s(r["type"]) as EntityType,
    description: sn(r["description"]),
    camera_id: nn(r["camera_id"]),
    html_content: sn(r["html_content"]),
    web_url: sn(r["web_url"]),
    dashboard_id: sn(r["dashboard_id"]),
    created_at: s(r["created_at"]),
  };
}

export function rowToKiosk(r: Row): Kiosk {
  return {
    id: n(r["id"]),
    name: s(r["name"]),
    description: sn(r["description"]),
    key_hash: s(r["key_hash"]),
    key_prefix: s(r["key_prefix"]),
    capabilities: j<string[]>(r["capabilities"], []),
    hardware_model: sn(r["hardware_model"]),
    os_version: sn(r["os_version"]),
    kiosk_app_version: sn(r["kiosk_app_version"]),
    enabled: b(r["enabled"]),
    paired_at: sn(r["paired_at"]),
    last_seen_at: sn(r["last_seen_at"]),
    last_bundle_version: sn(r["last_bundle_version"]),
    display_id: nn(r["display_id"]),
    cpu_temp_c: nn(r["cpu_temp_c"]),
    cpu_load_percent: nn(r["cpu_load_percent"]),
    fan_rpm: nn(r["fan_rpm"]),
    fan_pwm: nn(r["fan_pwm"]),
    memory_total_mb: nn(r["memory_total_mb"]),
    memory_used_mb: nn(r["memory_used_mb"]),
    disk_total_mb: nn(r["disk_total_mb"]),
    disk_free_mb: nn(r["disk_free_mb"]),
    disk_used_percent: nn(r["disk_used_percent"]),
    firmware_channel: (s(r["firmware_channel"] ?? "stable")) as FirmwareChannel,
    firmware_target_version: sn(r["firmware_target_version"]),
    firmware_last_attempt_at: sn(r["firmware_last_attempt_at"]),
    firmware_last_attempt_version: sn(r["firmware_last_attempt_version"]),
    firmware_last_error: sn(r["firmware_last_error"]),
    os_update_channel: (s(r["os_update_channel"] ?? "stable")) as FirmwareChannel,
    os_update_target_version: sn(r["os_update_target_version"]),
    os_update_last_attempt_at: sn(r["os_update_last_attempt_at"]),
    os_update_last_attempt_version: sn(r["os_update_last_attempt_version"]),
    os_update_last_error: sn(r["os_update_last_error"]),
    local_key: sn(r["local_key"]),
    local_port: nn(r["local_port"]),
    local_last_ip: sn(r["local_last_ip"]),
    reported_hostname: sn(r["reported_hostname"]),
    network_interfaces_json: sn(r["network_interfaces_json"]),
    managed_image: b(r["managed_image"]),
    managed_config_json: sn(r["managed_config_json"]),
    managed_config_version: n(r["managed_config_version"] ?? 0),
    managed_config_applied_version: n(r["managed_config_applied_version"] ?? 0),
    managed_config_applied_at: sn(r["managed_config_applied_at"]),
    managed_config_error: sn(r["managed_config_error"]),
    created_at: s(r["created_at"]),
  };
}

export function rowToAuditEntry(r: Row): AuditEntry {
  return {
    id: n(r["id"]),
    ts: s(r["ts"]),
    actor_type: s(r["actor_type"]) as AuditActorType,
    actor_id: nn(r["actor_id"]),
    actor_label: sn(r["actor_label"]),
    action: s(r["action"]),
    resource_type: sn(r["resource_type"]),
    resource_id: sn(r["resource_id"]),
    ip: sn(r["ip"]),
    metadata: j<Record<string, unknown>>(r["metadata"], {}),
    result: s(r["result"]) as AuditResult,
  };
}

export function rowToFirmwareRelease(r: Row): FirmwareRelease {
  return {
    id: s(r["id"]),
    version: s(r["version"]),
    channel: s(r["channel"]) as FirmwareChannel,
    arch: s(r["arch"]),
    artifact_path: s(r["artifact_path"]),
    size_bytes: n(r["size_bytes"]),
    sha256: s(r["sha256"]),
    signature: s(r["signature"]),
    release_notes: sn(r["release_notes"]),
    uploaded_at: s(r["uploaded_at"]),
    uploaded_by: nn(r["uploaded_by"]),
    yanked_at: sn(r["yanked_at"]),
  };
}

export function rowToFirmwareRollout(r: Row): FirmwareRollout {
  return {
    id: s(r["id"]),
    release_id: s(r["release_id"]),
    target_kiosk_ids: j<number[]>(r["target_kiosk_ids"], []),
    state: s(r["state"]) as FirmwareRolloutState,
    percentage: n(r["percentage"]),
    started_at: sn(r["started_at"]),
    finished_at: sn(r["finished_at"]),
    created_at: s(r["created_at"]),
    created_by: nn(r["created_by"]),
  };
}

export function rowToOsUpdateRelease(r: Row): OsUpdateRelease {
  return {
    id: s(r["id"]),
    version: s(r["version"]),
    channel: s(r["channel"]) as FirmwareChannel,
    compatibility: s(r["compatibility"]),
    artifact_path: s(r["artifact_path"]),
    size_bytes: n(r["size_bytes"]),
    sha256: s(r["sha256"]),
    bundle_format: "raucb",
    release_notes: sn(r["release_notes"]),
    uploaded_at: s(r["uploaded_at"]),
    uploaded_by: nn(r["uploaded_by"]),
    yanked_at: sn(r["yanked_at"]),
  };
}

export function rowToOsUpdateRollout(r: Row): OsUpdateRollout {
  return {
    id: s(r["id"]),
    release_id: s(r["release_id"]),
    target_kiosk_ids: j<number[]>(r["target_kiosk_ids"], []),
    state: s(r["state"]) as OsUpdateRolloutState,
    percentage: n(r["percentage"]),
    started_at: sn(r["started_at"]),
    finished_at: sn(r["finished_at"]),
    created_at: s(r["created_at"]),
    created_by: nn(r["created_by"]),
  };
}

export function rowToLabel(r: Row): Label {
  return {
    id: n(r["id"]),
    name: s(r["name"]),
    description: sn(r["description"]),
    color: sn(r["color"]),
    created_at: s(r["created_at"]),
  };
}

export function rowToKioskLabel(r: Row): KioskLabel {
  return {
    kiosk_id: n(r["kiosk_id"]),
    label_id: n(r["label_id"]),
    role: s(r["role"]) as LabelRole,
  };
}

export function rowToPairingCode(r: Row): PairingCode {
  return {
    code: s(r["code"]),
    kiosk_proposed_name: sn(r["kiosk_proposed_name"]),
    kiosk_hardware_model: sn(r["kiosk_hardware_model"]),
    kiosk_capabilities: j<string[]>(r["kiosk_capabilities"], []),
    issued_at: s(r["issued_at"]),
    expires_at: s(r["expires_at"]),
    consumed_at: sn(r["consumed_at"]),
    consumed_by_kiosk_id: nn(r["consumed_by_kiosk_id"]),
    extras: j<Record<string, unknown>>(r["extras"], {}),
  };
}

export function rowToKioskGpioBinding(r: Row): KioskGpioBinding {
  const pullRaw = sn(r["pull"]);
  const edgeRaw = sn(r["edge"]);
  return {
    id: n(r["id"]),
    kiosk_id: n(r["kiosk_id"]),
    chip: s(r["chip"]) || "gpiochip0",
    pin: n(r["pin"]),
    direction: s(r["direction"]) as GpioDirection,
    pull: pullRaw ? (pullRaw as GpioPull) : null,
    edge: edgeRaw ? (edgeRaw as GpioEdge) : null,
    topic: s(r["topic"]),
    created_at: s(r["created_at"]),
  };
}

export function rowToEventLog(r: Row): EventLog {
  return {
    id: n(r["id"]),
    source_kiosk_id: nn(r["source_kiosk_id"]),
    source_camera_id: nn(r["source_camera_id"]),
    source_type: s(r["source_type"]) as EventSourceType,
    topic: s(r["topic"]),
    property_op: sn(r["property_op"]),
    payload: j<Record<string, unknown>>(r["payload"], {}),
    received_at: s(r["received_at"]),
    forwarded_to_nodered: b(r["forwarded_to_nodered"]),
  };
}
