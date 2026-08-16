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
  CameraEventSubscription,
  CloudAccount,
  CloudVendor,
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
  EventSubscriptionStatus,
  FirmwareChannel,
  FirmwareRelease,
  FirmwareRollout,
  FirmwareRolloutState,
  GpioDirection,
  GpioEdge,
  GpioPull,
  IoBox,
  IoBoxFirmwareRelease,
  IoBoxInputMapping,
  IoBoxModel,
  IoBoxSerial,
  Kiosk,
  KioskGpioBinding,
  KioskLabel,
  KioskLog,
  KioskLogLevel,
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
  Tenant,
  User,
  UserRole,
} from "../types.js";
import { b, j } from "./util.js";

type Row = Record<string, unknown>;

const s = (v: unknown): string => (typeof v === "string" ? v : v instanceof Date ? v.toISOString() : String(v ?? ""));
const sn = (v: unknown): string | null => (v == null ? null : typeof v === "string" ? v : v instanceof Date ? v.toISOString() : null);
const jsn = (v: unknown): string | null => (v == null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : null);
const n = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
const nn = (v: unknown): number | null =>
  v === null || v === undefined ? null : typeof v === "number" ? v : Number(v) || null;

export function rowToUser(r: Row): User {
  return {
    id: s(r["id"]),
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
    user_id: s(r["user_id"]),
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
    id: s(r["id"]),
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
    id: s(r["id"]),
    name: s(r["name"]),
    index: n(r["index"]),
    is_primary: b(r["is_primary"]),
    kiosk_id: sn(r["kiosk_id"]),
    width_px: n(r["width_px"]),
    height_px: n(r["height_px"]),
    default_layout_id: sn(r["default_layout_id"]),
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
    active_layout_id: sn(r["active_layout_id"]),
  };
}

export function rowToCamera(r: Row): Camera {
  return {
    id: s(r["id"]),
    name: s(r["name"]),
    camera_number: sn(r["camera_number"]),
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
    event_source: s(r["event_source"] ?? "auto"),
    event_sink: s(r["event_sink"] ?? "auto"),
    supported_event_topics: j<string[]>(r["supported_event_topics"], []),
    cloud_account_id: sn(r["cloud_account_id"]),
    cloud_vendor_camera_id: sn(r["cloud_vendor_camera_id"]),
    cloud_stream_url: sn(r["cloud_stream_url"]),
    cloud_stream_type: sn(r["cloud_stream_type"]),
    event_callback_nonce: sn(r["event_callback_nonce"]),
    event_callback_token_hash: sn(r["event_callback_token_hash"]),
    recording_config_json: j<Record<string, unknown>>(r["recording_config_json"], {}),
  };
}

export function rowToCameraStream(r: Row): CameraStream {
  return {
    id: s(r["id"]),
    camera_id: s(r["camera_id"]),
    role: s(r["role"]) as StreamRole,
    name: s(r["name"]),
    profile_token: sn(r["profile_token"]),
    rtsp_uri: s(r["rtsp_uri"]),
    rtsp_host: sn(r["rtsp_host"]),
    rtsp_port: nn(r["rtsp_port"]),
    rtsp_path: sn(r["rtsp_path"]),
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
    id: s(r["id"]),
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
    id: s(r["id"]),
    name: s(r["name"]),
    description: sn(r["description"]),
    template_id: sn(r["template_id"]),
    regions: j<LayoutRegion[]>(r["regions"], []),
    grid_cols: n(r["grid_cols"]) || 1,
    grid_rows: n(r["grid_rows"]) || 1,
    display_id: sn(r["display_id"]),
    priority: s(r["priority"]) as LayoutPriority,
    cooling_timeout_seconds: nn(r["cooling_timeout_seconds"]),
    idle_timeout_seconds: nn(r["idle_timeout_seconds"]),
    preload_camera_ids: j<string[]>(r["preload_camera_ids"], []),
    is_default: b(r["is_default"]),
    resets_idle_timer: b(r["resets_idle_timer"]),
    input_options_json: j<Record<string, unknown>>(r["input_options_json"], {}),
  };
}

