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
 * IMPORTANT: These create the FINAL schema (matching SQLite after all
 * migrations have run). Do not include legacy columns that were dropped.
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
    id TEXT NOT NULL PRIMARY KEY,
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

  `CREATE TABLE IF NOT EXISTS iobox_models (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    hardware_variant TEXT NOT NULL CHECK(hardware_variant IN ('wifi', 'ethernet')),
    firmware_arch TEXT NOT NULL DEFAULT 'esp32s3',
    firmware_track TEXT NOT NULL DEFAULT 'stable',
    capabilities_json JSONB NOT NULL DEFAULT '{}',
    ports_json JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS iobox_serials (
    serial TEXT PRIMARY KEY,
    model_id TEXT NOT NULL REFERENCES iobox_models(id) ON DELETE RESTRICT,
    notes TEXT,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    paired_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
    paired_iobox_id TEXT,
    last_seen_at TIMESTAMPTZ
  )`,

  `INSERT INTO iobox_models
    (id, name, description, hardware_variant, firmware_arch, firmware_track, capabilities_json, ports_json)
   VALUES
    ('ioBOX-WIFI', 'ioBOX Wi-Fi', 'ESP32-S3 Wi-Fi ioBOX base firmware target.', 'wifi', 'esp32s3', 'stable',
      '{"keyboard":true,"mouse":true,"usb_hid":true,"wifi_provisioning":true}'::jsonb,
      '[{"id":"usb_otg","label":"USB OTG","kind":"usb_hid","direction":"input"}]'::jsonb),
    ('ioBOX-ETHERNET', 'ioBOX Ethernet', 'ESP32-S3 ioBOX base firmware target with W5500 Ethernet.', 'ethernet', 'esp32s3', 'stable',
      '{"keyboard":true,"mouse":true,"usb_hid":true,"ethernet":true,"wifi_provisioning":true}'::jsonb,
      '[{"id":"usb_otg","label":"USB OTG","kind":"usb_hid","direction":"input"},{"id":"eth0","label":"W5500 Ethernet","kind":"ethernet","direction":"bidirectional"}]'::jsonb)
   ON CONFLICT (id) DO NOTHING`,

  `INSERT INTO iobox_models
    (id, name, description, hardware_variant, firmware_arch, firmware_track, capabilities_json, ports_json)
   VALUES
    ('ioBOX-WIFI', 'ioBOX Wi-Fi', 'ESP32-S3 Wi-Fi ioBOX base firmware target.', 'wifi', 'esp32s3', 'stable',
      '{"keyboard":true,"mouse":true,"usb_hid":true,"wifi_provisioning":true}'::jsonb,
      '[{"id":"usb_otg","label":"USB OTG","kind":"usb_hid","direction":"input"}]'::jsonb),
    ('ioBOX-ETHERNET', 'ioBOX Ethernet', 'ESP32-S3 ioBOX base firmware target with W5500 Ethernet.', 'ethernet', 'esp32s3', 'stable',
      '{"keyboard":true,"mouse":true,"usb_hid":true,"ethernet":true,"wifi_provisioning":true}'::jsonb,
      '[{"id":"usb_otg","label":"USB OTG","kind":"usb_hid","direction":"input"},{"id":"eth0","label":"W5500 Ethernet","kind":"ethernet","direction":"bidirectional"}]'::jsonb)
   ON CONFLICT (id) DO NOTHING`,
  `UPDATE iobox_serials SET model_id = 'ioBOX-WIFI' WHERE model_id = 'ioBOX-KB'`,
  `UPDATE iobox_serials SET model_id = 'ioBOX-ETHERNET' WHERE model_id = 'ioBOX-KB-E'`,
  `DELETE FROM iobox_models WHERE id IN ('ioBOX-KB', 'ioBOX-KB-E')`,
];

/**
 * Per-tenant schema: full BetterFrame table set.
 * These run inside SET search_path = tenant_<id>.
 *
 * Mirrors the FINAL SQLite schema (after all migrations) with PG-native types.
 */
