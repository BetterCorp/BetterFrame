/**
 * Cross-plugin types. Lives outside `plugins/` so any service can import.
 *
 * Domain types here mirror the SQL schema. Keep field names snake_case in the
 * DB, camelCase on the wire/UI. Translation happens in service-store.
 */

export type UserRole = "admin" | "operator";
export type ApiKeyScope = "read" | "control" | "admin";
export type CameraType = "rtsp" | "onvif";
export type StreamRole = "main" | "sub" | "other";
export type StreamSelector = "auto" | "main" | "sub";
export type StreamPolicy = "auto" | "always_main" | "always_sub";
export type LayoutPriority = "hot" | "normal" | "cold";
export type CellContentType = "none" | "camera" | "web" | "html";
export type EntityType = "camera" | "html" | "web" | "dashboard";

export interface Entity {
  id: number;
  name: string;
  type: EntityType;
  description: string | null;
  camera_id: number | null;
  html_content: string | null;
  web_url: string | null;
  /** Node-RED dashboard tab id; populated when type === "dashboard". */
  dashboard_id: string | null;
  created_at: string;
}
export type DesiredPowerState = "follow_layout" | "on" | "standby";
export type ActualPowerState = "awake" | "standby" | "unknown";
export type LabelRole = "consume" | "operate";
export type EventSourceType = "onvif" | "gpio" | "synthetic" | "system";

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: UserRole;
  is_active: boolean;
  totp_enabled: boolean;
  totp_secret_encrypted: string | null;
  recovery_codes_hashed: string[]; // each element argon2-hashed
  must_change_password: boolean;
  failed_login_count: number;
  locked_until: string | null; // ISO 8601
  last_login_at: string | null;
  created_at: string;
}

export interface Session {
  id: string; // hex32
  user_id: number;
  csrf_token: string;
  totp_pending: boolean;
  user_agent: string | null;
  ip_address: string | null;
  issued_at: string;
  last_seen_at: string;
  expires_at: string; // absolute (30d max)
  revoked_at: string | null;
}