export function rowToLayoutCell(r: Row): LayoutCell {
  return {
    id: s(r["id"]),
    layout_id: s(r["layout_id"]),
    region_name: s(r["region_name"]),
    row: n(r["row"]),
    col: n(r["col"]),
    row_span: n(r["row_span"]) || 1,
    col_span: n(r["col_span"]) || 1,
    content_type: s(r["content_type"]) as CellContentType,
    camera_id: sn(r["camera_id"]),
    stream_selector: s(r["stream_selector"]) as StreamSelector,
    web_url: sn(r["web_url"]),
    html_content: sn(r["html_content"]),
    cooling_timeout_seconds: nn(r["cooling_timeout_seconds"]),
    options: j<Record<string, unknown>>(r["options"], {}),
    input_options_json: j<Record<string, unknown>>(r["input_options_json"], {}),
    entity_id: sn(r["entity_id"]),
    fit: (s(r["fit"]) || "cover") as "cover" | "contain" | "fill",
  };
}

export function rowToIoBoxModel(r: Row): IoBoxModel {
  return {
    id: s(r["id"]),
    name: s(r["name"]),
    description: sn(r["description"]),
    hardware_variant: s(r["hardware_variant"]) as IoBoxModel["hardware_variant"],
    firmware_arch: s(r["firmware_arch"] ?? "esp32s3"),
    firmware_track: s(r["firmware_track"] ?? "stable"),
    capabilities_json: j<Record<string, unknown>>(r["capabilities_json"], {}),
    ports_json: j<IoBoxModel["ports_json"]>(r["ports_json"], []),
    created_at: s(r["created_at"]),
  };
}

export function rowToIoBoxSerial(r: Row): IoBoxSerial {
  return {
    serial: s(r["serial"]),
    model_id: s(r["model_id"]),
    notes: sn(r["notes"]),
    registered_at: s(r["registered_at"]),
    paired_tenant_id: sn(r["paired_tenant_id"]),
    paired_iobox_id: sn(r["paired_iobox_id"]),
    last_seen_at: sn(r["last_seen_at"]),
  };
}

export function rowToIoBox(r: Row): IoBox {
  return {
    id: s(r["id"]),
    serial: s(r["serial"]),
    model_id: s(r["model_id"]),
    name: s(r["name"]),
    key_hash: sn(r["key_hash"]),
    key_prefix: sn(r["key_prefix"]),
    enabled: b(r["enabled"]),
    paired_at: sn(r["paired_at"]),
    last_seen_at: sn(r["last_seen_at"]),
    assigned_display_id: sn(r["assigned_display_id"]),
    firmware_version: sn(r["firmware_version"]),
    firmware_channel: s(r["firmware_channel"] ?? "stable") as IoBox["firmware_channel"],
    firmware_target_version: sn(r["firmware_target_version"]),
    firmware_last_attempt_at: sn(r["firmware_last_attempt_at"]),
    firmware_last_attempt_version: sn(r["firmware_last_attempt_version"]),
    firmware_last_error: sn(r["firmware_last_error"]),
    config_json: j<Record<string, unknown>>(r["config_json"], {}),
    config_version: n(r["config_version"]),
    config_applied_version: n(r["config_applied_version"]),
    config_applied_at: sn(r["config_applied_at"]),
    config_error: sn(r["config_error"]),
    route_mode: s(r["route_mode"] ?? "unknown") as IoBox["route_mode"],
    local_last_ip: sn(r["local_last_ip"]),
    network_json: j<Record<string, unknown>>(r["network_json"], {}),
    created_at: s(r["created_at"]),
  };
}

export function rowToIoBoxInputMapping(r: Row): IoBoxInputMapping {
  return {
    id: s(r["id"]),
    iobox_id: sn(r["iobox_id"]),
    display_id: sn(r["display_id"]),
    layout_id: sn(r["layout_id"]),
    cell_id: sn(r["cell_id"]),
    source_kind: s(r["source_kind"]),
    match_json: j<Record<string, unknown>>(r["match_json"], {}),
    target_kind: s(r["target_kind"]),
    action: s(r["action"]),
    params_json: j<Record<string, unknown>>(r["params_json"], {}),
    enabled: b(r["enabled"]),
    created_at: s(r["created_at"]),
  };
}

export function rowToIoBoxFirmwareRelease(r: Row): IoBoxFirmwareRelease {
  return {
    id: s(r["id"]),
    version: s(r["version"]),
    channel: s(r["channel"] ?? "stable") as FirmwareChannel,
    firmware_arch: s(r["firmware_arch"] ?? "esp32s3"),
    model_id: sn(r["model_id"]),
    artifact_path: s(r["artifact_path"]),
    size_bytes: n(r["size_bytes"]),
    sha256: s(r["sha256"]),
    signature: s(r["signature"]),
    release_notes: sn(r["release_notes"]),
    uploaded_at: s(r["uploaded_at"]),
    uploaded_by: sn(r["uploaded_by"]),
    yanked_at: sn(r["yanked_at"]),
  };
}