export const TENANT_MIGRATIONS: readonly string[] = [
  // ---- users ---------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT NOT NULL PRIMARY KEY,
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
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
  `CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(expires_at) WHERE revoked_at IS NULL`,

  // ---- api_keys ------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT NOT NULL PRIMARY KEY,
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

  // ---- displays (final schema — no UNIQUE on index, has kiosk_id) ----------
  `CREATE TABLE IF NOT EXISTS displays (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT false,
    kiosk_id TEXT,
    width_px INTEGER NOT NULL DEFAULT 1920,
    height_px INTEGER NOT NULL DEFAULT 1080,
    default_layout_id TEXT,
    idle_timeout_seconds INTEGER NOT NULL DEFAULT 600,
    sleep_timeout_seconds INTEGER NOT NULL DEFAULT 1800,
    cec_enabled BOOLEAN NOT NULL DEFAULT true,
    cec_device_path TEXT,
    cec_logical_address INTEGER,
    desired_power_state TEXT NOT NULL DEFAULT 'follow_layout'
      CHECK(desired_power_state IN ('follow_layout', 'on', 'standby')),
    actual_power_state TEXT NOT NULL DEFAULT 'unknown'
      CHECK(actual_power_state IN ('awake', 'standby', 'unknown')),
    actual_power_state_at TIMESTAMPTZ,
    state_check_enabled BOOLEAN NOT NULL DEFAULT false,
    state_check_interval_seconds INTEGER NOT NULL DEFAULT 60,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    active_layout_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_displays_kiosk ON displays(kiosk_id)`,
  `CREATE INDEX IF NOT EXISTS idx_displays_kiosk_index ON displays(kiosk_id, "index")`,

  // ---- cameras -------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS cameras (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('rtsp', 'onvif', 'cloud')),
    rtsp_url TEXT,
    onvif_host TEXT,
    onvif_port INTEGER,
    onvif_username TEXT,
    onvif_password TEXT,
    capabilities JSONB NOT NULL DEFAULT '[]',
    stream_policy TEXT NOT NULL DEFAULT 'auto'
      CHECK(stream_policy IN ('auto', 'always_main', 'always_sub')),
    enabled BOOLEAN NOT NULL DEFAULT true,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_source TEXT NOT NULL DEFAULT 'auto',
    event_sink TEXT NOT NULL DEFAULT 'auto',
    supported_event_topics JSONB NOT NULL DEFAULT '[]',
    cloud_account_id TEXT,
    cloud_vendor_camera_id TEXT,
    cloud_stream_url TEXT,
    cloud_stream_type TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cameras_cloud_account ON cameras(cloud_account_id)`,

  `CREATE TABLE IF NOT EXISTS camera_streams (
    id TEXT NOT NULL PRIMARY KEY,
    camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('main', 'sub', 'other')),
    name TEXT NOT NULL,
    profile_token TEXT,
    rtsp_uri TEXT NOT NULL,
    rtsp_host TEXT,
    rtsp_port INTEGER DEFAULT 554,
    rtsp_path TEXT,
    width INTEGER,
    height INTEGER,
    encoding TEXT,
    framerate REAL,
    bitrate_kbps INTEGER,
    is_discovered BOOLEAN NOT NULL DEFAULT false
  )`,
  `CREATE INDEX IF NOT EXISTS idx_camera_streams_camera ON camera_streams(camera_id)`,

  // ---- kiosks (final schema — all telemetry + update columns) --------------
  `CREATE TABLE IF NOT EXISTS kiosks (
    id TEXT NOT NULL PRIMARY KEY,
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
    display_id TEXT REFERENCES displays(id) ON DELETE SET NULL,
    encrypt_key_encrypted TEXT,
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
    logging_json JSONB,
    partitions_json JSONB,
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
    audio_default_volume_percent INTEGER NOT NULL DEFAULT 50,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kiosks_prefix ON kiosks(key_prefix)`,

  // ---- layouts (final schema — no template_id, no display_id) --------------
  `CREATE TABLE IF NOT EXISTS layouts (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('hot', 'normal', 'cold')),
    cooling_timeout_seconds INTEGER,
    idle_timeout_seconds INTEGER,
    preload_camera_ids JSONB NOT NULL DEFAULT '[]',
    resets_idle_timer BOOLEAN NOT NULL DEFAULT true
  )`,

  // ---- display_layouts (join table) ----------------------------------------
  `CREATE TABLE IF NOT EXISTS display_layouts (
    display_id TEXT NOT NULL REFERENCES displays(id) ON DELETE CASCADE,
    layout_id TEXT NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    PRIMARY KEY (display_id, layout_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_display_layouts_layout ON display_layouts(layout_id)`,

  // ---- layout_cells (final schema — no region_name) ------------------------
  `CREATE TABLE IF NOT EXISTS layout_cells (
    id TEXT NOT NULL PRIMARY KEY,
    layout_id TEXT NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    "row" INTEGER NOT NULL DEFAULT 0,
    col INTEGER NOT NULL DEFAULT 0,
    row_span INTEGER NOT NULL DEFAULT 1,
    col_span INTEGER NOT NULL DEFAULT 1,
    content_type TEXT NOT NULL CHECK(content_type IN ('none', 'camera', 'web', 'html')),
    camera_id TEXT REFERENCES cameras(id) ON DELETE SET NULL,
    stream_selector TEXT,
    web_url TEXT,
    html_content TEXT,
    cooling_timeout_seconds INTEGER,
    options JSONB NOT NULL DEFAULT '{}',
    entity_id TEXT,
    fit TEXT NOT NULL DEFAULT 'cover'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_layout_cells_layout ON layout_cells(layout_id)`,
  `CREATE INDEX IF NOT EXISTS idx_layout_cells_entity ON layout_cells(entity_id)`,

  // ---- labels --------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS labels (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    color TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS kiosk_labels (
    kiosk_id TEXT NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('consume', 'operate')),
    PRIMARY KEY (kiosk_id, label_id, role)
  )`,
  `CREATE TABLE IF NOT EXISTS camera_labels (
    camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (camera_id, label_id)
  )`,
  `CREATE TABLE IF NOT EXISTS layout_labels (
    layout_id TEXT NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
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
    consumed_by_kiosk_id TEXT REFERENCES kiosks(id) ON DELETE SET NULL,
    extras JSONB NOT NULL DEFAULT '{}'
  )`,

  // ---- event_log -----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS event_log (
    id TEXT NOT NULL PRIMARY KEY,
    source_kiosk_id TEXT REFERENCES kiosks(id) ON DELETE SET NULL,
    source_camera_id TEXT REFERENCES cameras(id) ON DELETE SET NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('onvif', 'gpio', 'synthetic', 'system')),
    topic TEXT NOT NULL,
    property_op TEXT,
    payload JSONB NOT NULL DEFAULT '{}',
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    forwarded_to_nodered BOOLEAN NOT NULL DEFAULT false
  )`,
  `CREATE INDEX IF NOT EXISTS idx_event_log_received ON event_log(received_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_event_log_topic ON event_log(topic, received_at DESC)`,

  // ---- entities ------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS entities (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('camera', 'html', 'web', 'dashboard')),
    description TEXT,
    camera_id TEXT REFERENCES cameras(id) ON DELETE CASCADE,
    html_content TEXT,
    web_url TEXT,
    dashboard_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entities_camera ON entities(camera_id)`,

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
    uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    yanked_at TIMESTAMPTZ,
    UNIQUE(version, arch)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_firmware_releases_channel ON firmware_releases(channel, arch, uploaded_at DESC)`,

  `CREATE TABLE IF NOT EXISTS firmware_rollouts (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL REFERENCES firmware_releases(id) ON DELETE CASCADE,
    target_kiosk_ids JSONB NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued', 'active', 'paused', 'complete')),
    percentage INTEGER NOT NULL DEFAULT 100 CHECK(percentage BETWEEN 1 AND 100),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_firmware_rollouts_state ON firmware_rollouts(state)`,

  // ---- OS update releases + rollouts --------------------------------------
  `CREATE TABLE IF NOT EXISTS os_update_releases (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('stable', 'beta', 'dev')),
    compatibility TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    bundle_format TEXT NOT NULL DEFAULT 'raucb' CHECK(bundle_format = 'raucb'),
    release_notes TEXT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    yanked_at TIMESTAMPTZ,
    UNIQUE(version, compatibility)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_os_update_releases_channel ON os_update_releases(channel, compatibility, uploaded_at DESC)`,

  `CREATE TABLE IF NOT EXISTS os_update_rollouts (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL REFERENCES os_update_releases(id) ON DELETE CASCADE,
    target_kiosk_ids JSONB NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued', 'active', 'paused', 'complete')),
    percentage INTEGER NOT NULL DEFAULT 100 CHECK(percentage BETWEEN 1 AND 100),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_os_update_rollouts_state ON os_update_rollouts(state)`,

  // ---- audit_log -----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT NOT NULL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'api_key', 'system', 'kiosk')),
    actor_id TEXT,
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
  `CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_type, actor_id, ts DESC)`,

  // ---- kiosk GPIO bindings -------------------------------------------------
  `CREATE TABLE IF NOT EXISTS kiosk_gpio_bindings (
    id TEXT NOT NULL PRIMARY KEY,
    kiosk_id TEXT NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
    chip TEXT NOT NULL DEFAULT 'gpiochip4',
    pin INTEGER NOT NULL,
    direction TEXT NOT NULL DEFAULT 'in' CHECK(direction IN ('in', 'out')),
    pull TEXT CHECK(pull IN ('up', 'down', 'none')),
    edge TEXT CHECK(edge IN ('rising', 'falling', 'both')),
    topic TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(kiosk_id, chip, pin)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kiosk_gpio_bindings_kiosk ON kiosk_gpio_bindings(kiosk_id)`,

  // ---- kiosk_logs ----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS kiosk_logs (
    id TEXT NOT NULL PRIMARY KEY,
    kiosk_id TEXT NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
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

  // ---- camera_event_subscriptions ---------------------------------------------
  `CREATE TABLE IF NOT EXISTS camera_event_subscriptions (
    id TEXT NOT NULL PRIMARY KEY,
    camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'inactive' CHECK(status IN ('inactive', 'pending', 'active', 'failed')),
    subscribed_by_kiosk_id TEXT REFERENCES kiosks(id) ON DELETE SET NULL,
    last_event_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(camera_id, topic)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_camera_event_subs_camera ON camera_event_subscriptions(camera_id)`,

  `ALTER TABLE kiosks ADD COLUMN IF NOT EXISTS partitions_json JSONB`,
  `ALTER TABLE kiosks ADD COLUMN IF NOT EXISTS logging_json JSONB`,

  // ---- UUIDv7 PK migration for existing databases ----
  // Databases created before UUIDv7 migration have INTEGER PKs.
  // This migration converts them to TEXT in-place. Safe to run on
  // databases that already have TEXT PKs (DO NOTHING on conflict).
  // gen_random_uuid() generates UUIDv4 — close enough for backfill.
  // New rows already use app-generated UUIDv7 from repository.ts.
  `CREATE OR REPLACE FUNCTION _bf_add_fk(
    src_table text, src_col text, ref_table text, ref_col text, on_del text
  ) RETURNS void LANGUAGE plpgsql AS $fn$
  DECLARE
    col_exists boolean;
    ref_exists boolean;
    cname text;
  BEGIN
    SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = src_table AND column_name = src_col
    ) INTO col_exists;
    SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ref_table AND column_name = ref_col
    ) INTO ref_exists;
    IF NOT col_exists OR NOT ref_exists THEN RETURN; END IF;
    cname := src_table || '_' || src_col || '_fkey';
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(%I) ON DELETE %s',
      src_table, cname, src_col, ref_table, ref_col, on_del
    );
  END $fn$`,

  `DO $$
  DECLARE
    col_type text;
    r record;
  BEGIN
    SELECT data_type INTO col_type
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'users'
       AND column_name = 'id';
    IF col_type IS NULL OR col_type = 'text' THEN
      RAISE NOTICE 'UUIDv7 migration: already TEXT or table missing, skipping';
      RETURN;
    END IF;

    RAISE NOTICE 'UUIDv7 migration: converting INTEGER PKs to TEXT...';

    -- 1. Drop ALL foreign key constraints in current schema dynamically.
    FOR r IN
      SELECT tc.constraint_name, tc.table_name
        FROM information_schema.table_constraints tc
       WHERE tc.table_schema = current_schema()
         AND tc.constraint_type = 'FOREIGN KEY'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', r.table_name, r.constraint_name);
    END LOOP;

    -- 2. Convert every integer/bigint column that is a PK or FK to TEXT.
    FOR r IN
      SELECT c.table_name, c.column_name
        FROM information_schema.columns c
       WHERE c.table_schema = current_schema()
         AND c.data_type IN ('integer', 'bigint')
         AND (
           c.column_name = 'id'
           OR c.column_name LIKE '%_id'
           OR c.column_name LIKE '%_by'
         )
         AND c.table_name NOT IN ('schema_migrations', 'setup_state')
    LOOP
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE TEXT USING %I::TEXT',
                     r.table_name, r.column_name, r.column_name);
      -- Drop any leftover default (sequences from old SERIAL columns).
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT', r.table_name, r.column_name);
    END LOOP;

    -- 3. Drop orphan sequences (leftover from SERIAL columns).
    FOR r IN
      SELECT sequence_name
        FROM information_schema.sequences
       WHERE sequence_schema = current_schema()
         AND sequence_name LIKE '%_id_seq'
    LOOP
      EXECUTE format('DROP SEQUENCE IF EXISTS %I CASCADE', r.sequence_name);
    END LOOP;

    -- 4. Re-add FK constraints (only if both table and column exist).
    PERFORM _bf_add_fk('sessions',       'user_id',                    'users',              'id', 'CASCADE');
    PERFORM _bf_add_fk('api_keys',       'user_id',                    'users',              'id', 'CASCADE');
    PERFORM _bf_add_fk('camera_streams', 'camera_id',                  'cameras',            'id', 'CASCADE');
    PERFORM _bf_add_fk('display_layouts','display_id',                 'displays',           'id', 'CASCADE');
    PERFORM _bf_add_fk('display_layouts','layout_id',                  'layouts',            'id', 'CASCADE');
    PERFORM _bf_add_fk('layout_cells',   'layout_id',                  'layouts',            'id', 'CASCADE');
    PERFORM _bf_add_fk('layout_cells',   'camera_id',                  'cameras',            'id', 'SET NULL');
    PERFORM _bf_add_fk('kiosks',         'display_id',                 'displays',           'id', 'SET NULL');
    PERFORM _bf_add_fk('kiosk_labels',   'kiosk_id',                   'kiosks',             'id', 'CASCADE');
    PERFORM _bf_add_fk('kiosk_labels',   'label_id',                   'labels',             'id', 'CASCADE');
    PERFORM _bf_add_fk('camera_labels',  'camera_id',                  'cameras',            'id', 'CASCADE');
    PERFORM _bf_add_fk('camera_labels',  'label_id',                   'labels',             'id', 'CASCADE');
    PERFORM _bf_add_fk('layout_labels',  'layout_id',                  'layouts',            'id', 'CASCADE');
    PERFORM _bf_add_fk('layout_labels',  'label_id',                   'labels',             'id', 'CASCADE');
    PERFORM _bf_add_fk('event_log',      'source_kiosk_id',            'kiosks',             'id', 'SET NULL');
    PERFORM _bf_add_fk('event_log',      'source_camera_id',           'cameras',            'id', 'SET NULL');
    PERFORM _bf_add_fk('kiosk_gpio_bindings','kiosk_id',               'kiosks',             'id', 'CASCADE');
    PERFORM _bf_add_fk('kiosk_logs',     'kiosk_id',                   'kiosks',             'id', 'CASCADE');
    PERFORM _bf_add_fk('camera_event_subscriptions','camera_id',       'cameras',            'id', 'CASCADE');
    PERFORM _bf_add_fk('camera_event_subscriptions','subscribed_by_kiosk_id','kiosks',       'id', 'SET NULL');
    PERFORM _bf_add_fk('displays',       'default_layout_id',          'layouts',            'id', 'SET NULL');
    PERFORM _bf_add_fk('pairing_codes',  'consumed_by_kiosk_id',       'kiosks',             'id', 'SET NULL');
    PERFORM _bf_add_fk('firmware_releases','uploaded_by',               'users',              'id', 'SET NULL');
    PERFORM _bf_add_fk('firmware_rollouts','release_id',               'firmware_releases',  'id', 'CASCADE');
    PERFORM _bf_add_fk('firmware_rollouts','created_by',               'users',              'id', 'SET NULL');
    PERFORM _bf_add_fk('os_update_releases','uploaded_by',             'users',              'id', 'SET NULL');
    PERFORM _bf_add_fk('os_update_rollouts','release_id',              'os_update_releases', 'id', 'CASCADE');
    PERFORM _bf_add_fk('os_update_rollouts','created_by',              'users',              'id', 'SET NULL');
    PERFORM _bf_add_fk('entities',       'camera_id',                  'cameras',            'id', 'CASCADE');

    RAISE NOTICE 'UUIDv7 migration: complete — all PKs and FKs are now TEXT';
  END $$`,

  // ---- Backfill: replace bare-integer IDs with real UUIDv7 ----
  // Existing rows have IDs like "1", "2" from the type conversion.
  // This replaces them with proper UUIDv7-shaped UUIDs while updating
  // all FK references so nothing breaks.
  `DO $$
  DECLARE
    r record;
    old_id text;
    new_id text;
    fk record;
    saved_fks jsonb := '[]'::jsonb;
  BEGIN
    -- 1. Save and drop ALL FK constraints so updates are unconstrained.
    FOR r IN
      SELECT tc.constraint_name, tc.table_name,
             kcu.column_name AS fk_col,
             ccu.table_name AS ref_table,
             ccu.column_name AS ref_col,
             rc.delete_rule
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        JOIN information_schema.referential_constraints rc
          ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = current_schema()
    LOOP
      saved_fks := saved_fks || jsonb_build_object(
        'name', r.constraint_name, 'tbl', r.table_name,
        'col', r.fk_col, 'ref', r.ref_table, 'rcol', r.ref_col,
        'del', r.delete_rule
      );
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.table_name, r.constraint_name);
    END LOOP;

    -- 2. Replace integer-looking IDs with UUIDs + cascade to FK columns.
    FOR r IN
      SELECT t.table_name
        FROM information_schema.columns t
       WHERE t.table_schema = current_schema()
         AND t.column_name = 'id'
         AND t.data_type = 'text'
         AND t.table_name NOT IN ('schema_migrations', 'setup_state', 'pairing_codes', 'sessions')
       ORDER BY t.table_name
    LOOP
      FOR old_id IN
        EXECUTE format('SELECT id FROM %I WHERE id ~ $1', r.table_name)
        USING '^[0-9]+$'
      LOOP
        new_id := gen_random_uuid()::text;

        -- Update FK columns in other tables that point to this old_id.
        FOR fk IN
          SELECT e->>'tbl' AS fk_table, e->>'col' AS fk_col
            FROM jsonb_array_elements(saved_fks) e
           WHERE e->>'ref' = r.table_name AND e->>'rcol' = 'id'
        LOOP
          EXECUTE format('UPDATE %I SET %I = $1 WHERE %I = $2',
                         fk.fk_table, fk.fk_col, fk.fk_col)
          USING new_id, old_id;
        END LOOP;

        EXECUTE format('UPDATE %I SET id = $1 WHERE id = $2', r.table_name)
        USING new_id, old_id;
      END LOOP;
    END LOOP;

    -- 3. Re-add all FK constraints.
    FOR fk IN
      SELECT e->>'name' AS cname, e->>'tbl' AS tbl, e->>'col' AS col,
             e->>'ref' AS ref, e->>'rcol' AS rcol, e->>'del' AS del
        FROM jsonb_array_elements(saved_fks) e
    LOOP
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(%I) ON DELETE %s',
        fk.tbl, fk.cname, fk.col, fk.ref, fk.rcol, fk.del
      );
    END LOOP;

    RAISE NOTICE 'UUIDv7 backfill: all integer-looking IDs replaced with UUIDs';
  END $$`,

  // ---- AbleSign digital signage integration -----------------------------------
  `CREATE TABLE IF NOT EXISTS ablesign_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_key_encrypted TEXT NOT NULL,
    workspace_id TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    screen_count INTEGER NOT NULL DEFAULT 0,
    last_sync_at TIMESTAMPTZ,
    last_sync_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS ablesign_screens (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES ablesign_accounts(id) ON DELETE CASCADE,
    ablesign_screen_id TEXT NOT NULL,
    ablesign_screen_token_encrypted TEXT,
    kiosk_id TEXT REFERENCES kiosks(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    orientation TEXT NOT NULL DEFAULT 'landscape',
    online BOOLEAN NOT NULL DEFAULT false,
    last_heartbeat_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(account_id, ablesign_screen_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ablesign_screens_account ON ablesign_screens(account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ablesign_screens_kiosk ON ablesign_screens(kiosk_id)`,
  `ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_type_check`,
  `ALTER TABLE entities ADD CONSTRAINT entities_type_check CHECK(type IN ('camera', 'html', 'web', 'dashboard', 'ablesign'))`,
  `ALTER TABLE entities ADD COLUMN IF NOT EXISTS ablesign_screen_id TEXT REFERENCES ablesign_screens(id) ON DELETE CASCADE`,
  `ALTER TABLE entities ADD COLUMN IF NOT EXISTS managed BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE layout_cells DROP CONSTRAINT IF EXISTS layout_cells_content_type_check`,
  `ALTER TABLE layout_cells ADD CONSTRAINT layout_cells_content_type_check CHECK(content_type IN ('none', 'camera', 'web', 'html', 'ablesign'))`,

  // ---- camera_event_subscriptions: source/sink tracking + subscribed_at ------
  `ALTER TABLE camera_event_subscriptions ADD COLUMN IF NOT EXISTS event_source TEXT`,
  `ALTER TABLE camera_event_subscriptions ADD COLUMN IF NOT EXISTS event_sink TEXT`,
  `ALTER TABLE camera_event_subscriptions ADD COLUMN IF NOT EXISTS subscribed_at TIMESTAMPTZ`,

  // ---- Fix: logging_json was inserted mid-array in 918076f, so existing
  // databases skipped it (the version counter already covered that index).
  // Re-append at the end so it actually runs on databases that missed it.
  `ALTER TABLE kiosks ADD COLUMN IF NOT EXISTS logging_json JSONB`,
  `ALTER TABLE kiosks ADD COLUMN IF NOT EXISTS audio_default_volume_percent INTEGER NOT NULL DEFAULT 50`,
  `ALTER TABLE layouts ADD COLUMN IF NOT EXISTS idle_timeout_seconds INTEGER`,

  // ---- ioBOX platform foundation -------------------------------------------
  `CREATE TABLE IF NOT EXISTS ioboxes (
    id TEXT PRIMARY KEY,
    serial TEXT NOT NULL UNIQUE,
    model_id TEXT NOT NULL,
    name TEXT NOT NULL,
    key_hash TEXT,
    key_prefix TEXT,
    enabled BOOLEAN NOT NULL DEFAULT true,
    paired_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    assigned_display_id TEXT REFERENCES displays(id) ON DELETE SET NULL,
    firmware_version TEXT,
    firmware_channel TEXT NOT NULL DEFAULT 'stable',
    firmware_target_version TEXT,
    firmware_last_attempt_at TIMESTAMPTZ,
    firmware_last_attempt_version TEXT,
    firmware_last_error TEXT,
    config_json JSONB NOT NULL DEFAULT '{}',
    config_version INTEGER NOT NULL DEFAULT 0,
    config_applied_version INTEGER NOT NULL DEFAULT 0,
    config_applied_at TIMESTAMPTZ,
    config_error TEXT,
    route_mode TEXT NOT NULL DEFAULT 'unknown' CHECK(route_mode IN ('unknown', 'direct', 'proxy', 'server', 'offline')),
    local_last_ip TEXT,
    network_json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ioboxes_prefix ON ioboxes(key_prefix)`,
  `CREATE INDEX IF NOT EXISTS idx_ioboxes_display ON ioboxes(assigned_display_id)`,

  `CREATE TABLE IF NOT EXISTS iobox_input_mappings (
    id TEXT PRIMARY KEY,
    iobox_id TEXT REFERENCES ioboxes(id) ON DELETE CASCADE,
    display_id TEXT REFERENCES displays(id) ON DELETE CASCADE,
    layout_id TEXT REFERENCES layouts(id) ON DELETE CASCADE,
    cell_id TEXT REFERENCES layout_cells(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL,
    match_json JSONB NOT NULL DEFAULT '{}',
    target_kind TEXT NOT NULL,
    action TEXT NOT NULL,
    params_json JSONB NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_iobox_mappings_iobox ON iobox_input_mappings(iobox_id)`,
  `CREATE INDEX IF NOT EXISTS idx_iobox_mappings_display ON iobox_input_mappings(display_id)`,

  `CREATE TABLE IF NOT EXISTS iobox_firmware_releases (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('stable', 'beta', 'dev')),
    firmware_arch TEXT NOT NULL DEFAULT 'esp32s3',
    model_id TEXT,
    artifact_path TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    signature TEXT NOT NULL,
    release_notes TEXT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    yanked_at TIMESTAMPTZ,
    UNIQUE(version, firmware_arch, model_id)
  )`,

  `CREATE TABLE IF NOT EXISTS iobox_firmware_rollouts (
    id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL REFERENCES iobox_firmware_releases(id) ON DELETE CASCADE,
    target_iobox_ids JSONB NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued', 'active', 'paused', 'complete')),
    percentage INTEGER NOT NULL DEFAULT 100 CHECK(percentage BETWEEN 1 AND 100),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL
  )`,

  `UPDATE ioboxes SET model_id = 'ioBOX-WIFI' WHERE model_id = 'ioBOX-KB'`,
  `UPDATE ioboxes SET model_id = 'ioBOX-ETHERNET' WHERE model_id = 'ioBOX-KB-E'`,
  `UPDATE iobox_firmware_releases r
      SET model_id = 'ioBOX-WIFI'
    WHERE model_id = 'ioBOX-KB'
      AND NOT EXISTS (
        SELECT 1 FROM iobox_firmware_releases existing
        WHERE existing.version = r.version
          AND existing.firmware_arch = r.firmware_arch
          AND existing.model_id = 'ioBOX-WIFI'
      )`,
  `DELETE FROM iobox_firmware_releases WHERE model_id = 'ioBOX-KB'`,
  `UPDATE iobox_firmware_releases r
      SET model_id = 'ioBOX-ETHERNET'
    WHERE model_id = 'ioBOX-KB-E'
      AND NOT EXISTS (
        SELECT 1 FROM iobox_firmware_releases existing
        WHERE existing.version = r.version
          AND existing.firmware_arch = r.firmware_arch
          AND existing.model_id = 'ioBOX-ETHERNET'
      )`,
  `DELETE FROM iobox_firmware_releases WHERE model_id = 'ioBOX-KB-E'`,

  `ALTER TABLE event_log ADD COLUMN IF NOT EXISTS source_iobox_id TEXT REFERENCES ioboxes(id) ON DELETE SET NULL`,
  `ALTER TABLE event_log DROP CONSTRAINT IF EXISTS event_log_source_type_check`,
  `ALTER TABLE event_log ADD CONSTRAINT event_log_source_type_check CHECK(source_type IN ('onvif', 'gpio', 'synthetic', 'system', 'io'))`,
  `ALTER TABLE layouts ADD COLUMN IF NOT EXISTS input_options_json JSONB NOT NULL DEFAULT '{}'`,
  `ALTER TABLE layout_cells ADD COLUMN IF NOT EXISTS input_options_json JSONB NOT NULL DEFAULT '{}'`,
  `ALTER TABLE entities ADD COLUMN IF NOT EXISTS input_options_json JSONB NOT NULL DEFAULT '{}'`,
  `ALTER TABLE ioboxes DROP CONSTRAINT IF EXISTS ioboxes_route_mode_check`,
  `ALTER TABLE ioboxes ADD CONSTRAINT ioboxes_route_mode_check CHECK(route_mode IN ('unknown', 'direct', 'proxy', 'server', 'offline'))`,
];
