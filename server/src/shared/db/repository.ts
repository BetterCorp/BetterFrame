/**
 * Repository — typed accessor over the DB adapter.
 *
 * Keeps prepared statements cached for the life of the connection. All
 * mutating methods invoke the `notify` callback with (table, op, id) so the
 * surrounding plugin can broadcast a `store.changed` event.
 *
 * NOT THREAD SAFE — node:sqlite is single-threaded, and so is Node. Don't
 * cross workers with the same handle.
 */
import { randomBytes } from "node:crypto";
import { uuidv7 } from "uuidv7";
import type { Observable } from "@bsb/base";
import type { DbAdapter, RunResult, Row } from "./db-adapter.js";

import type {
  ApiKey,
  ApiKeyScope,
  AuditActorType,
  AuditEntry,
  AuditResult,
  Camera,
  CameraEventSubscription,
  CameraStream,
  CameraType,
  CloudAccount,
  Display,
  Entity,
  EntityType,
  EventLog,
  EventQueryFilters,
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
  KioskLogQueryFilters,
  Label,
  LabelRole,
  Layout,
  LayoutCell,
  LayoutTemplate,
  OsUpdateRelease,
  OsUpdateRollout,
  OsUpdateRolloutState,
  PairingCode,
  Session,
  SetupState,
  StreamPolicy,
  StreamRole,
  Tenant,
  User,
  UserRole,
} from "../types.js";
import {
  rowToApiKey,
  rowToAuditEntry,
  rowToCamera,
  rowToCameraEventSubscription,
  rowToCloudAccount,
  rowToCameraStream,
  rowToDisplay,
  rowToEntity,
  rowToEventLog,
  rowToFirmwareRelease,
  rowToFirmwareRollout,
  rowToIoBox,
  rowToIoBoxFirmwareRelease,
  rowToIoBoxInputMapping,
  rowToIoBoxModel,
  rowToIoBoxSerial,
  rowToKiosk,
  rowToKioskGpioBinding,
  rowToKioskLog,
  rowToLabel,
  rowToLayout,
  rowToLayoutCell,
  rowToLayoutTemplate,
  rowToOsUpdateRelease,
  rowToOsUpdateRollout,
  rowToPairingCode,
  rowToSession,
  rowToSetupState,
  rowToTenant,
  rowToUser,
} from "./mappers.js";
import { J, isoIn, isoNow, j, normalizeTimestamp } from "./util.js";
import { mirrorPlatformAdmins, quotedSchema } from "./platform-admin.js";

type NotifyFn = (
  table: string,
  op: "create" | "update" | "delete",
  id?: string | number,
) => Promise<void>;

function userPatchSql(patch: Partial<User>): { columns: string[]; values: unknown[] } {
  const columns: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    columns.push(`${column} = ?`);
    values.push(value);
  };
  if ("password_hash" in patch) add("password_hash", patch.password_hash);
  if ("totp_enabled" in patch) add("totp_enabled", Boolean(patch.totp_enabled));
  if ("totp_secret_encrypted" in patch) add("totp_secret_encrypted", patch.totp_secret_encrypted);
  if ("recovery_codes_hashed" in patch) add("recovery_codes_hashed", J(patch.recovery_codes_hashed));
  if ("must_change_password" in patch) add("must_change_password", Boolean(patch.must_change_password));
  if ("failed_login_count" in patch) add("failed_login_count", patch.failed_login_count);
  if ("locked_until" in patch) add("locked_until", patch.locked_until);
  if ("last_login_at" in patch) add("last_login_at", patch.last_login_at);
  if ("is_active" in patch) add("is_active", Boolean(patch.is_active));
  return { columns, values };
}

export class Repository {
  readonly adapter: DbAdapter;
  private readonly notify: NotifyFn;
  private _obs?: Observable;

  constructor(adapter: DbAdapter, notify: NotifyFn) {
    this.adapter = adapter;
    this.notify = notify;
  }

  /** Set a per-request observable for DB call tracing. */
  withObs(obs: Observable): this {
    this._obs = obs;
    return this;
  }

  /** Clear the per-request observable. */
  clearObs(): this {
    this._obs = undefined;
    return this;
  }

