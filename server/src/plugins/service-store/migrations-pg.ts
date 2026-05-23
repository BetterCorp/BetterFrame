/**
 * PostgreSQL-specific migrations.
 *
 * Two sets:
 *   1. PUBLIC schema — tenant registry, global admin, runs ONCE.
 *   2. PER-TENANT schema — full BetterFrame table set, runs for each tenant.
 *
 * Key differences from SQLite migrations:
 *   - SERIAL / BIGSERIAL instead of AUTOINCREMENT
 *   - No STRICT keyword
 *   - now() instead of strftime
 *   - TEXT works the same (PG TEXT = unbounded)
 *   - JSON stored as JSONB for indexing
 *   - Boolean is native BOOLEAN, not INTEGER
 *
 * Migration tracking: schema_migrations table in each schema records
 * which version has been applied. Same PRAGMA user_version concept
 * but in a table since PG has no per-schema PRAGMA.
 */

/** Public schema: tenant registry. */
export const PUBLIC_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    schema_name TEXT NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT true,
    max_kiosks INTEGER,
    max_cameras INTEGER,
    max_users INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS global_admins (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS schema_migrations (
    schema_name TEXT NOT NULL,
    version INTEGER NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (schema_name, version)
  )`,
];

/**
 * Per-tenant schema: full BetterFrame table set.
 * These run inside SET search_path = tenant_<id>.
 *
 * Mirrors the SQLite migrations but with PG-native types.
 * Each entry is a single SQL statement (no functions like SQLite's
 * addColumnIfNotExists — PG has IF NOT EXISTS on ALTER TABLE ADD COLUMN
 * natively via DO $$ blocks).
 */
export const TENANT_MIGRATIONS: readonly string[] = [
  // ---- users ---------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'operator' CHECK(role IN ('admin', 'operator')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    totp_enabled BOOLEAN NOT NULL DEFAULT false,
    totp_secret_encrypted TEXT,
    recovery_codes_hashed JSONB NOT NULL DEFAULT '[]',
    must_change_password BOOLEAN NOT NULL DEFAULT false,
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  // ---- sessions ------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    totp_pending BOOLEAN NOT NULL DEFAULT false,
    user_agent TEXT,
    ip_address TEXT,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,

  // ---- api_keys ------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    scopes JSONB NOT NULL DEFAULT '[]',
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    last_used_ip TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix)`,

  // ---- setup_state ---------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS setup_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    is_complete BOOLEAN NOT NULL DEFAULT false,
    cluster_key_provisioned BOOLEAN NOT NULL DEFAULT false,
    nodered_flows_deployed BOOLEAN NOT NULL DEFAULT false,
    completed_at TIMESTAMPTZ,
    extras JSONB NOT NULL DEFAULT '{}'
  )`,
  `INSERT INTO setup_state (id) VALUES (1) ON CONFLICT DO NOTHING`,

  // ---- displays ------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS displays (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    "index" INTEGER NOT NULL UNIQUE,
    is_primary BOOLEAN NOT NULL DEFAULT false,
    kiosk_id INTEGER,
    width_px INTEGER NOT NULL DEFAULT 1920,
    height_px INTEGER NOT NULL DEFAULT 1080,
    default_layout_id INTEGER,
    idle_timeout_seconds INTEGER NOT NULL DEFAULT 600,
    sleep_timeout_seconds INTEGER NOT NULL DEFAULT 1800,
    cec_enabled BOOLEAN NOT NULL DEFAULT true,
    cec_device_path TEXT,
    cec_logical_address INTEGER,
    desired_power_state TEXT NOT NULL DEFAULT 'follow_layout',
    actual_power_state TEXT NOT NULL DEFAULT 'unknown',
    actual_power_state_at TIMESTAMPTZ,
    state_check_enabled BOOLEAN NOT NULL DEFAULT false,
    state_check_interval_seconds INTEGER NOT NULL DEFAULT 60,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    active_layout_id INTEGER
  )`,

  // ---- cameras -------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS cameras (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('rtsp', 'onvif')),
    rtsp_url TEXT,
    onvif_host TEXT,
    onvif_port INTEGER,
    onvif_username TEXT,
    onvif_password TEXT,
    capabilities JSONB NOT NULL DEFAULT '[]',
    stream_policy TEXT NOT NULL DEFAULT 'auto' CHECK(stream_policy IN ('auto', 'always_main', 'always_sub')),
    enabled BOOLEAN NOT NULL DEFAULT true,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_source TEXT NOT NULL DEFAULT 'auto',
    event_sink TEXT NOT NULL DEFAULT 'auto',
    supported_event_topics JSONB NOT NULL DEFAULT '[]'
  )`,

  `CREATE TABLE IF NOT EXISTS camera_streams (
    id SERIAL PRIMARY KEY,
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
    is_discovered BOOLEAN NOT NULL DEFAULT false
  )`,
  `CREATE INDEX IF NOT EXISTS idx_camera_streams_camera ON camera_streams(camera_id)`,

  // ---- kiosks --------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS kiosks (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    capabilities JSONB NOT NULL DEFAULT '[]',
    hardware_model TEXT,
    os_version TEXT,
    kiosk_app_version TEXT,
    enabled BOOLEAN NOT NULL DEFAULT true,
    paired_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    last_bundle_version TEXT,
    display_id INTEGER REFERENCES displays(id) ON DELETE SET NULL,
    cpu_temp_c REAL,
    cpu_load_percent REAL,
    fan_rpm INTEGER,
    fan_pwm INTEGER,
    memory_total_mb INTEGER,
    memory_used_mb INTEGER,
    disk_total_mb INTEGER,
    disk_free_mb INTEGER,
    disk_used_percent REAL,
    firmware_channel TEXT NOT NULL DEFAULT 'stable',
    firmware_target_version TEXT,
    firmware_last_attempt_at TIMESTAMPTZ,
    firmware_last_attempt_version TEXT,
    firmware_last_error TEXT,
    local_key TEXT,
    local_port INTEGER,
    local_last_ip TEXT,
    reported_hostname TEXT,
    network_interfaces_json JSONB,
    managed_image BOOLEAN NOT NULL DEFAULT false,
    managed_config_json JSONB,
    managed_config_version INTEGER NOT NULL DEFAULT 0,
    managed_config_applied_version INTEGER NOT NULL DEFAULT 0,
    managed_config_applied_at TIMESTAMPTZ,
    managed_config_error TEXT,
    os_update_channel TEXT NOT NULL DEFAULT 'stable',
    os_update_target_version TEXT,
    os_update_last_attempt_at TIMESTAMPTZ,
    os_update_last_attempt_version TEXT,
    os_update_last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kiosks_prefix ON kiosks(key_prefix)`,

  // ---- layouts + templates + cells -----------------------------------------
  `CREATE TABLE IF NOT EXISTS layout_templates (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    regions JSONB NOT NULL DEFAULT '[]',
    grid_cols INTEGER NOT NULL DEFAULT 12,
    grid_rows INTEGER NOT NULL DEFAULT 12,
    is_builtin BOOLEAN NOT NULL DEFAULT false
  )`,

  `CREATE TABLE IF NOT EXISTS layouts (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    template_id INTEGER NOT NULL REFERENCES layout_templates(id),
    display_id INTEGER NOT NULL REFERENCES displays(id),
    priority TEXT NOT NULL DEFAULT 'normal',
    cooling_timeout_seconds INTEGER,
    preload_camera_ids JSONB NOT NULL DEFAULT '[]',
    is_default BOOLEAN NOT NULL DEFAULT false,
    resets_idle_timer BOOLEAN NOT NULL DEFAULT true
  )`,

  `CREATE TABLE IF NOT EXISTS layout_cells (
    id SERIAL PRIMARY KEY,
    layout_id INTEGER NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    region_name TEXT NOT NULL,
    "row" INTEGER NOT NULL DEFAULT 0,
    col INTEGER NOT NULL DEFAULT 0,
    row_span INTEGER NOT NULL DEFAULT 1,
    col_span INTEGER NOT NULL DEFAULT 1,
    content_type TEXT NOT NULL CHECK(content_type IN ('none', 'camera', 'web', 'html')),
    camera_id INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
    stream_selector TEXT NOT NULL DEFAULT 'auto',
    web_url TEXT,
    html_content TEXT,
    cooling_timeout_seconds INTEGER,
    options JSONB NOT NULL DEFAULT '{}',
    entity_id INTEGER,
    fit TEXT NOT NULL DEFAULT 'cover'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_layout_cells_layout ON layout_cells(layout_id)`,

  // ---- labels --------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS labels (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    color TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS kiosk_labels (
    kiosk_id INTEGER NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('consume', 'operate')),
    PRIMARY KEY (kiosk_id, label_id, role)
  )`,
  `CREATE TABLE IF NOT EXISTS camera_labels (
    camera_id INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (camera_id, label_id)
  )`,
  `CREATE TABLE IF NOT EXISTS layout_labels (
    layout_id INTEGER NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (layout_id, label_id)
  )`,

  // ---- pairing codes -------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS pairing_codes (
    code TEXT PRIMARY KEY,
    kiosk_proposed_name TEXT,
    kiosk_hardware_model TEXT,
    kiosk_capabilities JSONB NOT NULL DEFAULT '[]',
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    consumed_by_kiosk_id INTEGER,
    extras JSONB NOT NULL DEFAULT '{}'
  )`,

  // ---- event_log -----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS event_log (
    id SERIAL PRIMARY KEY,
    source_kiosk_id INTEGER,
    source_camera_id INTEGER,
    source_type TEXT NOT NULL DEFAULT 'system',
    topic TEXT NOT NULL,
    property_op TEXT,
    payload JSONB NOT NULL DEFAULT '{}',
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    forwarded_to_nodered BOOLEAN NOT NULL DEFAULT false
  )`,
  `CREATE INDEX IF NOT EXISTS idx_event_log_topic ON event_log(topic, received_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_event_log_camera ON event_log(source_camera_id, received_at DESC)`,

  // ---- firmware releases + rollouts ----------------------------------------
  `CREATE TABLE IF NOT EXISTS firmware_releases (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('stable', 'beta', 'dev')),
    arch TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    signature TEXT NOT NULL,
    release_notes TEXT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    uploaded_by INTEGER,
    yanked_at TIMESTAMPTZ
  )`,

  `CREATE TABLE IF NOT EXISTS firmware_rollouts (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL REFERENCES firmware_releases(id) ON DELETE CASCADE,
    target_kiosk_ids JSONB NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'queued',
    percentage INTEGER NOT NULL DEFAULT 100,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by INTEGER
  )`,

  // ---- OS update releases + rollouts --------------------------------------
  `CREATE TABLE IF NOT EXISTS os_update_releases (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('stable', 'beta', 'dev')),
    compatibility TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    bundle_format TEXT NOT NULL DEFAULT 'raucb',
    release_notes TEXT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    uploaded_by INTEGER,
    yanked_at TIMESTAMPTZ,
    UNIQUE(version, compatibility)
  )`,

  `CREATE TABLE IF NOT EXISTS os_update_rollouts (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL REFERENCES os_update_releases(id) ON DELETE CASCADE,
    target_kiosk_ids JSONB NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'queued',
    percentage INTEGER NOT NULL DEFAULT 100,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by INTEGER
  )`,

  // ---- audit_log -----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'api_key', 'system', 'kiosk')),
    actor_id INTEGER,
    actor_label TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    ip TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    result TEXT NOT NULL DEFAULT 'ok' CHECK(result IN ('ok', 'failed'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, ts DESC)`,

  // ---- entities ------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS entities (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('camera', 'html', 'web', 'dashboard')),
    description TEXT,
    camera_id INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
    html_content TEXT,
    web_url TEXT,
    dashboard_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  // ---- GPIO bindings -------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS kiosk_gpio_bindings (
    id SERIAL PRIMARY KEY,
    kiosk_id INTEGER NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
    chip TEXT NOT NULL DEFAULT 'gpiochip4',
    pin INTEGER NOT NULL,
    direction TEXT NOT NULL DEFAULT 'in',
    pull TEXT,
    edge TEXT,
    topic TEXT NOT NULL,
    UNIQUE(kiosk_id, chip, pin)
  )`,

  // ---- kiosk_logs ----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS kiosk_logs (
    id SERIAL PRIMARY KEY,
    kiosk_id INTEGER NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
    level TEXT NOT NULL CHECK(level IN ('debug', 'info', 'warn', 'error')),
    message TEXT NOT NULL,
    context JSONB NOT NULL DEFAULT '{}',
    logged_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kiosk_logs_kiosk ON kiosk_logs(kiosk_id, received_at DESC)`,

  // ---- cloud_accounts -------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS cloud_accounts (
    id TEXT PRIMARY KEY,
    vendor TEXT NOT NULL,
    name TEXT NOT NULL,
    credentials_encrypted TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_sync_at TIMESTAMPTZ,
    last_sync_error TEXT,
    camera_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cloud_accounts_vendor ON cloud_accounts(vendor)`,
];
