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
export type CellContentType = "camera" | "web" | "html";
export type DesiredPowerState = "follow_layout" | "on" | "standby";
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
  state_check_enabled: boolean;
  state_check_interval_seconds: number;
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
  regions: LayoutRegion[];
  grid_cols: number;
  grid_rows: number;
  display_id: number;
  priority: LayoutPriority;
  cooling_timeout_seconds: number | null;
  preload_camera_ids: number[];
  is_default: boolean;
  resets_idle_timer: boolean;
}

export interface LayoutCell {
  id: number;
  layout_id: number;
  region_name: string;
  content_type: CellContentType;
  camera_id: number | null;
  stream_selector: StreamSelector;
  web_url: string | null;
  html_content: string | null;
  cooling_timeout_seconds: number | null;
  options: Record<string, unknown>;
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
  created_at: string;
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