export function rowToEntity(r: Row): Entity {
  return {
    id: s(r["id"]),
    name: s(r["name"]),
    type: s(r["type"]) as EntityType,
    description: sn(r["description"]),
    camera_id: sn(r["camera_id"]),
    html_content: sn(r["html_content"]),
    web_url: sn(r["web_url"]),
    dashboard_id: sn(r["dashboard_id"]),
    ablesign_screen_id: sn(r["ablesign_screen_id"]),
    managed: !!r["managed"],
    input_options_json: j<Record<string, unknown>>(r["input_options_json"], {}),
    created_at: s(r["created_at"]),
  };
}

export function rowToKiosk(r: Row): Kiosk {
  return {
    id: s(r["id"]),
    name: s(r["name"]),
    description: sn(r["description"]),
    key_hash: s(r["key_hash"]),
    key_prefix: s(r["key_prefix"]),
    capabilities: j<string[]>(r["capabilities"], []),
    hardware_model: sn(r["hardware_model"]),
    os_version: sn(r["os_version"]),
    kiosk_app_version: sn(r["kiosk_app_version"]),
    firmware_target: sn(r["firmware_target"]),
    os_update_compatibility: sn(r["os_update_compatibility"]),
    enabled: b(r["enabled"]),
    paired_at: sn(r["paired_at"]),
    last_seen_at: sn(r["last_seen_at"]),
    last_bundle_version: sn(r["last_bundle_version"]),
    display_id: sn(r["display_id"]),
    cpu_temp_c: nn(r["cpu_temp_c"]),
    cpu_load_percent: nn(r["cpu_load_percent"]),
    gpu_load_percent: nn(r["gpu_load_percent"]),
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
    os_update_state: s(r["os_update_state"] ?? "confirmed") as Kiosk["os_update_state"],
    audio_default_volume_percent: n(r["audio_default_volume_percent"] ?? 50),
    local_key: sn(r["local_key"]),
    local_port: nn(r["local_port"]),
    local_last_ip: sn(r["local_last_ip"]),
    encrypt_key_encrypted: sn(r["encrypt_key_encrypted"]),
    reported_hostname: sn(r["reported_hostname"]),
    network_interfaces_json: jsn(r["network_interfaces_json"]),
    logging_json: jsn(r["logging_json"]),
    renderer_telemetry_json: jsn(r["renderer_telemetry_json"]),
    operator_console_enabled: b(r["operator_console_enabled"]),
    operator_console_host: sn(r["operator_console_host"]),
    operator_console_port: n(r["operator_console_port"] ?? 18443),
    operator_tools_json: jsn(r["operator_tools_json"]),
    simple_vms_enabled: b(r["simple_vms_enabled"]),
    simple_vms_storage_path: sn(r["simple_vms_storage_path"]),
    simple_vms_settings_json: jsn(r["simple_vms_settings_json"]),
    managed_image: b(r["managed_image"]),
    managed_config_json: jsn(r["managed_config_json"]),
    managed_config_version: n(r["managed_config_version"] ?? 0),
    managed_config_applied_version: n(r["managed_config_applied_version"] ?? 0),
    managed_config_applied_at: sn(r["managed_config_applied_at"]),
    managed_config_error: sn(r["managed_config_error"]),
    created_at: s(r["created_at"]),
  };
}

export function rowToAuditEntry(r: Row): AuditEntry {
  return {
    id: s(r["id"]),
    ts: s(r["ts"]),
    actor_type: s(r["actor_type"]) as AuditActorType,
    actor_id: sn(r["actor_id"]),
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
    uploaded_by: sn(r["uploaded_by"]),
    yanked_at: sn(r["yanked_at"]),
  };
}

export function rowToFirmwareRollout(r: Row): FirmwareRollout {
  return {
    id: s(r["id"]),
    release_id: s(r["release_id"]),
    target_kiosk_ids: j<string[]>(r["target_kiosk_ids"], []),
    state: s(r["state"]) as FirmwareRolloutState,
    percentage: n(r["percentage"]),
    started_at: sn(r["started_at"]),
    finished_at: sn(r["finished_at"]),
    created_at: s(r["created_at"]),
    created_by: sn(r["created_by"]),
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
    uploaded_by: sn(r["uploaded_by"]),
    yanked_at: sn(r["yanked_at"]),
  };
}

