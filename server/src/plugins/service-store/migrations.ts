/**
 * Database migrations.
 *
 * Idempotent — `service-store.init()` runs ALL of these on every startup,
 * inside one transaction. SQLite tolerates `IF NOT EXISTS` everywhere we
 * need it. When schemas change non-additively, we'll graduate to a real
 * versioned migrator; for v0.1 this is sufficient.
 *
 * NOTE on datetimes: stored as TEXT in ISO-8601 UTC ("YYYY-MM-DDTHH:MM:SS.sssZ").
 * Application code uses `new Date().toISOString()` for writes and
 * `new Date(value)` for reads. No tz-aware datetime gotcha because TEXT is
 * pure string round-trip. (Old python build hit a pain point with
 * SQLAlchemy's DateTime adapter — we avoid the whole class of issue here.)
 */

export const MIGRATIONS: readonly string[] = [
  // ---- users ---------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'operator' CHECK(role IN ('admin', 'operator')),
    is_active INTEGER NOT NULL DEFAULT 1,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    totp_secret_encrypted TEXT,
    recovery_codes_hashed TEXT NOT NULL DEFAULT '[]',
    must_change_password INTEGER NOT NULL DEFAULT 0,
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT`,

  // ---- sessions ------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    totp_pending INTEGER NOT NULL DEFAULT 0,
    user_agent TEXT,
    ip_address TEXT,
    issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  ) STRICT`,

  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_active
    ON sessions(expires_at)
    WHERE revoked_at IS NULL`,

  // ---- api_keys ------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]',
    expires_at TEXT,
    last_used_at TEXT,
    last_used_ip TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    revoked_at TEXT
  ) STRICT`,

  `CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix)`,

  // ---- setup_state (singleton row, id=1) -----------------------------------
  `CREATE TABLE IF NOT EXISTS setup_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    is_complete INTEGER NOT NULL DEFAULT 0,
    cluster_key_provisioned INTEGER NOT NULL DEFAULT 0,
    nodered_flows_deployed INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    extras TEXT NOT NULL DEFAULT '{}'
  ) STRICT`,
  `INSERT OR IGNORE INTO setup_state (id) VALUES (1)`,

  // ---- displays ------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS displays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    "index" INTEGER NOT NULL UNIQUE,
    is_primary INTEGER NOT NULL DEFAULT 0,
    width_px INTEGER NOT NULL DEFAULT 1920,
    height_px INTEGER NOT NULL DEFAULT 1080,
    default_layout_id INTEGER,
    idle_timeout_seconds INTEGER NOT NULL DEFAULT 600,
    sleep_timeout_seconds INTEGER NOT NULL DEFAULT 1800,
    cec_enabled INTEGER NOT NULL DEFAULT 1,
    cec_device_path TEXT,
    cec_logical_address INTEGER,
    desired_power_state TEXT NOT NULL DEFAULT 'follow_layout'
      CHECK(desired_power_state IN ('follow_layout', 'on', 'standby')),
    state_check_enabled INTEGER NOT NULL DEFAULT 0,
    state_check_interval_seconds INTEGER NOT NULL DEFAULT 60
  ) STRICT`,

  // ---- cameras -------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS cameras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('rtsp', 'onvif')),
    rtsp_url TEXT,
    onvif_host TEXT,
    onvif_port INTEGER,
    onvif_username TEXT,
    onvif_password TEXT,
    capabilities TEXT NOT NULL DEFAULT '[]',
    stream_policy TEXT NOT NULL DEFAULT 'auto'
      CHECK(stream_policy IN ('auto', 'always_main', 'always_sub')),
    enabled INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT`,

  `CREATE TABLE IF NOT EXISTS camera_streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('main', 'sub', 'other')),
    name TEXT NOT NULL,
    profile_token TEXT,
    rtsp_uri TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    encoding TEXT,
    framerate REAL,
    bitrate_kbps INTEGER,
    is_discovered INTEGER NOT NULL DEFAULT 0
  ) STRICT`,

  `CREATE INDEX IF NOT EXISTS idx_camera_streams_camera ON camera_streams(camera_id)`,

  // ---- layout templates + layouts + cells ----------------------------------
  `CREATE TABLE IF NOT EXISTS layout_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    regions TEXT NOT NULL DEFAULT '[]',
    grid_cols INTEGER NOT NULL DEFAULT 12,
    grid_rows INTEGER NOT NULL DEFAULT 12,
    is_builtin INTEGER NOT NULL DEFAULT 0
  ) STRICT`,

  `CREATE TABLE IF NOT EXISTS layouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    template_id INTEGER NOT NULL REFERENCES layout_templates(id),
    display_id INTEGER NOT NULL REFERENCES displays(id),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('hot', 'normal', 'cold')),
    cooling_timeout_seconds INTEGER,
    preload_camera_ids TEXT NOT NULL DEFAULT '[]',
    is_default INTEGER NOT NULL DEFAULT 0,
    resets_idle_timer INTEGER NOT NULL DEFAULT 1
  ) STRICT`,

  `CREATE TABLE IF NOT EXISTS layout_cells (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    layout_id INTEGER NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    region_name TEXT NOT NULL,
    content_type TEXT NOT NULL CHECK(content_type IN ('camera', 'web', 'html')),
    camera_id INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
    stream_selector TEXT NOT NULL DEFAULT 'auto'
      CHECK(stream_selector IN ('auto', 'main', 'sub')),
    web_url TEXT,
    html_content TEXT,
    cooling_timeout_seconds INTEGER,
    options TEXT NOT NULL DEFAULT '{}'
  ) STRICT`,

  `CREATE INDEX IF NOT EXISTS idx_layout_cells_layout ON layout_cells(layout_id)`,

  // ---- kiosks --------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS kiosks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    capabilities TEXT NOT NULL DEFAULT '[]',
    hardware_model TEXT,
    os_version TEXT,
    kiosk_app_version TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    paired_at TEXT,
    last_seen_at TEXT,
    last_bundle_version TEXT,
    display_id INTEGER REFERENCES displays(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT`,

  `CREATE INDEX IF NOT EXISTS idx_kiosks_prefix ON kiosks(key_prefix)`,

  // ---- labels --------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    color TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT`,

  `CREATE TABLE IF NOT EXISTS kiosk_labels (
    kiosk_id INTEGER NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('consume', 'operate')),
    PRIMARY KEY (kiosk_id, label_id, role)
  ) STRICT`,

  `CREATE TABLE IF NOT EXISTS camera_labels (
    camera_id INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (camera_id, label_id)
  ) STRICT`,

  `CREATE TABLE IF NOT EXISTS layout_labels (
    layout_id INTEGER NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (layout_id, label_id)
  ) STRICT`,

  // ---- pairing_codes -------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS pairing_codes (
    code TEXT PRIMARY KEY,
    kiosk_proposed_name TEXT,
    kiosk_hardware_model TEXT,
    kiosk_capabilities TEXT NOT NULL DEFAULT '[]',
    issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    consumed_by_kiosk_id INTEGER REFERENCES kiosks(id) ON DELETE SET NULL,
    extras TEXT NOT NULL DEFAULT '{}'
  ) STRICT`,

  // ---- event_log -----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_kiosk_id INTEGER REFERENCES kiosks(id) ON DELETE SET NULL,
    source_camera_id INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('onvif', 'gpio', 'synthetic', 'system')),
    topic TEXT NOT NULL,
    property_op TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    forwarded_to_nodered INTEGER NOT NULL DEFAULT 0
  ) STRICT`,

  `CREATE INDEX IF NOT EXISTS idx_event_log_received ON event_log(received_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_event_log_topic ON event_log(topic, received_at DESC)`,
];