  /** Run a write statement. Params are passed as an array. */
  private async _run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const span = this._obs?.startSpan("db.run", { "db.statement": sql.slice(0, 100) });
    try {
      const result = await this.adapter.run(sql, params as any);
      span?.end();
      return result;
    } catch (err) {
      span?.log.error("db error: {err}", { err: (err as Error).message });
      span?.end();
      throw err;
    }
  }
  /** Single-row query. */
  private async _get<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const span = this._obs?.startSpan("db.get", { "db.statement": sql.slice(0, 100) });
    try {
      const result = await this.adapter.get<T>(sql, params as any);
      span?.end();
      return result;
    } catch (err) {
      span?.log.error("db error: {err}", { err: (err as Error).message });
      span?.end();
      throw err;
    }
  }
  /** Multi-row query. */
  private async _all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const span = this._obs?.startSpan("db.all", { "db.statement": sql.slice(0, 100) });
    try {
      const result = await this.adapter.all<T>(sql, params as any);
      span?.end();
      return result;
    } catch (err) {
      span?.log.error("db error: {err}", { err: (err as Error).message });
      span?.end();
      throw err;
    }
  }
  /** Execute DDL. */
  private _exec(sql: string): Promise<void> {
    return this.adapter.exec(sql);
  }

  /** Ad-hoc transaction. */
  async transact<T>(fn: () => Promise<T>): Promise<T> {
    return this.adapter.transaction(fn);
  }

  // ===========================================================================
  // tenants (PUBLIC schema — always use public.tenants explicitly)
  // ===========================================================================

  /** List all tenants. Queries public.tenants regardless of current search_path. */
  async listTenants(): Promise<Tenant[]> {
    if (this.adapter.dialect() !== "postgres") return [];
    const rs = await this._all(
      "SELECT * FROM public.tenants ORDER BY created_at",
    );
    return rs.map((r) => rowToTenant(r as Record<string, unknown>));
  }

  /** Get tenant by UUID. */
  async getTenantById(id: string): Promise<Tenant | null> {
    if (this.adapter.dialect() !== "postgres") return null;
    const r = await this._get("SELECT * FROM public.tenants WHERE id = ?", [id]);
    return r ? rowToTenant(r as Record<string, unknown>) : null;
  }

  /** Get tenant by slug. */
  async getTenantBySlug(slug: string): Promise<Tenant | null> {
    if (this.adapter.dialect() !== "postgres") return null;
    const r = await this._get("SELECT * FROM public.tenants WHERE slug = ?", [slug]);
    return r ? rowToTenant(r as Record<string, unknown>) : null;
  }

  /** Create a new tenant in public.tenants. Does NOT create the PG schema — call createTenantSchema separately. */
  async createTenant(input: {
    name: string;
    slug: string;
    max_kiosks?: number | null;
    max_cameras?: number | null;
    max_users?: number | null;
  }): Promise<Tenant> {
    const schemaName = input.slug === "default" ? "public" : `tenant_${input.slug}`;
    await this._run(
      `INSERT INTO public.tenants (name, slug, schema_name, is_active, max_kiosks, max_cameras, max_users)
       VALUES (?, ?, ?, true, ?, ?, ?)`,
      [
        input.name,
        input.slug,
        schemaName,
        input.max_kiosks ?? null,
        input.max_cameras ?? null,
        input.max_users ?? null,
      ],
    );
    void this.notify("tenants", "create");
    const t = await this.getTenantBySlug(input.slug);
    if (!t) throw new Error("tenant vanished after insert");
    return t;
  }

  /** Update tenant metadata. */
  async updateTenant(id: string, patch: Partial<Pick<Tenant, "name" | "is_active" | "max_kiosks" | "max_cameras" | "max_users">>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if ("name" in patch) { sets.push("name = ?"); vals.push(patch.name); }
    if ("is_active" in patch) { sets.push("is_active = ?"); vals.push(Boolean(patch.is_active)); }
    if ("max_kiosks" in patch) { sets.push("max_kiosks = ?"); vals.push(patch.max_kiosks ?? null); }
    if ("max_cameras" in patch) { sets.push("max_cameras = ?"); vals.push(patch.max_cameras ?? null); }
    if ("max_users" in patch) { sets.push("max_users = ?"); vals.push(patch.max_users ?? null); }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE public.tenants SET ${sets.join(", ")} WHERE id = ?`, vals);
    void this.notify("tenants", "update", id);
  }

  /** Delete a tenant. WARNING: does not drop the PG schema — that must be done separately if desired. */
  async deleteTenant(id: string): Promise<void> {
    await this._run("DELETE FROM public.tenants WHERE id = ?", [id]);
    void this.notify("tenants", "delete", id);
  }

  /** Count tenants. Used to check if multi-tenant is enabled. */
  async countTenants(): Promise<number> {
    if (this.adapter.dialect() !== "postgres") return 0;
    const r = await this._get<{ c: number }>("SELECT COUNT(*) AS c FROM public.tenants");
    return r?.c ?? 0;
  }

  // ===========================================================================
  // setup_state
  // ===========================================================================

  async getSetupState(): Promise<SetupState> {
    let r = await this._get("SELECT * FROM setup_state WHERE id = 1");
    if (!r) {
      await this._run(
        "INSERT INTO setup_state (id, is_complete, extras) VALUES (1, false, '{}') ON CONFLICT (id) DO NOTHING",
      );
      r = await this._get("SELECT * FROM setup_state WHERE id = 1");
      if (!r) throw new Error("setup_state row could not be created");
    }
    return rowToSetupState(r as Record<string, unknown>);
  }

  async isSetupComplete(): Promise<boolean> {
    const state = await this.getSetupState();
    if (state.is_complete) return true;
    if ((await this.countUsers()) > 0) return true;
    // No local users — copy global admin into tenant if one exists.
    const ga = await this._get<{ id: string; username: string; password_hash: string }>(
      "SELECT id, username, password_hash FROM public.global_admins WHERE is_active = true LIMIT 1",
    ).catch(() => undefined);
    if (ga) {
      await this._run(
        `INSERT INTO users (id, username, password_hash, role, is_active)
         VALUES (?, ?, ?, 'admin', true)
         ON CONFLICT (id) DO NOTHING`,
        [ga.id, ga.username, ga.password_hash],
      );
      await this.markSetupComplete();
      return true;
    }
    return false;
  }

  async markSetupComplete(): Promise<void> {
    await this._run(
      `UPDATE setup_state
         SET is_complete = ?,
             completed_at = COALESCE(completed_at, ?)
       WHERE id = 1`,
      [true, isoNow()],
    );
    void this.notify("setup_state", "update", 1);
  }

  async setSetupExtra(key: string, value: unknown): Promise<void> {
    const cur = (await this.getSetupState()).extras;
    cur[key] = value;
    await this._run("UPDATE setup_state SET extras = ? WHERE id = 1", [J(cur)]);
  }

  async getSetupExtra(key: string): Promise<unknown> {
    return (await this.getSetupState()).extras[key];
  }

  async markClusterKeyProvisioned(): Promise<void> {
    await this._run(
      "UPDATE setup_state SET cluster_key_provisioned = ? WHERE id = 1",
      [true],
    );
  }

  // ===========================================================================
  // users
  // ===========================================================================

  async countUsers(): Promise<number> {
    const r = await this._get<{ c: number }>("SELECT COUNT(*) AS c FROM users");
    return r?.c ?? 0;
  }

  async getUserById(id: string): Promise<User | null> {
    const r = await this._get("SELECT * FROM users WHERE id = ?", [id]);
    return r ? rowToUser(r as Record<string, unknown>) : null;
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const r = await this._get("SELECT * FROM users WHERE username = ?", [username]);
    return r ? rowToUser(r as Record<string, unknown>) : null;
  }

  async createUser(input: {
    username: string;
    password_hash: string;
    role?: UserRole;
    must_change_password?: boolean;
  }): Promise<User> {
    const id = uuidv7();
    const role: UserRole = input.role ?? "operator";
    await this._run(
      `INSERT INTO users (id, username, password_hash, role, is_active, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.username,
        input.password_hash,
        role,
        true,
        Boolean(input.must_change_password),
      ],
    );
    void this.notify("users", "create", id);
    const u = await this.getUserById(id);
    if (!u) throw new Error("user vanished after insert");
    return u;
  }

  async updateUser(id: string, patch: Partial<User>): Promise<void> {
    const { columns, values } = userPatchSql(patch);
    if (columns.length === 0) return;
    values.push(id);
    await this._run(`UPDATE users SET ${columns.join(", ")} WHERE id = ?`, values);
    void this.notify("users", "update", id);
  }

  /** Update the authoritative platform admin and mirror it into every tenant. */
  async updatePlatformAdmin(id: string, patch: Partial<User>): Promise<void> {
    const { columns, values } = userPatchSql(patch);
    if (columns.length === 0) return;
    const admin = await this._get<{ username: string }>(
      "SELECT username FROM public.users WHERE id = ? AND role = 'admin'",
      [id],
    );
    if (!admin) throw new Error("platform administrator not found");
    const schemas = (await this.listTenants())
      .map((tenant) => tenant.schema_name)
      .filter((schema) => schema !== "public");

    await this.adapter.transaction(async () => {
      await this._run(
        `UPDATE public.users SET ${columns.join(", ")} WHERE id = ?`,
        [...values, id],
      );
      await mirrorPlatformAdmins(this.adapter, schemas, id);
    });
    void this.notify("users", "update", id);
  }

  // ===========================================================================
  // sessions
  // ===========================================================================

  async createSession(input: {
    id: string;
    user_id: string;
    csrf_token: string;
    totp_pending: boolean;
    user_agent: string | null;
    ip_address: string | null;
    expires_at: string; // absolute
  }): Promise<Session> {
    await this._run(
      `INSERT INTO sessions
         (id, user_id, csrf_token, totp_pending, user_agent, ip_address, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.user_id,
        input.csrf_token,
        Boolean(input.totp_pending),
        input.user_agent,
        input.ip_address,
        input.expires_at,
      ],
    );
    const s = await this.getSessionById(input.id);
    if (!s) throw new Error("session vanished after insert");
    return s;
  }

  async getSessionById(id: string): Promise<Session | null> {
    const r = await this._get("SELECT * FROM sessions WHERE id = ?", [id]);
    return r ? rowToSession(r as Record<string, unknown>) : null;
  }

  async touchSession(id: string, lastSeenAt: string): Promise<void> {
    await this._run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", [
      lastSeenAt,
      id,
    ]);
  }

  async setSessionTotpPending(id: string, pending: boolean): Promise<void> {
    await this._run("UPDATE sessions SET totp_pending = ? WHERE id = ?", [
      pending,
      id,
    ]);
  }

  async revokeSession(id: string): Promise<void> {
    await this._run("UPDATE sessions SET revoked_at = ? WHERE id = ?", [isoNow(), id]);
  }

  async revokeAllSessionsForUser(userId: string): Promise<void> {
    await this._run(
      `UPDATE sessions SET revoked_at = ?
        WHERE user_id = ? AND revoked_at IS NULL`,
      [isoNow(), userId],
    );
  }

  /** Revoke root and legacy tenant sessions for a mirrored platform admin. */
  async revokePlatformAdminSessions(userId: string): Promise<void> {
    const admin = await this._get<{ username: string }>(
      "SELECT username FROM public.users WHERE id = ? AND role = 'admin'",
      [userId],
    );
    if (!admin) throw new Error("platform administrator not found");
    const schemas = (await this.listTenants())
      .map((tenant) => tenant.schema_name)
      .filter((schema) => schema !== "public");
    const revokedAt = isoNow();

    await this.adapter.transaction(async () => {
      await this.adapter.run(
        "UPDATE public.sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
        [revokedAt, userId],
      );
      for (const schema of schemas) {
        const target = quotedSchema(schema);
        await this.adapter.run(
          `UPDATE ${target}.sessions SET revoked_at = ?
            WHERE user_id IN (SELECT id FROM ${target}.users WHERE username = ?)
              AND revoked_at IS NULL`,
          [revokedAt, admin.username],
        );
      }
    });
  }

  // ===========================================================================
  // api_keys
  // ===========================================================================

  async createApiKey(input: {
    name: string;
    key_hash: string;
    key_prefix: string;
    scopes: ApiKeyScope[];
    expires_at: string | null;
  }): Promise<ApiKey> {
    const id = uuidv7();
    await this._run(
      `INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.key_hash,
        input.key_prefix,
        J(input.scopes),
        input.expires_at,
      ],
    );
    void this.notify("api_keys", "create", id);
    const k = await this.getApiKeyById(id);
    if (!k) throw new Error("api_key vanished after insert");
    return k;
  }

  async getApiKeyById(id: string): Promise<ApiKey | null> {
    const r = await this._get("SELECT * FROM api_keys WHERE id = ?", [id]);
    return r ? rowToApiKey(r as Record<string, unknown>) : null;
  }

  /** Lookup all candidates for a given prefix (typically returns 0 or 1). */
  async listApiKeysByPrefix(prefix: string): Promise<ApiKey[]> {
    const rs = await this._all(
      "SELECT * FROM api_keys WHERE key_prefix = ? AND revoked_at IS NULL",
      [prefix],
    );
    return rs.map((r) => rowToApiKey(r as Record<string, unknown>));
  }

  async touchApiKey(id: string, ip: string | null): Promise<void> {
    await this._run(
      "UPDATE api_keys SET last_used_at = ?, last_used_ip = ? WHERE id = ?",
      [isoNow(), ip, id],
    );
  }

  // ===========================================================================
  // displays
  // ===========================================================================

  async listDisplays(): Promise<Display[]> {
    const rs = await this._all('SELECT * FROM displays ORDER BY "index"');
    return rs.map((r) => rowToDisplay(r as Record<string, unknown>));
  }

  async getDisplayById(id: string): Promise<Display | null> {
    const r = await this._get("SELECT * FROM displays WHERE id = ?", [id]);
    return r ? rowToDisplay(r as Record<string, unknown>) : null;
  }

  async createDefaultDisplay(): Promise<Display> {
    const id = uuidv7();
    await this._run(
      `INSERT INTO displays (id, name, "index", is_primary)
       VALUES (?, 'primary', 0, ?)`,
      [id, false],
    );
    void this.notify("displays", "create", id);
    const d = await this.getDisplayById(id);
    if (!d) throw new Error("display vanished after insert");
    return d;
  }

  async createDisplayForKiosk(kioskId: string, input: {
    name: string;
    index?: number;
    width_px?: number;
    height_px?: number;
  }): Promise<Display> {
    const idx = input.index ?? await this.nextDisplayIndexForKiosk(kioskId);
    const id = uuidv7();
    await this._run(
      `INSERT INTO displays (id, name, "index", is_primary, kiosk_id, width_px, height_px)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        idx,
        false,
        kioskId,
        input.width_px ?? 1920,
        input.height_px ?? 1080,
      ],
    );
    void this.notify("displays", "create", id);
    const d = await this.getDisplayById(id);
    if (!d) throw new Error("display vanished after insert");
    return d;
  }

  async listDisplaysForKiosk(kioskId: string): Promise<Display[]> {
    const rs = await this._all(
      'SELECT * FROM displays WHERE kiosk_id = ? ORDER BY "index"',
      [kioskId],
    );
    return rs.map((r) => rowToDisplay(r as Record<string, unknown>));
  }

  async deleteDisplayIfUnused(id: string): Promise<boolean> {
    const result = await this._run(
      `DELETE FROM displays
        WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM display_layouts WHERE display_id = ?)`,
      [id, id],
    );
    if (result.changes > 0) void this.notify("displays", "delete", id);
    return result.changes > 0;
  }

  /**
   * Kiosks currently rendering this camera (active layout has a cell
   * pointing at it). Subset of listKiosksWithCameraInBundle.
   */
  async listKiosksRenderingCamera(cameraId: string): Promise<Kiosk[]> {
    const rs = await this._all(
      `SELECT DISTINCT k.*
         FROM kiosks k
         JOIN displays d ON d.kiosk_id = k.id
         JOIN layout_cells lc ON lc.layout_id = d.active_layout_id
        WHERE lc.camera_id = ?
          AND d.active_layout_id IS NOT NULL
          AND k.enabled = true`,
      [cameraId],
    );
    return rs.map((r) => rowToKiosk(r as Record<string, unknown>));
  }

  /**
   * Kiosks that have this camera in ANY of their layouts (bundle-level).
   * The kiosk's cached bundle includes the camera even when it's not the
   * active layout, so snapshot requests via the kiosk LAN endpoint still
   * resolve — the kiosk opens a short-lived RTSP connection from its own
   * LAN position. Only when NO kiosk has the camera should the server
   * fall back to pulling the stream itself.
   */
  async listKiosksWithCameraInBundle(cameraId: string): Promise<Kiosk[]> {
    const rs = await this._all(
      `SELECT DISTINCT k.*
         FROM kiosks k
         JOIN displays d ON d.kiosk_id = k.id
         JOIN display_layouts dl ON dl.display_id = d.id
         JOIN layout_cells lc ON lc.layout_id = dl.layout_id
        WHERE lc.camera_id = ?
          AND k.enabled = true`,
      [cameraId],
    );
    return rs.map((r) => rowToKiosk(r as Record<string, unknown>));
  }

  private async nextDisplayIndexForKiosk(kioskId: string): Promise<number> {
    const r = await this._get<{ m: number | null }>('SELECT MAX("index") AS m FROM displays WHERE kiosk_id = ?', [kioskId]);
    return (r?.m ?? -1) + 1;
  }

  async updateDisplay(id: string, patch: Partial<Display>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id") continue;
      const col = k === "index" ? `"index"` : k;
      sets.push(`${col} = ?`);
      vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE displays SET ${sets.join(", ")} WHERE id = ?`, vals);
    void this.notify("displays", "update", id);
  }

  // ===========================================================================
  // layout templates
  // ===========================================================================

  // ===========================================================================
  // layouts
  // ===========================================================================

  async listLayouts(): Promise<Layout[]> {
    const rs = await this._all("SELECT * FROM layouts ORDER BY name");
    return rs.map((r) => rowToLayout(r as Record<string, unknown>));
  }

  async getLayoutById(id: string): Promise<Layout | null> {
    const r = await this._get("SELECT * FROM layouts WHERE id = ?", [id]);
    return r ? rowToLayout(r as Record<string, unknown>) : null;
  }

  /**
   * @deprecated Use `listLayoutsForDisplay` which goes through the
   *             `display_layouts` join table. Kept as a thin alias for any
   *             callers still on the old API.
   */
  async layoutsForDisplay(displayId: string): Promise<Layout[]> {
    return this.listLayoutsForDisplay(displayId);
  }

  /** All layouts attached to the given display, via display_layouts. */
  async listLayoutsForDisplay(displayId: string): Promise<Layout[]> {
    const rs = await this._all(
      `SELECT l.* FROM layouts l
         JOIN display_layouts dl ON dl.layout_id = l.id
        WHERE dl.display_id = ?
        ORDER BY l.name`,
      [displayId],
    );
    return rs.map((r) => rowToLayout(r as Record<string, unknown>));
  }

  /** Inverse: all displays that have this layout attached. */
  async listDisplaysForLayout(layoutId: string): Promise<Display[]> {
    const rs = await this._all(
      `SELECT d.* FROM displays d
         JOIN display_layouts dl ON dl.display_id = d.id
        WHERE dl.layout_id = ?
        ORDER BY d."index"`,
      [layoutId],
    );
    return rs.map((r) => rowToDisplay(r as Record<string, unknown>));
  }

  /** Idempotent attach. */
  async attachLayoutToDisplay(displayId: string, layoutId: string): Promise<void> {
    await this._run(
      `INSERT OR IGNORE INTO display_layouts (display_id, layout_id)
       VALUES (?, ?)`,
      [displayId, layoutId],
    );
    void this.notify("display_layouts", "create", layoutId);
  }

  /** Detach. If the display's default_layout_id pointed at this layout, clear it. */
  async detachLayoutFromDisplay(displayId: string, layoutId: string): Promise<void> {
    await this._run(
      `DELETE FROM display_layouts WHERE display_id = ? AND layout_id = ?`,
      [displayId, layoutId],
    );
    await this._run(
      `UPDATE displays SET default_layout_id = NULL
        WHERE id = ? AND default_layout_id = ?`,
      [displayId, layoutId],
    );
    void this.notify("display_layouts", "delete", layoutId);
  }

  async createLayout(input: {
    name: string;
    description?: string | null;
    priority?: string;
    cooling_timeout_seconds?: number | null;
    idle_timeout_seconds?: number | null;
    preload_camera_ids?: string[];
    resets_idle_timer?: boolean;
    input_options_json?: Record<string, unknown>;
  }): Promise<Layout> {
    const id = uuidv7();
    await this._run(
      `INSERT INTO layouts (id, name, description, priority, cooling_timeout_seconds, idle_timeout_seconds, preload_camera_ids, resets_idle_timer, input_options_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.description ?? null,
        input.priority ?? "normal",
        input.cooling_timeout_seconds ?? null,
        input.idle_timeout_seconds ?? null,
        J(input.preload_camera_ids ?? []),
        Boolean(input.resets_idle_timer ?? true),
        J(input.input_options_json ?? {}),
      ],
    );
    void this.notify("layouts", "create", id);
    const r = await this.getLayoutById(id);
    if (!r) throw new Error("layout vanished after insert");
    return r;
  }

  async updateLayout(id: string, patch: Partial<Layout>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "display_id") continue; // display_id deprecated
      sets.push(`${k} = ?`);
      if (k === "preload_camera_ids" || k === "regions" || k === "input_options_json") vals.push(J(v));
      else if (typeof v === "boolean") vals.push(v);
      else vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE layouts SET ${sets.join(", ")} WHERE id = ?`, vals);
    void this.notify("layouts", "update", id);
  }

  async cloneLayout(id: string): Promise<Layout> {
    const src = await this.getLayoutById(id);
    if (!src) throw new Error("layout not found");

    let cloneName = `${src.name} (copy)`;
    let suffix = 2;
    while (await this._get("SELECT 1 FROM layouts WHERE name = ?", [cloneName])) {
      cloneName = `${src.name} (copy ${String(suffix)})`;
      suffix++;
    }

    const clone = await this.createLayout({
      name: cloneName,
      description: src.description,
      priority: src.priority,
      cooling_timeout_seconds: src.cooling_timeout_seconds,
      idle_timeout_seconds: src.idle_timeout_seconds,
      preload_camera_ids: src.preload_camera_ids,
      resets_idle_timer: src.resets_idle_timer,
      input_options_json: src.input_options_json,
    });

    const cells = await this.listLayoutCells(id);
    for (const c of cells) {
      await this.createLayoutCell({
        layout_id: clone.id,
        row: c.row,
        col: c.col,
        row_span: c.row_span,
        col_span: c.col_span,
        content_type: c.content_type,
        camera_id: c.camera_id,
        stream_selector: c.stream_selector,
        web_url: c.web_url,
        html_content: c.html_content,
        cooling_timeout_seconds: c.cooling_timeout_seconds,
        options: c.options,
        entity_id: c.entity_id,
        fit: c.fit,
      });
    }

    const labels = await this._all<{ label_id: string }>(
      "SELECT label_id FROM layout_labels WHERE layout_id = ?",
      [id],
    );
    for (const ll of labels) {
      await this.attachLayoutLabel(clone.id, ll.label_id);
    }

    const displays = await this._all<{ display_id: string }>(
      "SELECT display_id FROM display_layouts WHERE layout_id = ?",
      [id],
    );
    for (const dl of displays) {
      await this.attachLayoutToDisplay(dl.display_id, clone.id);
    }

    return clone;
  }

  async deleteLayout(id: string): Promise<void> {
    await this._run(`DELETE FROM layout_cells WHERE layout_id = ?`, [id]);
    await this._run(`DELETE FROM layout_labels WHERE layout_id = ?`, [id]);
    await this._run(`DELETE FROM display_layouts WHERE layout_id = ?`, [id]);
    // Any display whose default pointed here gets cleared.
    await this._run(`UPDATE displays SET default_layout_id = NULL WHERE default_layout_id = ?`, [id]);
    await this._run(`DELETE FROM layouts WHERE id = ?`, [id]);
    void this.notify("layouts", "delete", id);
  }

  // ===========================================================================
  // layout cells
  // ===========================================================================

  async createLayoutCell(input: {
    layout_id: string;
    row: number;
    col: number;
    row_span?: number;
    col_span?: number;
    content_type?: string;
    camera_id?: string | null;
    stream_selector?: string | null;
    web_url?: string | null;
    html_content?: string | null;
    cooling_timeout_seconds?: number | null;
    options?: Record<string, unknown>;
    entity_id?: string | null;
    fit?: "cover" | "contain" | "fill";
  }): Promise<LayoutCell> {
    // Resolve content fields from the entity (if given). The legacy columns
    // remain populated for backward-compatible bundle generation. Dashboard
    // entities materialise as web cells pointing at /dash/<id> so the existing
    // kiosk's WebKit cell path renders them with no app changes.
    let contentType = input.content_type ?? "none";
    let cameraId: string | null = input.camera_id ?? null;
    let webUrl: string | null = input.web_url ?? null;
    let htmlContent: string | null = input.html_content ?? null;
    if (input.entity_id != null) {
      const ent = await this.getEntityById(input.entity_id);
      if (ent) {
        contentType = ent.type === "dashboard" ? "web" : ent.type;
        cameraId = ent.type === "camera" ? ent.camera_id : null;
        webUrl =
          ent.type === "web" ? ent.web_url :
          ent.type === "dashboard" && ent.dashboard_id ? `/dash/${ent.dashboard_id}` :
          null;
        htmlContent = ent.type === "html" ? ent.html_content : null;
      }
    }

    const id = uuidv7();
    await this._run(
      `INSERT INTO layout_cells (id, layout_id, "row", col, row_span, col_span, content_type, camera_id, stream_selector, web_url, html_content, cooling_timeout_seconds, options, entity_id, fit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.layout_id,
        input.row,
        input.col,
        input.row_span ?? 1,
        input.col_span ?? 1,
        contentType,
        cameraId,
        input.stream_selector ?? "auto",
        webUrl,
        htmlContent,
        input.cooling_timeout_seconds ?? null,
        J(input.options ?? {}),
        input.entity_id ?? null,
        input.fit ?? "cover",
      ],
    );
    void this.notify("layout_cells", "create", id);
    const r = await this._get("SELECT * FROM layout_cells WHERE id = ?", [id]);
    if (!r) throw new Error("layout_cell vanished after insert");
    return rowToLayoutCell(r as Record<string, unknown>);
  }

  /**
   * Assign (or clear) the entity for a cell. Also mirrors the resolved entity's
   * type/camera/url/html into the legacy cell columns so bundle generation stays
   * compatible with the existing kiosk.
   */
  async assignCellEntity(cellId: string, entityId: string | null): Promise<void> {
    if (entityId == null) {
      await this._run(
        `UPDATE layout_cells
            SET entity_id = NULL,
                content_type = 'none',
                camera_id = NULL,
                web_url = NULL,
                html_content = NULL
          WHERE id = ?`,
        [cellId],
      );
      void this.notify("layout_cells", "update", cellId);
      return;
    }
    const ent = await this.getEntityById(entityId);
    if (!ent) return;
    const cellContentType = ent.type === "dashboard" ? "web" : ent.type;
    const cellWebUrl =
      ent.type === "web" ? ent.web_url :
      ent.type === "dashboard" && ent.dashboard_id ? `/dash/${ent.dashboard_id}` :
      null;
    await this._run(
      `UPDATE layout_cells
          SET entity_id = ?,
              content_type = ?,
              camera_id = ?,
              web_url = ?,
              html_content = ?
        WHERE id = ?`,
      [
        ent.id,
        cellContentType,
        ent.type === "camera" ? ent.camera_id : null,
        cellWebUrl,
        ent.type === "html" ? ent.html_content : null,
        cellId,
      ],
    );
    void this.notify("layout_cells", "update", cellId);
  }

  async updateLayoutCell(id: string, patch: Partial<LayoutCell>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "layout_id") continue;
      const col = k === "row" ? `"row"` : k;
      sets.push(`${col} = ?`);
      if (k === "options" || k === "input_options_json") vals.push(J(v));
      else vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE layout_cells SET ${sets.join(", ")} WHERE id = ?`, vals);
    void this.notify("layout_cells", "update", id);
  }

  async deleteLayoutCell(id: string): Promise<void> {
    await this._run(`DELETE FROM layout_cells WHERE id = ?`, [id]);
    void this.notify("layout_cells", "delete", id);
  }

  /**
   * Shift cells along an axis to make room for an insertion (or close a gap
   * after a deletion). For axis="row", any cell whose `row >= fromIndex` has
   * its row bumped by `delta`. Same for axis="col". Used by the visual
   * builder when adding a cell to the top/left of an existing one.
   */
  async shiftCellsForLayout(
    layoutId: number,
    axis: "row" | "col",
    fromIndex: number,
    delta: number,
  ): Promise<void> {
    if (delta === 0) return;
    const colName = axis === "row" ? `"row"` : "col";
    await this._run(
      `UPDATE layout_cells
          SET ${colName} = ${colName} + ?
        WHERE layout_id = ?
          AND ${colName} >= ?`,
      [delta, layoutId, fromIndex],
    );
    void this.notify("layout_cells", "update", layoutId);
  }

  async listLayoutCells(layoutId: string): Promise<LayoutCell[]> {
    const rs = await this._all(
      `SELECT * FROM layout_cells WHERE layout_id = ? ORDER BY "row", col`,
      [layoutId],
    );
    return rs.map((r) => rowToLayoutCell(r as Record<string, unknown>));
  }

  async getLayoutCellById(id: string): Promise<LayoutCell | null> {
    const r = await this._get("SELECT * FROM layout_cells WHERE id = ?", [id]);
    return r ? rowToLayoutCell(r as Record<string, unknown>) : null;
  }

  // ===========================================================================
  // display-chain bundle queries (kiosk → display → layouts → cells → cameras)
  // ===========================================================================

  /** Bundle generation: layouts attached to a display via display_layouts. */
  async layoutsForDisplayId(displayId: string): Promise<Layout[]> {
    return this.listLayoutsForDisplay(displayId);
  }

  async camerasForLayoutIds(layoutIds: string[]): Promise<Camera[]> {
    if (layoutIds.length === 0) return [];
    const placeholders = layoutIds.map(() => "?").join(",");
    const rs = await this._all(
      `SELECT DISTINCT c.* FROM cameras c
         JOIN layout_cells lc ON lc.camera_id = c.id
        WHERE lc.layout_id IN (${placeholders})
          AND c.enabled = true
        ORDER BY c.name`,
      layoutIds,
    );
    return rs.map((r) => rowToCamera(r as Record<string, unknown>));
  }

  // ===========================================================================
  // cameras
  // ===========================================================================

  async listCameras(): Promise<Camera[]> {
    const rs = await this._all("SELECT * FROM cameras ORDER BY name");
    return rs.map((r) => rowToCamera(r as Record<string, unknown>));
  }

  async getCameraById(id: string): Promise<Camera | null> {
    const r = await this._get("SELECT * FROM cameras WHERE id = ?", [id]);
    return r ? rowToCamera(r as Record<string, unknown>) : null;
  }

  async getCameraByName(name: string): Promise<Camera | null> {
    const r = await this._get("SELECT * FROM cameras WHERE name = ?", [name]);
    return r ? rowToCamera(r as Record<string, unknown>) : null;
  }

  async createCamera(input: {
    name: string;
    camera_number?: string | null;
    type: CameraType;
    rtsp_url?: string | null;
    onvif_host?: string | null;
    onvif_port?: number | null;
    onvif_username?: string | null;
    onvif_password?: string | null; // already-encrypted ciphertext
    capabilities?: string[];
    stream_policy?: StreamPolicy;
  }): Promise<Camera> {
    const id = uuidv7();
    await this._run(
      `INSERT INTO cameras
         (id, name, camera_number, type, rtsp_url, onvif_host, onvif_port, onvif_username,
          onvif_password, capabilities, stream_policy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.camera_number ?? null,
        input.type,
        input.rtsp_url ?? null,
        input.onvif_host ?? null,
        input.onvif_port ?? null,
        input.onvif_username ?? null,
        input.onvif_password ?? null,
        J(input.capabilities ?? []),
        input.stream_policy ?? "auto",
      ],
    );
    void this.notify("cameras", "create", id);
    const c = await this.getCameraById(id);
    if (!c) throw new Error("camera vanished after insert");
    // Mirror this camera as a reusable entity so it's pickable in cell editors.
    await this.ensureCameraEntity(c);
    return c;
  }

  async upsertCloudCamera(input: {
    cloud_account_id: string;
    cloud_vendor_camera_id: string;
    name: string;
    cloud_stream_url: string | null;
    cloud_stream_type: string | null;
    enabled: boolean;
  }): Promise<Camera> {
    const existing = await this._get(
      "SELECT * FROM cameras WHERE cloud_account_id = ? AND cloud_vendor_camera_id = ?",
      [input.cloud_account_id, input.cloud_vendor_camera_id],
    );
    if (existing) {
      const cam = rowToCamera(existing as Record<string, unknown>);
      await this._run(
        `UPDATE cameras SET name = ?, cloud_stream_url = ?, cloud_stream_type = ?, enabled = ? WHERE id = ?`,
        [input.name, input.cloud_stream_url, input.cloud_stream_type, Boolean(input.enabled), cam.id],
      );
      void this.notify("cameras", "update", cam.id);
      return (await this.getCameraById(cam.id))!;
    }
    const id = uuidv7();
    await this._run(
      `INSERT INTO cameras
         (id, name, type, cloud_account_id, cloud_vendor_camera_id, cloud_stream_url, cloud_stream_type, enabled)
       VALUES (?, ?, 'cloud', ?, ?, ?, ?, ?)`,
      [id, input.name, input.cloud_account_id, input.cloud_vendor_camera_id,
       input.cloud_stream_url, input.cloud_stream_type, Boolean(input.enabled)],
    );
    void this.notify("cameras", "create", id);
    const c = await this.getCameraById(id);
    if (!c) throw new Error("cloud camera vanished after insert");
    await this.ensureCameraEntity(c);
    return c;
  }

  async listCloudCamerasByAccount(accountId: string): Promise<Camera[]> {
    const rs = await this._all(
      "SELECT * FROM cameras WHERE cloud_account_id = ? ORDER BY name",
      [accountId],
    );
    return rs.map((r) => rowToCamera(r as Record<string, unknown>));
  }

  async deleteCloudCamerasNotIn(accountId: string, keepVendorIds: string[]): Promise<number> {
    if (keepVendorIds.length === 0) {
      const result = await this._run(
        "DELETE FROM cameras WHERE cloud_account_id = ?",
        [accountId],
      );
      return result.changes;
    }
    const placeholders = keepVendorIds.map(() => "?").join(",");
    const result = await this._run(
      `DELETE FROM cameras WHERE cloud_account_id = ? AND cloud_vendor_camera_id NOT IN (${placeholders})`,
      [accountId, ...keepVendorIds],
    );
    return result.changes;
  }

  async listCameraStreams(cameraId: string): Promise<CameraStream[]> {
    const rs = await this._all(
      "SELECT * FROM camera_streams WHERE camera_id = ?",
      [cameraId],
    );
    return rs.map((r) => rowToCameraStream(r as Record<string, unknown>));
  }

  async createCameraStream(input: {
    camera_id: string;
    role: StreamRole;
    name: string;
    rtsp_uri: string;
    profile_token?: string | null;
    width?: number | null;
    height?: number | null;
    encoding?: string | null;
    framerate?: number | null;
    bitrate_kbps?: number | null;
    is_discovered?: boolean;
  }): Promise<CameraStream> {
    const id = uuidv7();
    await this._run(
      `INSERT INTO camera_streams
        (id, camera_id, role, name, profile_token, rtsp_uri,
         width, height, encoding, framerate, bitrate_kbps, is_discovered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.camera_id,
        input.role,
        input.name,
        input.profile_token ?? null,
        input.rtsp_uri,
        input.width ?? null,
        input.height ?? null,
        input.encoding ?? null,
        input.framerate ?? null,
        input.bitrate_kbps ?? null,
        Boolean(input.is_discovered),
      ],
    );
    const r = await this._get("SELECT * FROM camera_streams WHERE id = ?", [id]);
    if (!r) throw new Error("camera_stream vanished after insert");
    void this.notify("camera_streams", "create", id);
    return rowToCameraStream(r as Record<string, unknown>);
  }

  async updateCameraStream(id: string, patch: Partial<CameraStream>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "camera_id") continue;
      sets.push(`${k} = ?`);
      vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE camera_streams SET ${sets.join(", ")} WHERE id = ?`, vals);
    void this.notify("camera_streams", "update", id);
  }

  // ===========================================================================
  // labels (incl. join tables)
  // ===========================================================================

  async listLabels(): Promise<Label[]> {
    const rs = await this._all("SELECT * FROM labels ORDER BY name");
    return rs.map((r) => rowToLabel(r as Record<string, unknown>));
  }

  async getLabelByName(name: string): Promise<Label | null> {
    const r = await this._get("SELECT * FROM labels WHERE name = ?", [name]);
    return r ? rowToLabel(r as Record<string, unknown>) : null;
  }

  async createLabel(input: {
    name: string;
    description?: string | null;
    color?: string | null;
  }): Promise<Label> {
    const id = uuidv7();
    await this._run(
      `INSERT INTO labels (id, name, description, color)
       VALUES (?, ?, ?, ?)`,
      [id, input.name, input.description ?? null, input.color ?? null],
    );
    void this.notify("labels", "create", id);
    const r = await this._get("SELECT * FROM labels WHERE id = ?", [id]);
    if (!r) throw new Error("label vanished after insert");
    return rowToLabel(r as Record<string, unknown>);
  }

  /** Get-or-create label by name (used during pairing's free-text label input). */
  async ensureLabel(name: string): Promise<Label> {
    return (await this.getLabelByName(name)) ?? (await this.createLabel({ name }));
  }

  async attachKioskLabel(kioskId: string, labelId: string, role: LabelRole): Promise<void> {
    await this._run(
      `INSERT OR IGNORE INTO kiosk_labels (kiosk_id, label_id, role)
       VALUES (?, ?, ?)`,
      [kioskId, labelId, role],
    );
  }

  async listKioskLabels(kioskId: string): Promise<Array<KioskLabel & { name: string }>> {
    const rs = await this._all(
      `SELECT kl.kiosk_id, kl.label_id, kl.role, l.name
         FROM kiosk_labels kl
         JOIN labels l ON l.id = kl.label_id
        WHERE kl.kiosk_id = ?`,
      [kioskId],
    );
    return rs.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        kiosk_id: String(row["kiosk_id"]),
        label_id: String(row["label_id"]),
        role: String(row["role"]) as LabelRole,
        name: String(row["name"]),
      };
    });
  }

  async attachCameraLabel(cameraId: string, labelId: string): Promise<void> {
    await this._run(
      `INSERT OR IGNORE INTO camera_labels (camera_id, label_id)
       VALUES (?, ?)`,
      [cameraId, labelId],
    );
  }

  async attachLayoutLabel(layoutId: string, labelId: string): Promise<void> {
    await this._run(
      `INSERT OR IGNORE INTO layout_labels (layout_id, label_id)
       VALUES (?, ?)`,
      [layoutId, labelId],
    );
  }

  // ===========================================================================
  // ioBOX models + serial inventory (PUBLIC schema)
  // ===========================================================================

  async listIoBoxModels(): Promise<IoBoxModel[]> {
    const rs = await this._all("SELECT * FROM public.iobox_models ORDER BY name");
    return rs.map((r) => rowToIoBoxModel(r as Record<string, unknown>));
  }

  async getIoBoxModel(id: string): Promise<IoBoxModel | null> {
    const r = await this._get("SELECT * FROM public.iobox_models WHERE id = ?", [id]);
    return r ? rowToIoBoxModel(r as Record<string, unknown>) : null;
  }

  async createIoBoxModel(input: {
    id: string;
    name: string;
    description?: string | null;
    hardware_variant: "wifi" | "ethernet";
    firmware_arch?: string;
    firmware_track?: string;
    capabilities_json?: Record<string, unknown>;
    ports_json?: unknown[];
  }): Promise<IoBoxModel> {
    await this._run(
      `INSERT INTO public.iobox_models
        (id, name, description, hardware_variant, firmware_arch, firmware_track, capabilities_json, ports_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.name,
        input.description ?? null,
        input.hardware_variant,
        input.firmware_arch ?? "esp32s3",
        input.firmware_track ?? "stable",
        J(input.capabilities_json ?? {}),
        J(input.ports_json ?? []),
      ],
    );
    void this.notify("iobox_models", "create", input.id);
    const model = await this.getIoBoxModel(input.id);
    if (!model) throw new Error("ioBOX model vanished after insert");
    return model;
  }

  async updateIoBoxModel(id: string, patch: Partial<IoBoxModel>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "created_at") continue;
      sets.push(`${k} = ?`);
      vals.push(k.endsWith("_json") ? J(v ?? (k === "ports_json" ? [] : {})) : v ?? null);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE public.iobox_models SET ${sets.join(", ")} WHERE id = ?`, vals);
    void this.notify("iobox_models", "update", id);
  }

  async deleteIoBoxModel(id: string): Promise<void> {
    await this._run("DELETE FROM public.iobox_models WHERE id = ?", [id]);
    void this.notify("iobox_models", "delete", id);
  }

  async listIoBoxSerials(): Promise<IoBoxSerial[]> {
    const rs = await this._all("SELECT * FROM public.iobox_serials ORDER BY registered_at DESC");
    return rs.map((r) => rowToIoBoxSerial(r as Record<string, unknown>));
  }

  async getIoBoxSerial(serial: string): Promise<IoBoxSerial | null> {
    const r = await this._get("SELECT * FROM public.iobox_serials WHERE serial = ?", [serial]);
    return r ? rowToIoBoxSerial(r as Record<string, unknown>) : null;
  }

  async registerIoBoxSerial(input: {
    serial: string;
    model_id: string;
    notes?: string | null;
  }): Promise<IoBoxSerial> {
    await this._run(
      `INSERT INTO public.iobox_serials (serial, model_id, notes)
       VALUES (?, ?, ?)
       ON CONFLICT (serial) DO UPDATE SET model_id = ?, notes = ?`,
      [input.serial, input.model_id, input.notes ?? null, input.model_id, input.notes ?? null],
    );
    void this.notify("iobox_serials", "update", input.serial);
    const row = await this.getIoBoxSerial(input.serial);
    if (!row) throw new Error("ioBOX serial vanished after upsert");
    return row;
  }

  async touchIoBoxSerial(serial: string): Promise<void> {
    await this._run("UPDATE public.iobox_serials SET last_seen_at = ? WHERE serial = ?", [isoNow(), serial]);
  }

  async markIoBoxSerialPaired(serial: string, tenantId: string | null, ioBoxId: string): Promise<void> {
    await this._run(
      `UPDATE public.iobox_serials
          SET paired_tenant_id = ?, paired_iobox_id = ?, last_seen_at = ?
        WHERE serial = ?`,
      [tenantId, ioBoxId, isoNow(), serial],
    );
  }

  // ===========================================================================
  // ioBOX devices (tenant schema)
  // ===========================================================================

  async listIoBoxes(): Promise<IoBox[]> {
    const rs = await this._all("SELECT * FROM ioboxes ORDER BY name");
    return rs.map((r) => rowToIoBox(r as Record<string, unknown>));
  }

  async getIoBoxById(id: string): Promise<IoBox | null> {
    const r = await this._get("SELECT * FROM ioboxes WHERE id = ?", [id]);
    return r ? rowToIoBox(r as Record<string, unknown>) : null;
  }

  async getIoBoxBySerial(serial: string): Promise<IoBox | null> {
    const r = await this._get("SELECT * FROM ioboxes WHERE serial = ?", [serial]);
    return r ? rowToIoBox(r as Record<string, unknown>) : null;
  }

  async listIoBoxesByKeyPrefix(prefix: string): Promise<IoBox[]> {
    const rs = await this._all(
      "SELECT * FROM ioboxes WHERE key_prefix = ? AND enabled = true",
      [prefix],
    );
    return rs.map((r) => rowToIoBox(r as Record<string, unknown>));
  }

  async createIoBox(input: {
    serial: string;
    model_id: string;
    name: string;
    key_hash: string;
    key_prefix: string;
    assigned_display_id?: string | null;
  }): Promise<IoBox> {
    const id = uuidv7();
    await this._run(
      `INSERT INTO ioboxes
        (id, serial, model_id, name, key_hash, key_prefix, paired_at, assigned_display_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.serial,
        input.model_id,
        input.name,
        input.key_hash,
        input.key_prefix,
        isoNow(),
        input.assigned_display_id ?? null,
      ],
    );
    void this.notify("ioboxes", "create", id);
    const box = await this.getIoBoxById(id);
    if (!box) throw new Error("ioBOX vanished after insert");
    return box;
  }

  async updateIoBox(id: string, patch: Partial<IoBox>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "created_at" || k === "paired_at") continue;
      sets.push(`${k} = ?`);
      vals.push(k.endsWith("_json") ? J(v ?? {}) : v ?? null);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE ioboxes SET ${sets.join(", ")} WHERE id = ?`, vals);
    void this.notify("ioboxes", "update", id);
  }

  async touchIoBox(id: string, patch: {
    firmware_version?: string | null;
    config_applied_version?: number | null;
    config_error?: string | null;
    route_mode?: string | null;
    local_last_ip?: string | null;
    network_json?: Record<string, unknown> | null;
  }): Promise<void> {
    await this._run(
      `UPDATE ioboxes SET
         last_seen_at = ?,
         firmware_version = COALESCE(?, firmware_version),
         config_applied_version = COALESCE(?, config_applied_version),
         config_applied_at = COALESCE(?::timestamptz, config_applied_at),
         config_error = ?,
         route_mode = COALESCE(?, route_mode),
         local_last_ip = COALESCE(?, local_last_ip),
         network_json = COALESCE(?::jsonb, network_json)
       WHERE id = ?`,
      [
        isoNow(),
        patch.firmware_version ?? null,
        patch.config_applied_version ?? null,
        patch.config_applied_version !== undefined && patch.config_applied_version !== null ? isoNow() : null,
        patch.config_error ?? null,
        patch.route_mode ?? null,
        patch.local_last_ip ?? null,
        patch.network_json ? J(patch.network_json) : null,
        id,
      ],
    );
    void this.notify("ioboxes", "update", id);
  }

  async listIoBoxMappingsForDisplay(displayId: string): Promise<IoBoxInputMapping[]> {
    const rs = await this._all(
      `SELECT * FROM iobox_input_mappings
        WHERE enabled = true AND (display_id = ? OR display_id IS NULL)
        ORDER BY created_at`,
      [displayId],
    );
    return rs.map((r) => rowToIoBoxInputMapping(r as Record<string, unknown>));
  }

  async listIoBoxMappingsForIoBox(ioBoxId: string): Promise<IoBoxInputMapping[]> {
    const rs = await this._all(
      "SELECT * FROM iobox_input_mappings WHERE iobox_id = ? ORDER BY created_at",
      [ioBoxId],
    );
    return rs.map((r) => rowToIoBoxInputMapping(r as Record<string, unknown>));
  }

  async createIoBoxMapping(input: {
    iobox_id?: string | null;
    display_id?: string | null;
    layout_id?: string | null;
    cell_id?: string | null;
    source_kind: string;
    match_json?: Record<string, unknown>;
    target_kind: string;
    action: string;
    params_json?: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<IoBoxInputMapping> {
    const id = uuidv7();
    await this._run(
      `INSERT INTO iobox_input_mappings
        (id, iobox_id, display_id, layout_id, cell_id, source_kind, match_json, target_kind, action, params_json, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.iobox_id ?? null,
        input.display_id ?? null,
        input.layout_id ?? null,
        input.cell_id ?? null,
        input.source_kind,
        J(input.match_json ?? {}),
        input.target_kind,
        input.action,
        J(input.params_json ?? {}),
        input.enabled ?? true,
      ],
    );
    void this.notify("iobox_input_mappings", "create", id);
    const row = await this._get("SELECT * FROM iobox_input_mappings WHERE id = ?", [id]);
    if (!row) throw new Error("ioBOX mapping vanished after insert");
    return rowToIoBoxInputMapping(row as Record<string, unknown>);
  }

  async deleteIoBoxMapping(id: string): Promise<void> {
    await this._run("DELETE FROM iobox_input_mappings WHERE id = ?", [id]);
    void this.notify("iobox_input_mappings", "delete", id);
  }

  async createIoBoxFirmwareRelease(input: {
    id: string;
    version: string;
    channel: FirmwareChannel;
    firmware_arch: string;
    model_id?: string | null;
    artifact_path: string;
    size_bytes: number;
    sha256: string;
    signature: string;
    release_notes?: string | null;
    uploaded_by?: string | null;
  }): Promise<IoBoxFirmwareRelease> {
    await this._run(
      `INSERT INTO iobox_firmware_releases
        (id, version, channel, firmware_arch, model_id, artifact_path, size_bytes, sha256, signature, release_notes, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (version, firmware_arch, model_id) DO UPDATE SET
         channel = EXCLUDED.channel,
         artifact_path = EXCLUDED.artifact_path,
         size_bytes = EXCLUDED.size_bytes,
         sha256 = EXCLUDED.sha256,
         signature = EXCLUDED.signature,
         release_notes = EXCLUDED.release_notes,
         uploaded_by = EXCLUDED.uploaded_by,
         uploaded_at = now(),
         yanked_at = NULL`,
      [
        input.id,
        input.version,
        input.channel,
        input.firmware_arch,
        input.model_id ?? null,
        input.artifact_path,
        input.size_bytes,
        input.sha256,
        input.signature,
        input.release_notes ?? null,
        input.uploaded_by ?? null,
      ],
    );
    void this.notify("iobox_firmware_releases", "update", input.id);
    const row = await this.getIoBoxFirmwareReleaseByVersionArchModel(input.version, input.firmware_arch, input.model_id ?? null);
    if (!row) throw new Error("ioBOX firmware release vanished after insert");
    return row;
  }

  async getIoBoxFirmwareRelease(id: string): Promise<IoBoxFirmwareRelease | null> {
    const r = await this._get("SELECT * FROM iobox_firmware_releases WHERE id = ?", [id]);
    return r ? rowToIoBoxFirmwareRelease(r as Record<string, unknown>) : null;
  }

  async getIoBoxFirmwareReleaseByVersionArchModel(version: string, firmwareArch: string, modelId: string | null): Promise<IoBoxFirmwareRelease | null> {
    const r = await this._get(
      `SELECT * FROM iobox_firmware_releases
        WHERE version = ? AND firmware_arch = ? AND model_id IS NOT DISTINCT FROM ?`,
      [version, firmwareArch, modelId],
    );
    return r ? rowToIoBoxFirmwareRelease(r as Record<string, unknown>) : null;
  }

  async getLatestIoBoxFirmwareRelease(channel: FirmwareChannel, firmwareArch: string, modelId: string | null): Promise<IoBoxFirmwareRelease | null> {
    const r = await this._get(
      `SELECT * FROM iobox_firmware_releases
        WHERE channel = ?
          AND firmware_arch = ?
          AND yanked_at IS NULL
          AND (model_id IS NULL OR model_id = ?)
        ORDER BY CASE WHEN model_id = ? THEN 0 ELSE 1 END, uploaded_at DESC
        LIMIT 1`,
      [channel, firmwareArch, modelId, modelId],
    );
    return r ? rowToIoBoxFirmwareRelease(r as Record<string, unknown>) : null;
  }

  async listIoBoxFirmwareReleases(): Promise<IoBoxFirmwareRelease[]> {
    const rs = await this._all("SELECT * FROM iobox_firmware_releases ORDER BY uploaded_at DESC");
    return rs.map((r) => rowToIoBoxFirmwareRelease(r as Record<string, unknown>));
  }

  // ===========================================================================
  // kiosks
  // ===========================================================================

  async listKiosks(): Promise<Kiosk[]> {
    const rs = await this._all("SELECT * FROM kiosks ORDER BY name");
    return rs.map((r) => rowToKiosk(r as Record<string, unknown>));
  }

  async getKioskById(id: string): Promise<Kiosk | null> {
    const r = await this._get("SELECT * FROM kiosks WHERE id = ?", [id]);
    return r ? rowToKiosk(r as Record<string, unknown>) : null;
  }

  async getKioskByName(name: string): Promise<Kiosk | null> {
    const r = await this._get("SELECT * FROM kiosks WHERE name = ?", [name]);
    return r ? rowToKiosk(r as Record<string, unknown>) : null;
  }

  /** Lookup candidates by Bearer-key prefix; verify hash at the call site. */
  async listKiosksByKeyPrefix(prefix: string): Promise<Kiosk[]> {
    const rs = await this._all(
      "SELECT * FROM kiosks WHERE key_prefix = ? AND enabled = true",
      [prefix],
    );
    return rs.map((r) => rowToKiosk(r as Record<string, unknown>));
  }

  async createKiosk(input: {
    name: string;
    key_hash: string;
    key_prefix: string;
    capabilities?: string[];
    hardware_model?: string | null;
    firmware_target?: string | null;
    managed_image?: boolean;
  }): Promise<Kiosk> {
    const id = uuidv7();
    await this._run(
      `INSERT INTO kiosks
        (id, name, key_hash, key_prefix, capabilities, hardware_model, firmware_target, paired_at, managed_image)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.key_hash,
        input.key_prefix,
        J(input.capabilities ?? []),
        input.hardware_model ?? null,
        input.firmware_target ?? null,
        isoNow(),
        input.managed_image ? 1 : 0,
      ],
    );
    void this.notify("kiosks", "create", id);
    const k = await this.getKioskById(id);
    if (!k) throw new Error("kiosk vanished after insert");
    return k;
  }

  /**
   * Rekey an existing kiosk for a replacement device. Preserves identity
   * (id, name) and downstream references (display_id, labels, gpio bindings,
   * layouts that mention it), but issues fresh credentials + capabilities and
   * resets transient runtime state so the old hardware can't reconnect.
   */
  async replaceKioskKey(
    id: string,
    input: {
      key_hash: string;
      key_prefix: string;
      capabilities?: string[];
      hardware_model?: string | null;
      firmware_target?: string | null;
    },
  ): Promise<void> {
    await this._run(
      `UPDATE kiosks SET
         key_hash = ?,
         key_prefix = ?,
         capabilities = ?,
         hardware_model = ?,
         firmware_target = ?,
         paired_at = ?,
         last_seen_at = NULL,
         last_bundle_version = NULL,
         kiosk_app_version = NULL,
         os_version = NULL,
         cpu_temp_c = NULL,
         cpu_load_percent = NULL,
         fan_rpm = NULL,
         fan_pwm = NULL,
         memory_total_mb = NULL,
         memory_used_mb = NULL,
         disk_total_mb = NULL,
         disk_free_mb = NULL,
         disk_used_percent = NULL
       WHERE id = ?`,
      [
        input.key_hash,
        input.key_prefix,
        J(input.capabilities ?? []),
        input.hardware_model ?? null,
        input.firmware_target ?? null,
        isoNow(),
        id,
      ],
    );
    void this.notify("kiosks", "update", id);
  }

  async touchKiosk(
    id: string,
    patch: {
      bundle_version?: string | null;
      kiosk_app_version?: string | null;
      firmware_target?: string | null;
      os_version?: string | null;
      os_update_compatibility?: string | null;
      cpu_temp_c?: number | null;
      cpu_load_percent?: number | null;
      gpu_load_percent?: number | null;
      fan_rpm?: number | null;
      fan_pwm?: number | null;
      memory_total_mb?: number | null;
      memory_used_mb?: number | null;
      disk_total_mb?: number | null;
      disk_free_mb?: number | null;
      disk_used_percent?: number | null;
      local_key?: string | null;
      local_port?: number | null;
      local_last_ip?: string | null;
      reported_hostname?: string | null;
      network_interfaces_json?: string | null;
      logging_json?: string | null;
      partitions_json?: string | null;
      renderer_telemetry_json?: string | null;
    },
  ): Promise<void> {
    await this._run(
      `UPDATE kiosks SET
         last_seen_at = ?,
         last_bundle_version = COALESCE(?, last_bundle_version),
         kiosk_app_version = COALESCE(?, kiosk_app_version),
         firmware_target = COALESCE(?, firmware_target),
         os_version = COALESCE(?, os_version),
         os_update_compatibility = COALESCE(?, os_update_compatibility),
         cpu_temp_c = ?,
         cpu_load_percent = ?,
         gpu_load_percent = ?,
         fan_rpm = ?,
         fan_pwm = ?,
         memory_total_mb = ?,
         memory_used_mb = ?,
         disk_total_mb = ?,
         disk_free_mb = ?,
         disk_used_percent = ?,
         local_key = COALESCE(?, local_key),
         local_port = COALESCE(?, local_port),
         local_last_ip = COALESCE(?, local_last_ip),
         reported_hostname = COALESCE(?, reported_hostname),
         network_interfaces_json = COALESCE(?, network_interfaces_json),
         logging_json = COALESCE(?, logging_json),
         partitions_json = COALESCE(?, partitions_json),
         renderer_telemetry_json = COALESCE(?, renderer_telemetry_json)
       WHERE id = ?`,
      [
        isoNow(),
        patch.bundle_version ?? null,
        patch.kiosk_app_version ?? null,
        patch.firmware_target ?? null,
        patch.os_version ?? null,
        patch.os_update_compatibility ?? null,
        patch.cpu_temp_c ?? null,
        patch.cpu_load_percent ?? null,
        patch.gpu_load_percent ?? null,
        patch.fan_rpm ?? null,
        patch.fan_pwm ?? null,
        patch.memory_total_mb ?? null,
        patch.memory_used_mb ?? null,
        patch.disk_total_mb ?? null,
        patch.disk_free_mb ?? null,
        patch.disk_used_percent ?? null,
        patch.local_key ?? null,
        patch.local_port ?? null,
        patch.local_last_ip ?? null,
        patch.reported_hostname ?? null,
        patch.network_interfaces_json ?? null,
        patch.logging_json ?? null,
        patch.partitions_json ?? null,
        patch.renderer_telemetry_json ?? null,
        id,
      ],
    );
  }

  // ===========================================================================
  // audit_log
  // ===========================================================================

  async insertAudit(input: {
    actor_type: AuditActorType;
    actor_id: string | null;
    actor_label: string | null;
    action: string;
    resource_type: string | null;
    resource_id: string | null;
    ip: string | null;
    metadata: Record<string, unknown>;
    result: AuditResult;
  }): Promise<void> {
    await this._run(
      `INSERT INTO audit_log
         (actor_type, actor_id, actor_label, action, resource_type,
          resource_id, ip, metadata, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.actor_type,
        input.actor_id,
        input.actor_label,
        input.action,
        input.resource_type,
        input.resource_id,
        input.ip,
        J(input.metadata),
        input.result,
      ],
    );
  }

  async listAudit(opts: {
    limit?: number;
    actor_type?: AuditActorType;
    action_prefix?: string;
  } = {}): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.actor_type) {
      where.push("actor_type = ?");
      args.push(opts.actor_type);
    }
    if (opts.action_prefix) {
      where.push("action LIKE ?");
      args.push(`${opts.action_prefix}%`);
    }
    const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts DESC LIMIT ?`;
    args.push(limit);
    const rs = await this._all(sql, args);
    return rs.map((r) => rowToAuditEntry(r as Record<string, unknown>));
  }

  // ===========================================================================
  // firmware_releases + firmware_rollouts
  // ===========================================================================

  async createFirmwareRelease(input: {
    id: string;
    version: string;
    channel: FirmwareChannel;
    arch: string;
    artifact_path: string;
    size_bytes: number;
    sha256: string;
    signature: string;
    release_notes: string | null;
    uploaded_by: string | null;
  }): Promise<FirmwareRelease> {
    await this._run(
      `INSERT INTO firmware_releases
         (id, version, channel, arch, artifact_path, size_bytes, sha256,
          signature, release_notes, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.version,
        input.channel,
        input.arch,
        input.artifact_path,
        input.size_bytes,
        input.sha256,
        input.signature,
        input.release_notes,
        input.uploaded_by,
      ],
    );
    void this.notify("firmware_releases", "create", input.id);
    const r = await this.getFirmwareRelease(input.id);
    if (!r) throw new Error("firmware release vanished after insert");
    return r;
  }

  async getFirmwareRelease(id: string): Promise<FirmwareRelease | null> {
    const r = await this._get("SELECT * FROM firmware_releases WHERE id = ?", [id]);
    return r ? rowToFirmwareRelease(r as Record<string, unknown>) : null;
  }

  async getFirmwareReleaseByVersionArch(version: string, arch: string): Promise<FirmwareRelease | null> {
    const r = await this._get(
      "SELECT * FROM firmware_releases WHERE version = ? AND arch = ?",
      [version, arch],
    );
    return r ? rowToFirmwareRelease(r as Record<string, unknown>) : null;
  }

  /** Latest non-yanked release for a (channel, arch) pair. */
  async getLatestFirmwareRelease(channel: FirmwareChannel, arch: string): Promise<FirmwareRelease | null> {
    const r = await this._get(
      `SELECT * FROM firmware_releases
         WHERE channel = ? AND arch = ? AND yanked_at IS NULL
         ORDER BY uploaded_at DESC
         LIMIT 1`,
      [channel, arch],
    );
    return r ? rowToFirmwareRelease(r as Record<string, unknown>) : null;
  }

  async listFirmwareReleases(): Promise<FirmwareRelease[]> {
    const rs = await this._all(
      "SELECT * FROM firmware_releases ORDER BY uploaded_at DESC",
    );
    return rs.map((r) => rowToFirmwareRelease(r as Record<string, unknown>));
  }

  async yankFirmwareRelease(id: string): Promise<void> {
    await this._run("UPDATE firmware_releases SET yanked_at = ? WHERE id = ?", [isoNow(), id]);
    void this.notify("firmware_releases", "update", id);
  }

  async deleteFirmwareRelease(id: string): Promise<void> {
    await this._run("DELETE FROM firmware_releases WHERE id = ?", [id]);
    void this.notify("firmware_releases", "delete", id);
  }

  async listYankedFirmwareReleases(): Promise<FirmwareRelease[]> {
    const rs = await this._all(
      "SELECT * FROM firmware_releases WHERE yanked_at IS NOT NULL ORDER BY yanked_at ASC",
    );
    return rs.map((r) => rowToFirmwareRelease(r as Record<string, unknown>));
  }

  /** Mark the per-kiosk firmware attempt state (called from /api/kiosk/firmware/applied). */
  async recordKioskFirmwareAttempt(
    kioskId: string,
    version: string,
    error: string | null,
  ): Promise<void> {
    await this._run(
      `UPDATE kiosks SET
         firmware_last_attempt_at = ?,
         firmware_last_attempt_version = ?,
         firmware_last_error = ?
       WHERE id = ?`,
      [isoNow(), version, error, kioskId],
    );
    void this.notify("kiosks", "update", kioskId);
  }

  /** Set the per-kiosk update channel + optional explicit version pin. */
  async setKioskFirmwarePref(
    kioskId: string,
    patch: { channel?: FirmwareChannel; target_version?: string | null },
  ): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.channel !== undefined) {
      sets.push("firmware_channel = ?");
      vals.push(patch.channel);
    }
    if (patch.target_version !== undefined) {
      sets.push("firmware_target_version = ?");
      vals.push(patch.target_version);
    }
    if (sets.length === 0) return;
    vals.push(kioskId);
    await this._run(`UPDATE kiosks SET ${sets.join(", ")} WHERE id = ?`, vals);
    void this.notify("kiosks", "update", kioskId);
  }

  async createFirmwareRollout(input: {
    id: string;
    release_id: string;
    target_kiosk_ids: string[];
    percentage: number;
    created_by: string | null;
  }): Promise<FirmwareRollout> {
    await this._run(
      `INSERT INTO firmware_rollouts
         (id, release_id, target_kiosk_ids, percentage, created_by, state)
       VALUES (?, ?, ?, ?, ?, 'queued')`,
      [
        input.id,
        input.release_id,
        J(input.target_kiosk_ids),
        input.percentage,
        input.created_by,
      ],
    );
    void this.notify("firmware_rollouts", "create", input.id);
    const r = await this.getFirmwareRollout(input.id);
    if (!r) throw new Error("rollout vanished after insert");
    return r;
  }

  async getFirmwareRollout(id: string): Promise<FirmwareRollout | null> {
    const r = await this._get("SELECT * FROM firmware_rollouts WHERE id = ?", [id]);
    return r ? rowToFirmwareRollout(r as Record<string, unknown>) : null;
  }

  /**
   * Active rollouts whose target list either includes this kiosk OR is
   * empty (= "all kiosks on the release channel"). Ordered most-recent first
   * so a newer rollout supersedes older ones.
   */
  async listActiveRolloutsForKiosk(kioskId: string): Promise<FirmwareRollout[]> {
    const rs = await this._all(
      `SELECT * FROM firmware_rollouts WHERE state = 'active' ORDER BY created_at DESC`,
    );
    return rs
      .map((r) => rowToFirmwareRollout(r as Record<string, unknown>))
      .filter((r) => r.target_kiosk_ids.length === 0 || r.target_kiosk_ids.includes(kioskId));
  }

  async listFirmwareRollouts(): Promise<FirmwareRollout[]> {
    const rs = await this._all(
      "SELECT * FROM firmware_rollouts ORDER BY created_at DESC",
    );
    return rs.map((r) => rowToFirmwareRollout(r as Record<string, unknown>));
  }

  async updateFirmwareRolloutState(
    id: string,
    state: FirmwareRolloutState,
  ): Promise<void> {
    const now = isoNow();
    if (state === "active") {
      await this._run(
        `UPDATE firmware_rollouts SET state = ?, started_at = COALESCE(started_at, ?) WHERE id = ?`,
        [state, now, id],
      );
    } else if (state === "complete") {
      await this._run(
        `UPDATE firmware_rollouts SET state = ?, finished_at = ? WHERE id = ?`,
        [state, now, id],
      );
    } else {
      await this._run(`UPDATE firmware_rollouts SET state = ? WHERE id = ?`, [state, id]);
    }
    void this.notify("firmware_rollouts", "update", id);
  }

  // ===========================================================================
  // os_update_releases + os_update_rollouts
  // ===========================================================================

  async createOsUpdateRelease(input: {
    id: string;
    version: string;
    channel: FirmwareChannel;
    compatibility: string;
    artifact_path: string;
    size_bytes: number;
    sha256: string;
    release_notes: string | null;
    uploaded_by: string | null;
  }): Promise<OsUpdateRelease> {
    await this._run(
      `INSERT INTO os_update_releases
         (id, version, channel, compatibility, artifact_path, size_bytes, sha256,
          bundle_format, release_notes, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'raucb', ?, ?)`,
      [
        input.id,
        input.version,
        input.channel,
        input.compatibility,
        input.artifact_path,
        input.size_bytes,
        input.sha256,
        input.release_notes,
        input.uploaded_by,
      ],
    );
    void this.notify("os_update_releases", "create", input.id);
    const r = await this.getOsUpdateRelease(input.id);
    if (!r) throw new Error("OS update release vanished after insert");
    return r;
  }

  async getOsUpdateRelease(id: string): Promise<OsUpdateRelease | null> {
    const r = await this._get("SELECT * FROM os_update_releases WHERE id = ?", [id]);
    return r ? rowToOsUpdateRelease(r as Record<string, unknown>) : null;
  }

  async getOsUpdateReleaseByVersionCompatibility(version: string, compatibility: string): Promise<OsUpdateRelease | null> {
    const r = await this._get(
      "SELECT * FROM os_update_releases WHERE version = ? AND compatibility = ?",
      [version, compatibility],
    );
    return r ? rowToOsUpdateRelease(r as Record<string, unknown>) : null;
  }

  async getLatestOsUpdateRelease(channel: FirmwareChannel, compatibility: string): Promise<OsUpdateRelease | null> {
    const r = await this._get(
      `SELECT * FROM os_update_releases
         WHERE channel = ? AND compatibility = ? AND yanked_at IS NULL
         ORDER BY uploaded_at DESC
         LIMIT 1`,
      [channel, compatibility],
    );
    return r ? rowToOsUpdateRelease(r as Record<string, unknown>) : null;
  }

  async listOsUpdateReleases(): Promise<OsUpdateRelease[]> {
    const rs = await this._all(
      "SELECT * FROM os_update_releases ORDER BY uploaded_at DESC",
    );
    return rs.map((r) => rowToOsUpdateRelease(r as Record<string, unknown>));
  }

  async yankOsUpdateRelease(id: string): Promise<void> {
    await this._run("UPDATE os_update_releases SET yanked_at = ? WHERE id = ?", [isoNow(), id]);
    void this.notify("os_update_releases", "update", id);
  }

  async deleteOsUpdateRelease(id: string): Promise<void> {
    await this._run("DELETE FROM os_update_releases WHERE id = ?", [id]);
    void this.notify("os_update_releases", "delete", id);
  }

  async listYankedOsUpdateReleases(): Promise<OsUpdateRelease[]> {
    const rs = await this._all(
      "SELECT * FROM os_update_releases WHERE yanked_at IS NOT NULL ORDER BY yanked_at ASC",
    );
    return rs.map((r) => rowToOsUpdateRelease(r as Record<string, unknown>));
  }

  async recordKioskOsUpdateAttempt(
    kioskId: string,
    version: string,
    error: string | null,
    state?: Kiosk["os_update_state"],
  ): Promise<void> {
    await this._run(
      `UPDATE kiosks SET
         os_update_last_attempt_at = ?,
         os_update_last_attempt_version = ?,
         os_update_last_error = ?,
         os_update_state = COALESCE(?, os_update_state)
       WHERE id = ?`,
      [isoNow(), version, error, state ?? null, kioskId],
    );
    void this.notify("kiosks", "update", kioskId);
  }

  async setKioskOsUpdatePref(
    kioskId: string,
    patch: { channel?: FirmwareChannel; target_version?: string | null },
  ): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.channel !== undefined) {
      sets.push("os_update_channel = ?");
      vals.push(patch.channel);
    }
    if (patch.target_version !== undefined) {
      sets.push("os_update_target_version = ?");
      vals.push(patch.target_version);
    }
    if (sets.length === 0) return;
    vals.push(kioskId);
    await this._run(`UPDATE kiosks SET ${sets.join(", ")} WHERE id = ?`, vals);
    void this.notify("kiosks", "update", kioskId);
  }

  async createOsUpdateRollout(input: {
    id: string;
    release_id: string;
    target_kiosk_ids: string[];
    percentage: number;
    created_by: string | null;
  }): Promise<OsUpdateRollout> {
    await this._run(
      `INSERT INTO os_update_rollouts
         (id, release_id, target_kiosk_ids, percentage, created_by, state)
       VALUES (?, ?, ?, ?, ?, 'queued')`,
      [
        input.id,
        input.release_id,
        J(input.target_kiosk_ids),
        input.percentage,
        input.created_by,
      ],
    );
    void this.notify("os_update_rollouts", "create", input.id);
    const r = await this.getOsUpdateRollout(input.id);
    if (!r) throw new Error("OS update rollout vanished after insert");
    return r;
  }

  async getOsUpdateRollout(id: string): Promise<OsUpdateRollout | null> {
    const r = await this._get("SELECT * FROM os_update_rollouts WHERE id = ?", [id]);
    return r ? rowToOsUpdateRollout(r as Record<string, unknown>) : null;
  }

  async listActiveOsUpdateRolloutsForKiosk(kioskId: string): Promise<OsUpdateRollout[]> {
    const rs = await this._all(
      `SELECT * FROM os_update_rollouts WHERE state = 'active' ORDER BY created_at DESC`,
    );
    return rs
      .map((r) => rowToOsUpdateRollout(r as Record<string, unknown>))
      .filter((r) => r.target_kiosk_ids.length === 0 || r.target_kiosk_ids.includes(kioskId));
  }

  async listOsUpdateRollouts(): Promise<OsUpdateRollout[]> {
    const rs = await this._all(
      "SELECT * FROM os_update_rollouts ORDER BY created_at DESC",
    );
    return rs.map((r) => rowToOsUpdateRollout(r as Record<string, unknown>));
  }

  async updateOsUpdateRolloutState(
    id: string,
    state: OsUpdateRolloutState,
  ): Promise<void> {
    const now = isoNow();
    if (state === "active") {
      await this._run(
        `UPDATE os_update_rollouts SET state = ?, started_at = COALESCE(started_at, ?) WHERE id = ?`,
        [state, now, id],
      );
    } else if (state === "complete") {
      await this._run(
        `UPDATE os_update_rollouts SET state = ?, finished_at = ? WHERE id = ?`,
        [state, now, id],
      );
    } else {
      await this._run(`UPDATE os_update_rollouts SET state = ? WHERE id = ?`, [state, id]);
    }
    void this.notify("os_update_rollouts", "update", id);
  }

  // ===========================================================================
  // pairing_codes
  // ===========================================================================

  // Pairing codes are always global — kiosks don't have a tenant until paired.
  // In postgres multi-tenant mode, explicitly target public schema so tenant
  // search_path doesn't shadow the table.
  private get _pairingT() {
    return this.adapter.dialect() === "postgres" ? "public.pairing_codes" : "pairing_codes";
  }

  async createPairingCode(input: {
    code: string;
    kiosk_proposed_name: string | null;
    kiosk_hardware_model: string | null;
    kiosk_firmware_target?: string | null;
    kiosk_capabilities: string[];
    expires_at: string;
    extras: Record<string, unknown>;
  }): Promise<PairingCode> {
    const t = this._pairingT;
    await this._run(
      `INSERT INTO ${t}
         (code, kiosk_proposed_name, kiosk_hardware_model, kiosk_firmware_target, kiosk_capabilities,
          expires_at, extras)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.code,
        input.kiosk_proposed_name,
        input.kiosk_hardware_model,
        input.kiosk_firmware_target ?? null,
        J(input.kiosk_capabilities),
        input.expires_at,
        J(input.extras),
      ],
    );
    const r = await this._get(`SELECT * FROM ${t} WHERE code = ?`, [input.code]);
    if (!r) throw new Error("pairing_code vanished after insert");
    return rowToPairingCode(r as Record<string, unknown>);
  }

  async getPairingCode(code: string): Promise<PairingCode | null> {
    const r = await this._get(`SELECT * FROM ${this._pairingT} WHERE code = ?`, [code]);
    return r ? rowToPairingCode(r as Record<string, unknown>) : null;
  }

  async listPendingPairingCodes(): Promise<PairingCode[]> {
    const rs = await this._all(
      `SELECT * FROM ${this._pairingT}
        WHERE consumed_at IS NULL AND expires_at > ?
        ORDER BY issued_at DESC`,
      [isoNow()],
    );
    return rs.map((r) => rowToPairingCode(r as Record<string, unknown>));
  }

  async markPairingCodeClaimed(
    code: string,
    kioskId: string,
    extras: Record<string, unknown>,
  ): Promise<void> {
    await this._run(
      `UPDATE ${this._pairingT}
          SET consumed_at = ?,
              consumed_by_kiosk_id = ?,
              extras = ?
        WHERE code = ?`,
      [isoNow(), kioskId, J(extras), code],
    );
  }

  async updatePairingCodeExtras(code: string, extras: Record<string, unknown>): Promise<void> {
    await this._run(`UPDATE ${this._pairingT} SET extras = ? WHERE code = ?`, [
      J(extras),
      code,
    ]);
  }

  // ===========================================================================
  // event_log
  // ===========================================================================

  async insertEvent(input: {
    source_kiosk_id: string | null;
    source_camera_id: string | null;
    source_iobox_id?: string | null;
    source_type: EventSourceType;
    topic: string;
    property_op: string | null;
    payload: Record<string, unknown>;
    forwarded_to_nodered: boolean;
  }): Promise<string> {
    const id = uuidv7();
    await this._run(
      `INSERT INTO event_log
         (id, source_kiosk_id, source_camera_id, source_iobox_id, source_type, topic,
          property_op, payload, forwarded_to_nodered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.source_kiosk_id,
        input.source_camera_id,
        input.source_iobox_id ?? null,
        input.source_type,
        input.topic,
        input.property_op,
        J(input.payload),
        Boolean(input.forwarded_to_nodered),
      ],
    );
    return id;
  }

  async recentEvents(limit = 10): Promise<EventLog[]> {
    const rs = await this._all(
      "SELECT * FROM event_log ORDER BY received_at DESC LIMIT ?",
      [limit],
    );
    return rs.map((r) => rowToEventLog(r as Record<string, unknown>));
  }

  async markEventForwarded(eventId: string): Promise<void> {
    await this._run("UPDATE event_log SET forwarded_to_nodered = ? WHERE id = ?", [true, eventId]);
  }

  /**
   * Delete event_log rows older than `days` AND trim to `maxRows` total.
   * Returns the number of rows deleted.
   */
  async purgeEventLog(days: number = 30, maxRows: number = 100_000): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const r1 = await this._run("DELETE FROM event_log WHERE received_at < ?", [cutoff]);
    // Trim to maxRows by deleting oldest beyond the cap.
    const r2 = await this._run(
      `DELETE FROM event_log WHERE id NOT IN (
        SELECT id FROM event_log ORDER BY received_at DESC LIMIT ?
      )`,
      [maxRows],
    );
    return Number(r1.changes) + Number(r2.changes);
  }

  async purgeAuditLog(days: number = 90): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const r = await this._run("DELETE FROM audit_log WHERE ts < ?", [cutoff]);
    return Number(r.changes);
  }

  async purgeKioskLogs(days: number = 14): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const r = await this._run("DELETE FROM kiosk_logs WHERE received_at < ?", [cutoff]);
    return Number(r.changes);
  }

  async queryEvents(filters: EventQueryFilters): Promise<{ events: EventLog[]; total: number }> {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (filters.topic) {
      where.push("topic = ?");
      params.push(filters.topic);
    }
    if (filters.kiosk_id != null) {
      where.push("source_kiosk_id = ?");
      params.push(filters.kiosk_id);
    }
    if (filters.camera_id != null) {
      where.push("source_camera_id = ?");
      params.push(filters.camera_id);
    }
    if (filters.source_type) {
      where.push("source_type = ?");
      params.push(filters.source_type);
    }
    if (filters.from) {
      where.push("received_at >= ?");
      params.push(filters.from);
    }
    if (filters.to) {
      where.push("received_at <= ?");
      params.push(filters.to);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const countRow = await this._get<Record<string, unknown>>(`SELECT COUNT(*) as cnt FROM event_log ${clause}`, params);
    const total = Number(countRow?.["cnt"] ?? 0);

    const rs = await this._all(
      `SELECT * FROM event_log ${clause} ORDER BY received_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return {
      events: rs.map((r) => rowToEventLog(r as Record<string, unknown>)),
      total,
    };
  }

  // ===========================================================================
  // kiosk_logs
  // ===========================================================================

  async insertKioskLogs(
    kioskId: string,
    entries: Array<{ level: KioskLogLevel; message: string; context?: Record<string, unknown>; logged_at?: string }>,
  ): Promise<number> {
    const now = isoNow();
    let count = 0;
    for (const e of entries) {
      await this._run(
        `INSERT INTO kiosk_logs (kiosk_id, level, message, context, logged_at)
         VALUES (?, ?, ?, ?, ?)`,
        [kioskId, e.level, e.message, J(e.context ?? {}), e.logged_at ?? now],
      );
      count++;
    }
    await this.trimKioskLogs(kioskId, 500);
    return count;
  }

  private async trimKioskLogs(kioskId: string, maxRows: number): Promise<void> {
    await this._run(
      `DELETE FROM kiosk_logs WHERE kiosk_id = ? AND id NOT IN (
         SELECT id FROM kiosk_logs WHERE kiosk_id = ? ORDER BY received_at DESC LIMIT ?
       )`,
      [kioskId, kioskId, maxRows],
    );
  }

  async purgeOldKioskLogs(maxAgeHours: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeHours * 3600_000).toISOString();
    const result = await this._run(
      "DELETE FROM kiosk_logs WHERE received_at < ?",
      [cutoff],
    );
    return Number(result.changes);
  }

  async queryKioskLogs(filters: KioskLogQueryFilters): Promise<{ logs: KioskLog[]; total: number }> {
    const where: string[] = ["kiosk_id = ?"];
    const params: (string | number)[] = [filters.kiosk_id];

    if (filters.level) {
      where.push("level = ?");
      params.push(filters.level);
    }
    if (filters.from) {
      where.push("received_at >= ?");
      params.push(filters.from);
    }
    if (filters.to) {
      where.push("received_at <= ?");
      params.push(filters.to);
    }

    const clause = `WHERE ${where.join(" AND ")}`;
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const countRow = await this._get<Record<string, unknown>>(`SELECT COUNT(*) as cnt FROM kiosk_logs ${clause}`, params);
    const total = Number(countRow?.["cnt"] ?? 0);

    const rs = await this._all(
      `SELECT * FROM kiosk_logs ${clause} ORDER BY received_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return {
      logs: rs.map((r) => rowToKioskLog(r as Record<string, unknown>)),
      total,
    };
  }

  // ===========================================================================
  // bundle queries (label-aware composite reads)
  // ===========================================================================

  /**
   * Returns label IDs + names attached to a kiosk by role.
   * Used by `service-bundle` to scope a kiosk's view of the world.
   */
  async bundleScope(kioskId: string): Promise<{
    labelIds: string[];
    labelNames: string[];
    operateLabelIds: string[];
    operateLabelNames: string[];
  }> {
    const all = await this.listKioskLabels(kioskId);
    const labelIds: string[] = [];
    const labelNames: string[] = [];
    const operateLabelIds: string[] = [];
    const operateLabelNames: string[] = [];
    const seen = new Set<string>();
    for (const kl of all) {
      if (!seen.has(kl.label_id)) {
        seen.add(kl.label_id);
        labelIds.push(kl.label_id);
        labelNames.push(kl.name);
      }
      if (kl.role === "operate") {
        operateLabelIds.push(kl.label_id);
        operateLabelNames.push(kl.name);
      }
    }
    return { labelIds, labelNames, operateLabelIds, operateLabelNames };
  }

  /** Cameras whose label set intersects the given label IDs. */
  async camerasForLabelIds(labelIds: string[]): Promise<Camera[]> {
    if (labelIds.length === 0) return [];
    const placeholders = labelIds.map(() => "?").join(",");
    const rs = await this._all(
      `SELECT DISTINCT c.* FROM cameras c
         JOIN camera_labels cl ON cl.camera_id = c.id
        WHERE cl.label_id IN (${placeholders})
          AND c.enabled = true
        ORDER BY c.name`,
      labelIds,
    );
    return rs.map((r) => rowToCamera(r as Record<string, unknown>));
  }

  async layoutsForLabelIds(labelIds: string[]): Promise<Layout[]> {
    if (labelIds.length === 0) return [];
    const placeholders = labelIds.map(() => "?").join(",");
    const rs = await this._all(
      `SELECT DISTINCT l.* FROM layouts l
         JOIN layout_labels ll ON ll.layout_id = l.id
        WHERE ll.label_id IN (${placeholders})
        ORDER BY l.name`,
      labelIds,
    );
    return rs.map((r) => rowToLayout(r as Record<string, unknown>));
  }

  async layoutCells(layoutId: string): Promise<LayoutCell[]> {
    return this.listLayoutCells(layoutId);
  }

  // Deprecated — layout_templates dropped in v0.5
  layoutTemplates(_ids: string[]): LayoutTemplate[] {
    return [];
  }

  async cameraLabelNames(cameraId: string): Promise<string[]> {
    const rs = await this._all(
      `SELECT l.name FROM camera_labels cl
         JOIN labels l ON l.id = cl.label_id
        WHERE cl.camera_id = ?`,
      [cameraId],
    );
    return rs.map((r) => String((r as Record<string, unknown>)["name"]));
  }

  async cameraLabelIds(cameraId: string): Promise<Array<{ label_id: string; name: string }>> {
    const rs = await this._all(
      `SELECT cl.label_id, l.name FROM camera_labels cl
         JOIN labels l ON l.id = cl.label_id
        WHERE cl.camera_id = ?`,
      [cameraId],
    );
    return rs.map((r) => {
      const row = r as Record<string, unknown>;
      return { label_id: String(row["label_id"]), name: String(row["name"]) };
    });
  }

  async updateCamera(id: string, patch: Partial<Camera>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "created_at") continue;
      sets.push(`${k} = ?`);
      if (k === "capabilities") vals.push(J(v));
      else if (typeof v === "boolean") vals.push(v);
      else vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE cameras SET ${sets.join(", ")} WHERE id = ?`, vals);
    void this.notify("cameras", "update", id);
  }

  async setCameraEventCallbackToken(id: string, nonce: string, hash: string): Promise<void> {
    await this._run(
      "UPDATE cameras SET event_callback_nonce = ?, event_callback_token_hash = ? WHERE id = ?",
      [nonce, hash, id],
    );
    void this.notify("cameras", "update", id);
  }

  async deleteCamera(id: string): Promise<void> {
    await this._run(`DELETE FROM camera_labels WHERE camera_id = ?`, [id]);
    await this._run(`DELETE FROM camera_streams WHERE camera_id = ?`, [id]);
    // Clear cells that referenced this camera (legacy column).
    await this._run(`DELETE FROM layout_cells WHERE camera_id = ?`, [id]);
    // entities row has ON DELETE CASCADE → camera-mirror entity goes away with
    // the camera, which in turn sets layout_cells.entity_id NULL via the FK.
    await this._run(`DELETE FROM cameras WHERE id = ?`, [id]);
    void this.notify("cameras", "delete", id);
  }

  // ===========================================================================
  // entities — reusable content pool (camera/html/web) bound to layout cells
  // ===========================================================================

  async listEntities(): Promise<Entity[]> {
    const rs = await this._all("SELECT * FROM entities ORDER BY name");
    return rs.map((r) => rowToEntity(r as Record<string, unknown>));
  }

  async getEntityById(id: string): Promise<Entity | null> {
    const r = await this._get("SELECT * FROM entities WHERE id = ?", [id]);
    return r ? rowToEntity(r as Record<string, unknown>) : null;
  }

  async getEntityByName(name: string): Promise<Entity | null> {
    const r = await this._get("SELECT * FROM entities WHERE name = ?", [name]);
    return r ? rowToEntity(r as Record<string, unknown>) : null;
  }

  async getEntityForCamera(cameraId: string): Promise<Entity | null> {
    const r = await this._get(
      `SELECT * FROM entities WHERE type = 'camera' AND camera_id = ? LIMIT 1`,
      [cameraId],
    );
    return r ? rowToEntity(r as Record<string, unknown>) : null;
  }

  async createEntity(input: {
    name: string;
    type: EntityType;
    description?: string | null;
    camera_id?: string | null;
    html_content?: string | null;
    web_url?: string | null;
    dashboard_id?: string | null;
    ablesign_screen_id?: string | null;
    managed?: boolean;
  }): Promise<Entity> {
    const id = uuidv7();
    await this._run(
      `INSERT INTO entities (id, name, type, description, camera_id, html_content, web_url, dashboard_id, ablesign_screen_id, managed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.type,
        input.description ?? null,
        input.type === "camera" ? (input.camera_id ?? null) : null,
        input.type === "html" ? (input.html_content ?? null) : null,
        input.type === "web" || input.type === "ablesign" ? (input.web_url ?? null) : null,
        input.type === "dashboard" ? (input.dashboard_id ?? null) : null,
        input.type === "ablesign" ? (input.ablesign_screen_id ?? null) : null,
        input.managed ?? false,
      ],
    );
    void this.notify("entities", "create", id);
    const e = await this.getEntityById(id);
    if (!e) throw new Error("entity vanished after insert");
    return e;
  }

  /** Find a dashboard entity by Node-RED tab id (used by the sync flow). */
  async getEntityForDashboard(dashboardId: string): Promise<Entity | null> {
    const r = await this._get(
      `SELECT * FROM entities WHERE type = 'dashboard' AND dashboard_id = ? LIMIT 1`,
      [dashboardId],
    );
    return r ? rowToEntity(r as Record<string, unknown>) : null;
  }

  async updateEntity(
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      camera_id?: string | null;
      html_content?: string | null;
      web_url?: string | null;
      dashboard_id?: string | null;
      input_options_json?: Record<string, unknown>;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      vals.push(k === "input_options_json" ? J(v ?? {}) : v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE entities SET ${sets.join(", ")} WHERE id = ?`, vals);
    void this.notify("entities", "update", id);

    // Propagate content fields into any cell that uses this entity, so the
    // legacy cell columns stay aligned for bundle generation. Dashboard
    // entities materialise as `web` cells pointing at /dash/<dashboard_id>.
    const ent = await this.getEntityById(id);
    if (!ent) return;
    const cellContentType = ent.type === "dashboard" ? "web" : ent.type;
    const cellWebUrl =
      ent.type === "web" ? ent.web_url :
      ent.type === "dashboard" && ent.dashboard_id ? `/dash/${ent.dashboard_id}` :
      null;
    await this._run(
      `UPDATE layout_cells
          SET content_type = ?,
              camera_id = ?,
              web_url = ?,
              html_content = ?
        WHERE entity_id = ?`,
      [
        cellContentType,
        ent.type === "camera" ? ent.camera_id : null,
        cellWebUrl,
        ent.type === "html" ? ent.html_content : null,
        id,
      ],
    );
  }

  async deleteEntity(id: string): Promise<void> {
    // FK ON DELETE SET NULL clears layout_cells.entity_id.
    await this._run(`DELETE FROM entities WHERE id = ?`, [id]);
    void this.notify("entities", "delete", id);
  }

  /**
   * Idempotent: ensure a camera-type entity exists for the given camera. If
   * the camera's name is already taken by another entity, append the camera
   * id to keep the name unique.
   */
  async getEntityByAbleSignScreen(screenId: string): Promise<Entity | null> {
    const r = await this._get(
      `SELECT * FROM entities WHERE type = 'ablesign' AND ablesign_screen_id = ? LIMIT 1`,
      [screenId],
    );
    return r ? rowToEntity(r as Record<string, unknown>) : null;
  }

  async ensureCameraEntity(camera: Camera): Promise<Entity> {
    const existing = await this.getEntityForCamera(camera.id);
    if (existing) return existing;
    let name = camera.name;
    if (await this.getEntityByName(name)) {
      name = `${camera.name} (cam ${camera.id.slice(0, 8)})`;
    }
    return this.createEntity({ name, type: "camera", camera_id: camera.id, managed: true });
  }

  async updateKiosk(id: string, patch: Partial<Kiosk>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "created_at" || k === "paired_at") continue;
      sets.push(`${k} = ?`);
      vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE kiosks SET ${sets.join(", ")} WHERE id = ?`, vals);
    void this.notify("kiosks", "update", id);
  }

  async deleteKiosk(id: string): Promise<void> {
    const displays = await this.listDisplaysForKiosk(id);
    await this.transact(async () => {
      for (const display of displays) {
        await this._run(`DELETE FROM display_layouts WHERE display_id = ?`, [display.id]);
      }
      await this._run(`DELETE FROM displays WHERE kiosk_id = ?`, [id]);
      await this._run(`DELETE FROM kiosk_labels WHERE kiosk_id = ?`, [id]);
      await this._run(`DELETE FROM kiosk_gpio_bindings WHERE kiosk_id = ?`, [id]);
      await this._run(`DELETE FROM kiosks WHERE id = ?`, [id]);
    });
    for (const display of displays) {
      void this.notify("display_layouts", "delete", display.id);
      void this.notify("displays", "delete", display.id);
    }
    void this.notify("kiosks", "delete", id);
  }

  async detachCameraLabel(cameraId: string, labelId: string): Promise<void> {
    await this._run(`DELETE FROM camera_labels WHERE camera_id = ? AND label_id = ?`, [cameraId, labelId]);
  }

  async detachKioskLabel(kioskId: string, labelId: string): Promise<void> {
    await this._run(`DELETE FROM kiosk_labels WHERE kiosk_id = ? AND label_id = ?`, [kioskId, labelId]);
  }

  async deleteLabel(id: string): Promise<void> {
    await this._run(`DELETE FROM camera_labels WHERE label_id = ?`, [id]);
    await this._run(`DELETE FROM kiosk_labels WHERE label_id = ?`, [id]);
    await this._run(`DELETE FROM layout_labels WHERE label_id = ?`, [id]);
    await this._run(`DELETE FROM labels WHERE id = ?`, [id]);
    void this.notify("labels", "delete", id);
  }

  // ===========================================================================
  // kiosk GPIO bindings
  // ===========================================================================

  async listGpioBindings(kioskId: string): Promise<KioskGpioBinding[]> {
    const rs = await this._all(
      "SELECT * FROM kiosk_gpio_bindings WHERE kiosk_id = ? ORDER BY chip, pin",
      [kioskId],
    );
    return rs.map((r) => rowToKioskGpioBinding(r as Record<string, unknown>));
  }

  async getGpioBindingById(id: string): Promise<KioskGpioBinding | null> {
    const r = await this._get("SELECT * FROM kiosk_gpio_bindings WHERE id = ?", [id]);
    return r ? rowToKioskGpioBinding(r as Record<string, unknown>) : null;
  }

  async createGpioBinding(input: {
    kiosk_id: string;
    chip?: string;
    pin: number;
    direction: GpioDirection;
    pull?: GpioPull | null;
    edge?: GpioEdge | null;
    topic: string;
  }): Promise<KioskGpioBinding> {
    const id = uuidv7();
    await this._run(
      `INSERT INTO kiosk_gpio_bindings (id, kiosk_id, chip, pin, direction, pull, edge, topic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.kiosk_id,
        input.chip ?? "gpiochip0",
        input.pin,
        input.direction,
        input.pull ?? null,
        input.edge ?? null,
        input.topic,
      ],
    );
    void this.notify("kiosk_gpio_bindings", "create", id);
    const b = await this.getGpioBindingById(id);
    if (!b) throw new Error("gpio binding vanished after insert");
    return b;
  }

  async deleteGpioBinding(id: string): Promise<void> {
    await this._run(`DELETE FROM kiosk_gpio_bindings WHERE id = ?`, [id]);
    void this.notify("kiosk_gpio_bindings", "delete", id);
  }

  async updateLabel(id: string, patch: { name?: string; description?: string | null; color?: string | null }): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE labels SET ${sets.join(", ")} WHERE id = ?`, vals);
    void this.notify("labels", "update", id);
  }

  // ===========================================================================
  // camera_event_subscriptions
  // ===========================================================================

  async getActiveOnvifOwners(): Promise<Map<string, string>> {
    const rs = await this._all<{ camera_id: string; subscribed_by_kiosk_id: string }>(
      `SELECT DISTINCT camera_id, subscribed_by_kiosk_id FROM camera_event_subscriptions
       WHERE subscribed_by_kiosk_id IS NOT NULL AND status = 'active'`,
    );
    const map = new Map<string, string>();
    for (const r of rs) {
      map.set(r.camera_id, r.subscribed_by_kiosk_id);
    }
    return map;
  }

  async listEventSubscriptions(cameraId: string): Promise<CameraEventSubscription[]> {
    const rs = await this._all(
      "SELECT * FROM camera_event_subscriptions WHERE camera_id = ? ORDER BY topic",
      [cameraId],
    );
    return rs.map((r) => rowToCameraEventSubscription(r as Record<string, unknown>));
  }

  async upsertEventSubscription(input: {
    camera_id: string;
    topic: string;
    status?: EventSubscriptionStatus;
  }): Promise<void> {
    const status = input.status ?? "inactive";
    await this._run(
      `INSERT INTO camera_event_subscriptions (camera_id, topic, status)
       VALUES (?, ?, ?)
       ON CONFLICT (camera_id, topic) DO UPDATE SET status = COALESCE(NULLIF(?, ''), camera_event_subscriptions.status)`,
      [input.camera_id, input.topic, status, status],
    );
  }

  async updateEventSubscriptionStatus(
    cameraId: string,
    topic: string,
    status: EventSubscriptionStatus,
    error?: string | null,
  ): Promise<void> {
    await this._run(
      `UPDATE camera_event_subscriptions
          SET status = ?, error_message = ?
        WHERE camera_id = ? AND topic = ?`,
      [status, error ?? null, cameraId, topic],
    );
  }

  async markEventReceived(cameraId: string, topic: string): Promise<void> {
    await this._run(
      `UPDATE camera_event_subscriptions
          SET last_event_at = ?, status = 'active'
        WHERE camera_id = ? AND topic = ?`,
      [isoNow(), cameraId, topic],
    );
  }

  async setAllEventSubscriptionsStatus(
    cameraId: string,
    fromStatus: EventSubscriptionStatus,
    toStatus: EventSubscriptionStatus,
  ): Promise<void> {
    await this._run(
      `UPDATE camera_event_subscriptions
          SET status = ?
        WHERE camera_id = ? AND status = ?`,
      [toStatus, cameraId, fromStatus],
    );
  }

  /**
   * Sync subscription statuses reported by a kiosk heartbeat.
   * Upserts per camera+topic, sets source/sink/status/subscribed_at.
   */
  async syncKioskSubscriptions(
    kioskId: string,
    subs: Record<string, { state: string; last_event_at?: string | null; subscribed_at?: string | null; error?: string | null; resolved_sink?: string | null }>,
  ): Promise<void> {
    const now = isoNow();
    for (const [cameraId, info] of Object.entries(subs)) {
      const status = info.state === "active" ? "active"
        : info.state === "failed" ? "failed"
          : info.state === "subscribing" ? "pending"
            : "inactive";
      const subscribedAt = normalizeTimestamp(info.subscribed_at) ?? now;
      await this._run(
        `INSERT INTO camera_event_subscriptions (id, camera_id, topic, status, subscribed_by_kiosk_id, event_source, event_sink, subscribed_at, error_message)
         VALUES (?, ?, 'onvif', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (camera_id, topic) DO UPDATE
           SET status = ?,
               subscribed_by_kiosk_id = ?,
               event_source = ?,
               event_sink = COALESCE(?, camera_event_subscriptions.event_sink),
               subscribed_at = COALESCE(?, camera_event_subscriptions.subscribed_at),
               error_message = ?`,
        [
          uuidv7(), cameraId, status, kioskId, `kiosk:${kioskId}`, info.resolved_sink ?? null, subscribedAt, info.error ?? null,
          status, kioskId, `kiosk:${kioskId}`, info.resolved_sink ?? null, subscribedAt, info.error ?? null,
        ],
      );
    }
  }

  /**
   * Release event_source ownership for cameras where the owning kiosk
   * hasn't been seen in > maxAgeHours. Only releases "auto" mode cameras
   * (event_source started as "auto" before being claimed).
   * Returns number of cameras released.
   */
  async releaseStaleEventOwnership(maxAgeHours: number = 24): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeHours * 3600_000).toISOString();
    // Mark subscriptions as inactive for kiosks that haven't been seen recently.
    // We no longer mutate cameras.event_source — it stays as the admin set it.
    const result = await this._run(
      `UPDATE camera_event_subscriptions
          SET status = 'inactive'
        WHERE subscribed_by_kiosk_id IN (
          SELECT id FROM kiosks WHERE last_seen_at < ? OR last_seen_at IS NULL
        ) AND status IN ('active', 'pending')`,
      [cutoff],
    );
    return result.changes;
  }

  // ===========================================================================
  // cloud_accounts
  // ===========================================================================

  async listCloudAccounts(): Promise<CloudAccount[]> {
    const rs = await this._all("SELECT * FROM cloud_accounts ORDER BY vendor, name");
    return rs.map((r) => rowToCloudAccount(r as Record<string, unknown>));
  }

  async getCloudAccount(id: string): Promise<CloudAccount | null> {
    const r = await this._get("SELECT * FROM cloud_accounts WHERE id = ?", [id]);
    return r ? rowToCloudAccount(r as Record<string, unknown>) : null;
  }

  async createCloudAccount(input: {
    id: string;
    vendor: string;
    name: string;
    credentials_encrypted: string;
  }): Promise<CloudAccount> {
    await this._run(
      `INSERT INTO cloud_accounts (id, vendor, name, credentials_encrypted) VALUES (?, ?, ?, ?)`,
      [input.id, input.vendor, input.name, input.credentials_encrypted],
    );
    const a = await this.getCloudAccount(input.id);
    if (!a) throw new Error("cloud account vanished after insert");
    return a;
  }

  async updateCloudAccount(id: string, patch: Partial<CloudAccount>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "created_at") continue;
      sets.push(`${k} = ?`);
      vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE cloud_accounts SET ${sets.join(", ")} WHERE id = ?`, vals);
  }

  async deleteCloudAccount(id: string): Promise<void> {
    await this._run("DELETE FROM cloud_accounts WHERE id = ?", [id]);
  }

  // ===========================================================================
  // AbleSign accounts + screens
  // ===========================================================================

  async listAbleSignAccounts(): Promise<any[]> {
    return this._all("SELECT * FROM ablesign_accounts ORDER BY created_at DESC");
  }

  async getAbleSignAccount(id: string): Promise<any | undefined> {
    return this._get("SELECT * FROM ablesign_accounts WHERE id = ?", [id]);
  }

  async createAbleSignAccount(input: {
    name: string;
    api_key_encrypted: string;
    workspace_id?: string;
  }): Promise<string> {
    const id = uuidv7();
    await this._run(
      `INSERT INTO ablesign_accounts (id, name, api_key_encrypted, workspace_id)
       VALUES (?, ?, ?, ?)`,
      [id, input.name, input.api_key_encrypted, input.workspace_id ?? null],
    );
    return id;
  }

  async updateAbleSignAccount(id: string, patch: Record<string, unknown>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "created_at") continue;
      sets.push(`${k} = ?`);
      vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE ablesign_accounts SET ${sets.join(", ")} WHERE id = ?`, vals);
  }

  async deleteAbleSignAccount(id: string): Promise<void> {
    await this._run("DELETE FROM ablesign_accounts WHERE id = ?", [id]);
  }

  async listAbleSignScreens(accountId?: string): Promise<any[]> {
    if (accountId) {
      return this._all("SELECT * FROM ablesign_screens WHERE account_id = ? ORDER BY title", [accountId]);
    }
    return this._all("SELECT * FROM ablesign_screens ORDER BY title");
  }

  async getAbleSignScreen(id: string): Promise<any | undefined> {
    return this._get("SELECT * FROM ablesign_screens WHERE id = ?", [id]);
  }

  async getAbleSignScreenByKiosk(kioskId: string): Promise<any | undefined> {
    return this._get("SELECT * FROM ablesign_screens WHERE kiosk_id = ?", [kioskId]);
  }

  async createAbleSignScreen(input: {
    account_id: string;
    ablesign_screen_id: string;
    ablesign_screen_token_encrypted?: string;
    kiosk_id?: string;
    title: string;
    orientation?: string;
  }): Promise<string> {
    const id = uuidv7();
    await this._run(
      `INSERT INTO ablesign_screens (id, account_id, ablesign_screen_id, ablesign_screen_token_encrypted, kiosk_id, title, orientation)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.account_id, input.ablesign_screen_id, input.ablesign_screen_token_encrypted ?? null, input.kiosk_id ?? null, input.title, input.orientation ?? "landscape"],
    );
    return id;
  }

  async updateAbleSignScreen(id: string, patch: Record<string, unknown>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "created_at") continue;
      sets.push(`${k} = ?`);
      vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE ablesign_screens SET ${sets.join(", ")} WHERE id = ?`, vals);
  }

  async deleteAbleSignScreen(id: string): Promise<void> {
    await this._run("DELETE FROM ablesign_screens WHERE id = ?", [id]);
  }

  async upsertAbleSignScreen(input: {
    account_id: string;
    ablesign_screen_id: string;
    title: string;
    online: boolean;
    last_heartbeat_at?: string;
    orientation?: string;
  }): Promise<string> {
    const existing = await this._get<{ id: string }>(
      "SELECT id FROM ablesign_screens WHERE account_id = ? AND ablesign_screen_id = ?",
      [input.account_id, input.ablesign_screen_id],
    );
    if (existing) {
      await this._run(
        `UPDATE ablesign_screens SET title = ?, online = ?, last_heartbeat_at = COALESCE(?, last_heartbeat_at), orientation = COALESCE(?, orientation) WHERE id = ?`,
        [input.title, input.online, input.last_heartbeat_at ?? null, input.orientation ?? null, existing.id],
      );
      return existing.id;
    }
    return this.createAbleSignScreen({
      account_id: input.account_id,
      ablesign_screen_id: input.ablesign_screen_id,
      title: input.title,
      orientation: input.orientation,
    });
  }
}