export interface ApiKey {
  id: number;
  name: string;
  key_hash: string;
  key_prefix: string; // indexed for O(1) lookup
  scopes: ApiKeyScope[];
  expires_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface SetupState {
  id: 1;
  is_complete: boolean;
  cluster_key_provisioned: boolean;
  nodered_flows_deployed: boolean;
  completed_at: string | null;
  extras: Record<string, unknown>;
}

export interface Display {
  id: number;
  name: string;
  index: number; // unique
  is_primary: boolean; // deprecated — kept for backward compat, not used
  kiosk_id: number | null; // FK → kiosks; displays belong to kiosks
  width_px: number;
  height_px: number;
  default_layout_id: number | null;
  idle_timeout_seconds: number;
  sleep_timeout_seconds: number;
  cec_enabled: boolean;
  cec_device_path: string | null;
  cec_logical_address: number | null;
  desired_power_state: DesiredPowerState;
  actual_power_state: ActualPowerState;
  actual_power_state_at: string | null;
  state_check_enabled: boolean;
  state_check_interval_seconds: number;
  is_enabled: boolean;
  active_layout_id: number | null;
}

export interface Camera {
  id: number;
  name: string;
  type: CameraType;
  rtsp_url: string | null;
  onvif_host: string | null;
  onvif_port: number | null;
  onvif_username: string | null;
  onvif_password: string | null; // fernet-encrypted ciphertext
  capabilities: string[];
  stream_policy: StreamPolicy;
  enabled: boolean;
  last_seen_at: string | null;
  created_at: string;
}

export interface CameraStream {
  id: number;
  camera_id: number;
  role: StreamRole;
  name: string;
  profile_token: string | null;
  rtsp_uri: string;
  width: number | null;
  height: number | null;
  encoding: string | null;
  framerate: number | null;
  bitrate_kbps: number | null;
  is_discovered: boolean;
}

export interface LayoutTemplate {
  id: number;
  name: string;
  description: string | null;
  regions: LayoutRegion[];
  grid_cols: number;
  grid_rows: number;
  is_builtin: boolean;
}

export interface LayoutRegion {
  name: string;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

export interface Layout {
  id: number;
  name: string;
  description: string | null;
  template_id: number | null; // deprecated — kept nullable for backward compat
  /** @deprecated Cells now own their own position. Computed from cells at read time. */
  regions: LayoutRegion[];
  /** @deprecated Computed from cells: max(col + col_span). */
  grid_cols: number;
  /** @deprecated Computed from cells: max(row + row_span). */
  grid_rows: number;
  /** @deprecated Layouts are now standalone; use display_layouts join table.
   *  Column kept on the row for backward compat — will be removed in a future migration. */
  display_id: number | null;
  priority: LayoutPriority;
  cooling_timeout_seconds: number | null;
  preload_camera_ids: number[];
  /** @deprecated Per-display defaults live on `display.default_layout_id`. */
  is_default: boolean;
  resets_idle_timer: boolean;
}

export interface LayoutCell {
  id: number;
  layout_id: number;
  /** @deprecated Cells own their position via row/col/row_span/col_span now. */
  region_name: string;
  row: number;
  col: number;
  row_span: number;
  col_span: number;
  content_type: CellContentType;
  camera_id: number | null;
  stream_selector: StreamSelector;
  web_url: string | null;
  html_content: string | null;
  cooling_timeout_seconds: number | null;
  options: Record<string, unknown>;
  entity_id: number | null;
  fit: "cover" | "contain" | "fill";
}

export interface Kiosk {
  id: number;
  name: string;
  description: string | null;
  key_hash: string;
  key_prefix: string;
  capabilities: string[];
  hardware_model: string | null;
  os_version: string | null;
  kiosk_app_version: string | null;
  enabled: boolean;
  paired_at: string | null;
  last_seen_at: string | null;
  last_bundle_version: string | null;
  display_id: number | null; // deprecated — displays now point to kiosks via kiosk_id
  cpu_temp_c: number | null;
  cpu_load_percent: number | null;
  fan_rpm: number | null;
  fan_pwm: number | null;
  memory_total_mb: number | null;
  memory_used_mb: number | null;
  disk_total_mb: number | null;
  disk_free_mb: number | null;
  disk_used_percent: number | null;
  firmware_channel: FirmwareChannel;
  firmware_target_version: string | null;
  firmware_last_attempt_at: string | null;
  firmware_last_attempt_version: string | null;
  firmware_last_error: string | null;
  os_update_channel: FirmwareChannel;
  os_update_target_version: string | null;
  os_update_last_attempt_at: string | null;
  os_update_last_attempt_version: string | null;
  os_update_last_error: string | null;
  local_key: string | null;
  local_port: number | null;
  local_last_ip: string | null;
  reported_hostname: string | null;
  network_interfaces_json: string | null;
  // Managed-image device config. Only meaningful when managed_image=true; for
  // BYO-OS kiosks these fields stay at defaults and the admin UI hides them.
  managed_image: boolean;
  managed_config_json: string | null; // serialized ManagedConfig payload
  managed_config_version: number; // server-side, bumps on each save
  managed_config_applied_version: number; // echoed by kiosk after successful apply
  managed_config_applied_at: string | null;
  managed_config_error: string | null;
  created_at: string;
}

export type AuditActorType = "user" | "api_key" | "system" | "kiosk";
export type AuditResult = "ok" | "failed";

export interface AuditEntry {
  id: number;
  ts: string;
  actor_type: AuditActorType;
  actor_id: number | null;
  actor_label: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  result: AuditResult;
}

export type FirmwareChannel = "stable" | "beta" | "dev";
export type FirmwareRolloutState = "queued" | "active" | "paused" | "complete";
export type OsUpdateRolloutState = FirmwareRolloutState;

export interface FirmwareRelease {
  id: string;
  version: string;
  channel: FirmwareChannel;
  arch: string;
  artifact_path: string;
  size_bytes: number;
  sha256: string;
  signature: string;
  release_notes: string | null;
  uploaded_at: string;
  uploaded_by: number | null;
  yanked_at: string | null;
}

export interface FirmwareRollout {
  id: string;
  release_id: string;
  target_kiosk_ids: number[];
  state: FirmwareRolloutState;
  percentage: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  created_by: number | null;
}

export interface OsUpdateRelease {
  id: string;
  version: string;
  channel: FirmwareChannel;
  compatibility: string;
  artifact_path: string;
  size_bytes: number;
  sha256: string;
  bundle_format: "raucb";
  release_notes: string | null;
  uploaded_at: string;
  uploaded_by: number | null;
  yanked_at: string | null;
}

export interface OsUpdateRollout {
  id: string;
  release_id: string;
  target_kiosk_ids: number[];
  state: OsUpdateRolloutState;
  percentage: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  created_by: number | null;
}

export interface Label {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
}

export interface KioskLabel {
  kiosk_id: number;
  label_id: number;
  role: LabelRole;
}

export interface PairingCode {
  code: string;
  kiosk_proposed_name: string | null;
  kiosk_hardware_model: string | null;
  kiosk_capabilities: string[];
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_by_kiosk_id: number | null;
  extras: Record<string, unknown>;
}

export type GpioDirection = "in" | "out";
export type GpioPull = "up" | "down" | "none";
export type GpioEdge = "rising" | "falling" | "both";

export interface KioskGpioBinding {
  id: number;
  kiosk_id: number;
  chip: string;
  pin: number;
  direction: GpioDirection;
  pull: GpioPull | null;
  edge: GpioEdge | null;
  topic: string;
  created_at: string;
}

export interface EventLog {
  id: number;
  source_kiosk_id: number | null;
  source_camera_id: number | null;
  source_type: EventSourceType;
  topic: string;
  property_op: string | null;
  payload: Record<string, unknown>;
  received_at: string;
  forwarded_to_nodered: boolean;
}

export interface EventQueryFilters {
  topic?: string;
  kiosk_id?: number;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export type KioskLogLevel = "debug" | "info" | "warn" | "error";

export interface KioskLog {
  id: number;
  kiosk_id: number;
  level: KioskLogLevel;
  message: string;
  context: Record<string, unknown>;
  logged_at: string;
  received_at: string;
}

export interface KioskLogQueryFilters {
  kiosk_id: number;
  level?: KioskLogLevel;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}