export function rowToOsUpdateRollout(r: Row): OsUpdateRollout {
  return {
    id: s(r["id"]),
    release_id: s(r["release_id"]),
    target_kiosk_ids: j<string[]>(r["target_kiosk_ids"], []),
    state: s(r["state"]) as OsUpdateRolloutState,
    percentage: n(r["percentage"]),
    started_at: sn(r["started_at"]),
    finished_at: sn(r["finished_at"]),
    created_at: s(r["created_at"]),
    created_by: sn(r["created_by"]),
  };
}

export function rowToLabel(r: Row): Label {
  return {
    id: s(r["id"]),
    name: s(r["name"]),
    description: sn(r["description"]),
    color: sn(r["color"]),
    created_at: s(r["created_at"]),
  };
}

export function rowToKioskLabel(r: Row): KioskLabel {
  return {
    kiosk_id: s(r["kiosk_id"]),
    label_id: s(r["label_id"]),
    role: s(r["role"]) as LabelRole,
  };
}

export function rowToPairingCode(r: Row): PairingCode {
  return {
    code: s(r["code"]),
    kiosk_proposed_name: sn(r["kiosk_proposed_name"]),
    kiosk_hardware_model: sn(r["kiosk_hardware_model"]),
    kiosk_firmware_target: sn(r["kiosk_firmware_target"]),
    kiosk_capabilities: j<string[]>(r["kiosk_capabilities"], []),
    issued_at: s(r["issued_at"]),
    expires_at: s(r["expires_at"]),
    consumed_at: sn(r["consumed_at"]),
    consumed_by_kiosk_id: sn(r["consumed_by_kiosk_id"]),
    extras: j<Record<string, unknown>>(r["extras"], {}),
  };
}

export function rowToKioskGpioBinding(r: Row): KioskGpioBinding {
  const pullRaw = sn(r["pull"]);
  const edgeRaw = sn(r["edge"]);
  return {
    id: s(r["id"]),
    kiosk_id: s(r["kiosk_id"]),
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
    id: s(r["id"]),
    source_kiosk_id: sn(r["source_kiosk_id"]),
    source_camera_id: sn(r["source_camera_id"]),
    source_iobox_id: sn(r["source_iobox_id"]),
    source_type: s(r["source_type"]) as EventSourceType,
    topic: s(r["topic"]),
    property_op: sn(r["property_op"]),
    payload: j<Record<string, unknown>>(r["payload"], {}),
    received_at: s(r["received_at"]),
    forwarded_to_nodered: b(r["forwarded_to_nodered"]),
  };
}

export function rowToKioskLog(r: Row): KioskLog {
  return {
    id: s(r["id"]),
    kiosk_id: s(r["kiosk_id"]),
    level: s(r["level"]) as KioskLogLevel,
    message: s(r["message"]),
    context: j<Record<string, unknown>>(r["context"], {}),
    logged_at: s(r["logged_at"]),
    received_at: s(r["received_at"]),
  };
}

export function rowToCloudAccount(r: Row): CloudAccount {
  return {
    id: s(r["id"]),
    vendor: s(r["vendor"]) as CloudVendor,
    name: s(r["name"]),
    credentials_encrypted: s(r["credentials_encrypted"]),
    is_active: b(r["is_active"]),
    last_sync_at: sn(r["last_sync_at"]),
    last_sync_error: sn(r["last_sync_error"]),
    camera_count: n(r["camera_count"]),
    created_at: s(r["created_at"]),
  };
}

export function rowToCameraEventSubscription(r: Row): CameraEventSubscription {
  return {
    id: s(r["id"]),
    camera_id: s(r["camera_id"]),
    topic: s(r["topic"]),
    status: s(r["status"]) as EventSubscriptionStatus,
    subscribed_by_kiosk_id: sn(r["subscribed_by_kiosk_id"]),
    event_source: sn(r["event_source"]),
    event_sink: sn(r["event_sink"]),
    last_event_at: sn(r["last_event_at"]),
    error_message: sn(r["error_message"]),
    subscribed_at: sn(r["subscribed_at"]),
    created_at: s(r["created_at"]),
  };
}

export function rowToTenant(r: Row): Tenant {
  return {
    id: s(r["id"]),
    name: s(r["name"]),
    slug: s(r["slug"]),
    schema_name: s(r["schema_name"]),
    is_active: b(r["is_active"]),
    max_kiosks: nn(r["max_kiosks"]),
    max_cameras: nn(r["max_cameras"]),
    max_users: nn(r["max_users"]),
    created_at: s(r["created_at"]),
  };
}
