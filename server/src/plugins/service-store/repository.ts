/**
 * Repository — typed accessor over the sqlite handle.
 *
 * Keeps prepared statements cached for the life of the connection. All
 * mutating methods invoke the `notify` callback with (table, op, id) so the
 * surrounding plugin can broadcast a `store.changed` event.
 *
 * NOT THREAD SAFE — node:sqlite is single-threaded, and so is Node. Don't
 * cross workers with the same handle.
 */
import { randomBytes } from "node:crypto";
import type { DbAdapter, RunResult, Row } from "./db-adapter.js";

import type {
  ApiKey,
  ApiKeyScope,
  AuditActorType,
  AuditEntry,
  AuditResult,
  Camera,
  CameraStream,
  CameraType,
  CloudAccount,
  Display,
  Entity,
  EntityType,
  EventLog,
  EventQueryFilters,
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
  User,
  UserRole,
} from "../../shared/types.js";
import {
  rowToApiKey,
  rowToAuditEntry,
  rowToCamera,
  rowToCloudAccount,
  rowToCameraStream,
  rowToDisplay,
  rowToEntity,
  rowToEventLog,
  rowToFirmwareRelease,
  rowToFirmwareRollout,
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
  rowToUser,
} from "./mappers.js";
import { B, J, isoIn, isoNow, j } from "./util.js";

type NotifyFn = (
  table: string,
  op: "create" | "update" | "delete",
  id?: string | number,
) => Promise<void>;

export class Repository {
  readonly adapter: DbAdapter;
  private readonly notify: NotifyFn;

  constructor(adapter: DbAdapter, notify: NotifyFn) {
    this.adapter = adapter;
    this.notify = notify;
  }

  /** Run a write statement. Params are passed as an array. */
  private _run(sql: string, params: unknown[] = []): Promise<RunResult> {
    return this.adapter.run(sql, params as any);
  }
  /** Single-row query. */
  private _get<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.adapter.get<T>(sql, params as any);
  }
  /** Multi-row query. */
  private _all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.adapter.all<T>(sql, params as any);
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
  // setup_state
  // ===========================================================================

  async getSetupState(): Promise<SetupState> {
    const r = await this._get("SELECT * FROM setup_state WHERE id = 1");
    if (!r) throw new Error("setup_state row missing");
    return rowToSetupState(r as Record<string, unknown>);
  }

  async isSetupComplete(): Promise<boolean> {
    return (await this.getSetupState()).is_complete && (await this.countUsers()) > 0;
  }

  async markSetupComplete(): Promise<void> {
    await this._run(
      `UPDATE setup_state
         SET is_complete = 1,
             completed_at = COALESCE(completed_at, ?)
       WHERE id = 1`,
      [isoNow()],
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
      "UPDATE setup_state SET cluster_key_provisioned = 1 WHERE id = 1",
    );
  }

  // ===========================================================================
  // users
  // ===========================================================================

  async countUsers(): Promise<number> {
    const r = await this._get<{ c: number }>("SELECT COUNT(*) AS c FROM users");
    return r?.c ?? 0;
  }

  async getUserById(id: number): Promise<User | null> {
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
    const role: UserRole = input.role ?? "operator";
    const result = await this._run(
      `INSERT INTO users (username, password_hash, role, is_active, must_change_password)
       VALUES (?, ?, ?, 1, ?)`,
      [
        input.username,
        input.password_hash,
        role,
        B(Boolean(input.must_change_password)),
      ],
    );
    const id = Number(result.lastInsertRowid);
    void this.notify("users", "create", id);
    const u = await this.getUserById(id);
    if (!u) throw new Error("user vanished after insert");
    return u;
  }

  async updateUser(id: number, patch: Partial<User>): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    if ("password_hash" in patch) {
      cols.push("password_hash = ?");
      vals.push(patch.password_hash);
    }
    if ("totp_enabled" in patch) {
      cols.push("totp_enabled = ?");
      vals.push(B(Boolean(patch.totp_enabled)));
    }
    if ("totp_secret_encrypted" in patch) {
      cols.push("totp_secret_encrypted = ?");
      vals.push(patch.totp_secret_encrypted);
    }
    if ("recovery_codes_hashed" in patch) {
      cols.push("recovery_codes_hashed = ?");
      vals.push(J(patch.recovery_codes_hashed));
    }
    if ("must_change_password" in patch) {
      cols.push("must_change_password = ?");
      vals.push(B(Boolean(patch.must_change_password)));
    }
    if ("failed_login_count" in patch) {
      cols.push("failed_login_count = ?");
      vals.push(patch.failed_login_count);
    }
    if ("locked_until" in patch) {
      cols.push("locked_until = ?");
      vals.push(patch.locked_until);
    }
    if ("last_login_at" in patch) {
      cols.push("last_login_at = ?");
      vals.push(patch.last_login_at);
    }
    if ("is_active" in patch) {
      cols.push("is_active = ?");
      vals.push(B(Boolean(patch.is_active)));
    }
    if (cols.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE users SET ${cols.join(", ")} WHERE id = ?`, vals);
    void this.notify("users", "update", id);
  }

  // ===========================================================================
  // sessions
  // ===========================================================================

  async createSession(input: {
    id: string;
    user_id: number;
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
        B(input.totp_pending),
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
      B(pending),
      id,
    ]);
  }

  async revokeSession(id: string): Promise<void> {
    await this._run("UPDATE sessions SET revoked_at = ? WHERE id = ?", [isoNow(), id]);
  }

  async revokeAllSessionsForUser(userId: number): Promise<void> {
    await this._run(
      `UPDATE sessions SET revoked_at = ?
        WHERE user_id = ? AND revoked_at IS NULL`,
      [isoNow(), userId],
    );
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
    const result = await this._run(
      `INSERT INTO api_keys (name, key_hash, key_prefix, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.name,
        input.key_hash,
        input.key_prefix,
        J(input.scopes),
        input.expires_at,
      ],
    );
    const id = Number(result.lastInsertRowid);
    void this.notify("api_keys", "create", id);
    const k = await this.getApiKeyById(id);
    if (!k) throw new Error("api_key vanished after insert");
    return k;
  }

  async getApiKeyById(id: number): Promise<ApiKey | null> {
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

  async touchApiKey(id: number, ip: string | null): Promise<void> {
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

  async getDisplayById(id: number): Promise<Display | null> {
    const r = await this._get("SELECT * FROM displays WHERE id = ?", [id]);
    return r ? rowToDisplay(r as Record<string, unknown>) : null;
  }

  async createDefaultDisplay(): Promise<Display> {
    const result = await this._run(
      `INSERT INTO displays (name, "index", is_primary)
       VALUES ('primary', 0, 0)`,
    );
    const id = Number(result.lastInsertRowid);
    void this.notify("displays", "create", id);
    const d = await this.getDisplayById(id);
    if (!d) throw new Error("display vanished after insert");
    return d;
  }

  async createDisplayForKiosk(kioskId: number, input: {
    name: string;
    index?: number;
    width_px?: number;
    height_px?: number;
  }): Promise<Display> {
    const idx = input.index ?? await this.nextDisplayIndexForKiosk(kioskId);
    const result = await this._run(
      `INSERT INTO displays (name, "index", is_primary, kiosk_id, width_px, height_px)
       VALUES (?, ?, 0, ?, ?, ?)`,
      [
        input.name,
        idx,
        kioskId,
        input.width_px ?? 1920,
        input.height_px ?? 1080,
      ],
    );
    const id = Number(result.lastInsertRowid);
    void this.notify("displays", "create", id);
    const d = await this.getDisplayById(id);
    if (!d) throw new Error("display vanished after insert");
    return d;
  }

  async listDisplaysForKiosk(kioskId: number): Promise<Display[]> {
    const rs = await this._all(
      'SELECT * FROM displays WHERE kiosk_id = ? ORDER BY "index"',
      [kioskId],
    );
    return rs.map((r) => rowToDisplay(r as Record<string, unknown>));
  }

  /**
   * Kiosks currently rendering this camera (active layout has a cell
   * pointing at it). Subset of listKiosksWithCameraInBundle.
   */
  async listKiosksRenderingCamera(cameraId: number): Promise<Kiosk[]> {
    const rs = await this._all(
      `SELECT DISTINCT k.*
         FROM kiosks k
         JOIN displays d ON d.kiosk_id = k.id
         JOIN layout_cells lc ON lc.layout_id = d.active_layout_id
        WHERE lc.camera_id = ?
          AND d.active_layout_id IS NOT NULL
          AND k.enabled = 1`,
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
  async listKiosksWithCameraInBundle(cameraId: number): Promise<Kiosk[]> {
    const rs = await this._all(
      `SELECT DISTINCT k.*
         FROM kiosks k
         JOIN displays d ON d.kiosk_id = k.id
         JOIN display_layouts dl ON dl.display_id = d.id
         JOIN layout_cells lc ON lc.layout_id = dl.layout_id
        WHERE lc.camera_id = ?
          AND k.enabled = 1`,
      [cameraId],
    );
    return rs.map((r) => rowToKiosk(r as Record<string, unknown>));
  }

  private async nextDisplayIndexForKiosk(kioskId: number): Promise<number> {
    const r = await this._get<{ m: number | null }>('SELECT MAX("index") AS m FROM displays WHERE kiosk_id = ?', [kioskId]);
    return (r?.m ?? -1) + 1;
  }

  async updateDisplay(id: number, patch: Partial<Display>): Promise<void> {
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

  async getLayoutById(id: number): Promise<Layout | null> {
    const r = await this._get("SELECT * FROM layouts WHERE id = ?", [id]);
    return r ? rowToLayout(r as Record<string, unknown>) : null;
  }

  /**
   * @deprecated Use `listLayoutsForDisplay` which goes through the
   *             `display_layouts` join table. Kept as a thin alias for any
   *             callers still on the old API.
   */
  async layoutsForDisplay(displayId: number): Promise<Layout[]> {
    return this.listLayoutsForDisplay(displayId);
  }

  /** All layouts attached to the given display, via display_layouts. */
  async listLayoutsForDisplay(displayId: number): Promise<Layout[]> {
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
  async listDisplaysForLayout(layoutId: number): Promise<Display[]> {
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
  async attachLayoutToDisplay(displayId: number, layoutId: number): Promise<void> {
    await this._run(
      `INSERT OR IGNORE INTO display_layouts (display_id, layout_id)
       VALUES (?, ?)`,
      [displayId, layoutId],
    );
    void this.notify("display_layouts", "create", layoutId);
  }

  /** Detach. If the display's default_layout_id pointed at this layout, clear it. */
  async detachLayoutFromDisplay(displayId: number, layoutId: number): Promise<void> {
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
    preload_camera_ids?: number[];
    resets_idle_timer?: boolean;
  }): Promise<Layout> {
    const result = await this._run(
      `INSERT INTO layouts (name, description, priority, cooling_timeout_seconds, preload_camera_ids, resets_idle_timer)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        input.description ?? null,
        input.priority ?? "normal",
        input.cooling_timeout_seconds ?? null,
        J(input.preload_camera_ids ?? []),
        B(input.resets_idle_timer ?? true),
      ],
    );
    const id = Number(result.lastInsertRowid);
    void this.notify("layouts", "create", id);
    const r = await this.getLayoutById(id);
    if (!r) throw new Error("layout vanished after insert");
    return r;
  }

  async updateLayout(id: number, patch: Partial<Layout>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "display_id") continue; // display_id deprecated
      sets.push(`${k} = ?`);
      if (k === "preload_camera_ids" || k === "regions") vals.push(J(v));
      else if (typeof v === "boolean") vals.push(B(v));
      else vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE layouts SET ${sets.join(", ")} WHERE id = ?`, vals);
    void this.notify("layouts", "update", id);
  }

  async cloneLayout(id: number): Promise<Layout> {
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
      preload_camera_ids: src.preload_camera_ids,
      resets_idle_timer: src.resets_idle_timer,
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

    const labels = await this._all<{ label_id: number }>(
      "SELECT label_id FROM layout_labels WHERE layout_id = ?",
      [id],
    );
    for (const ll of labels) {
      await this.attachLayoutLabel(clone.id, ll.label_id);
    }

    const displays = await this._all<{ display_id: number }>(
      "SELECT display_id FROM display_layouts WHERE layout_id = ?",
      [id],
    );
    for (const dl of displays) {
      await this.attachLayoutToDisplay(dl.display_id, clone.id);
    }

    return clone;
  }

  async deleteLayout(id: number): Promise<void> {
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
    layout_id: number;
    row: number;
    col: number;
    row_span?: number;
    col_span?: number;
    content_type?: string;
    camera_id?: number | null;
    stream_selector?: string | null;
    web_url?: string | null;
    html_content?: string | null;
    cooling_timeout_seconds?: number | null;
    options?: Record<string, unknown>;
    entity_id?: number | null;
    fit?: "cover" | "contain" | "fill";
  }): Promise<LayoutCell> {
    // Resolve content fields from the entity (if given). The legacy columns
    // remain populated for backward-compatible bundle generation. Dashboard
    // entities materialise as web cells pointing at /dash/<id> so the existing
    // kiosk's WebKit cell path renders them with no app changes.
    let contentType = input.content_type ?? "none";
    let cameraId: number | null = input.camera_id ?? null;
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

    const result = await this._run(
      `INSERT INTO layout_cells (layout_id, "row", col, row_span, col_span, content_type, camera_id, stream_selector, web_url, html_content, cooling_timeout_seconds, options, entity_id, fit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
    const id = Number(result.lastInsertRowid);
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
  async assignCellEntity(cellId: number, entityId: number | null): Promise<void> {
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

  async updateLayoutCell(id: number, patch: Partial<LayoutCell>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "layout_id") continue;
      const col = k === "row" ? `"row"` : k;
      sets.push(`${col} = ?`);
      if (k === "options") vals.push(J(v));
      else vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE layout_cells SET ${sets.join(", ")} WHERE id = ?`, vals);
    void this.notify("layout_cells", "update", id);
  }

  async deleteLayoutCell(id: number): Promise<void> {
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

  async listLayoutCells(layoutId: number): Promise<LayoutCell[]> {
    const rs = await this._all(
      `SELECT * FROM layout_cells WHERE layout_id = ? ORDER BY "row", col`,
      [layoutId],
    );
    return rs.map((r) => rowToLayoutCell(r as Record<string, unknown>));
  }

  async getLayoutCellById(id: number): Promise<LayoutCell | null> {
    const r = await this._get("SELECT * FROM layout_cells WHERE id = ?", [id]);
    return r ? rowToLayoutCell(r as Record<string, unknown>) : null;
  }

  // ===========================================================================
  // display-chain bundle queries (kiosk → display → layouts → cells → cameras)
  // ===========================================================================

  /** Bundle generation: layouts attached to a display via display_layouts. */
  async layoutsForDisplayId(displayId: number): Promise<Layout[]> {
    return this.listLayoutsForDisplay(displayId);
  }

  async camerasForLayoutIds(layoutIds: number[]): Promise<Camera[]> {
    if (layoutIds.length === 0) return [];
    const placeholders = layoutIds.map(() => "?").join(",");
    const rs = await this._all(
      `SELECT DISTINCT c.* FROM cameras c
         JOIN layout_cells lc ON lc.camera_id = c.id
        WHERE lc.layout_id IN (${placeholders})
          AND c.enabled = 1
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

  async getCameraById(id: number): Promise<Camera | null> {
    const r = await this._get("SELECT * FROM cameras WHERE id = ?", [id]);
    return r ? rowToCamera(r as Record<string, unknown>) : null;
  }

  async getCameraByName(name: string): Promise<Camera | null> {
    const r = await this._get("SELECT * FROM cameras WHERE name = ?", [name]);
    return r ? rowToCamera(r as Record<string, unknown>) : null;
  }

  async createCamera(input: {
    name: string;
    type: CameraType;
    rtsp_url?: string | null;
    onvif_host?: string | null;
    onvif_port?: number | null;
    onvif_username?: string | null;
    onvif_password?: string | null; // already-encrypted ciphertext
    capabilities?: string[];
    stream_policy?: StreamPolicy;
  }): Promise<Camera> {
    const result = await this._run(
      `INSERT INTO cameras
         (name, type, rtsp_url, onvif_host, onvif_port, onvif_username,
          onvif_password, capabilities, stream_policy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.name,
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
    const id = Number(result.lastInsertRowid);
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
        [input.name, input.cloud_stream_url, input.cloud_stream_type, B(input.enabled), cam.id],
      );
      void this.notify("cameras", "update", cam.id);
      return (await this.getCameraById(cam.id))!;
    }
    const result = await this._run(
      `INSERT INTO cameras
         (name, type, cloud_account_id, cloud_vendor_camera_id, cloud_stream_url, cloud_stream_type, enabled)
       VALUES (?, 'cloud', ?, ?, ?, ?, ?)`,
      [input.name, input.cloud_account_id, input.cloud_vendor_camera_id,
       input.cloud_stream_url, input.cloud_stream_type, B(input.enabled)],
    );
    const id = Number(result.lastInsertRowid);
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

  async listCameraStreams(cameraId: number): Promise<CameraStream[]> {
    const rs = await this._all(
      "SELECT * FROM camera_streams WHERE camera_id = ?",
      [cameraId],
    );
    return rs.map((r) => rowToCameraStream(r as Record<string, unknown>));
  }

  async createCameraStream(input: {
    camera_id: number;
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
    const result = await this._run(
      `INSERT INTO camera_streams
        (camera_id, role, name, profile_token, rtsp_uri, width, height,
         encoding, framerate, bitrate_kbps, is_discovered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
        B(Boolean(input.is_discovered)),
      ],
    );
    const id = Number(result.lastInsertRowid);
    const r = await this._get("SELECT * FROM camera_streams WHERE id = ?", [id]);
    if (!r) throw new Error("camera_stream vanished after insert");
    void this.notify("camera_streams", "create", id);
    return rowToCameraStream(r as Record<string, unknown>);
  }

  async updateCameraStream(id: number, patch: Partial<CameraStream>): Promise<void> {
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
    const result = await this._run(
      `INSERT INTO labels (name, description, color)
       VALUES (?, ?, ?)`,
      [input.name, input.description ?? null, input.color ?? null],
    );
    const id = Number(result.lastInsertRowid);
    void this.notify("labels", "create", id);
    const r = await this._get("SELECT * FROM labels WHERE id = ?", [id]);
    if (!r) throw new Error("label vanished after insert");
    return rowToLabel(r as Record<string, unknown>);
  }

  /** Get-or-create label by name (used during pairing's free-text label input). */
  async ensureLabel(name: string): Promise<Label> {
    return (await this.getLabelByName(name)) ?? (await this.createLabel({ name }));
  }

  async attachKioskLabel(kioskId: number, labelId: number, role: LabelRole): Promise<void> {
    await this._run(
      `INSERT OR IGNORE INTO kiosk_labels (kiosk_id, label_id, role)
       VALUES (?, ?, ?)`,
      [kioskId, labelId, role],
    );
  }

  async listKioskLabels(kioskId: number): Promise<Array<KioskLabel & { name: string }>> {
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
        kiosk_id: Number(row["kiosk_id"]),
        label_id: Number(row["label_id"]),
        role: String(row["role"]) as LabelRole,
        name: String(row["name"]),
      };
    });
  }

  async attachCameraLabel(cameraId: number, labelId: number): Promise<void> {
    await this._run(
      `INSERT OR IGNORE INTO camera_labels (camera_id, label_id)
       VALUES (?, ?)`,
      [cameraId, labelId],
    );
  }

  async attachLayoutLabel(layoutId: number, labelId: number): Promise<void> {
    await this._run(
      `INSERT OR IGNORE INTO layout_labels (layout_id, label_id)
       VALUES (?, ?)`,
      [layoutId, labelId],
    );
  }

  // ===========================================================================
  // kiosks
  // ===========================================================================

  async listKiosks(): Promise<Kiosk[]> {
    const rs = await this._all("SELECT * FROM kiosks ORDER BY name");
    return rs.map((r) => rowToKiosk(r as Record<string, unknown>));
  }

  async getKioskById(id: number): Promise<Kiosk | null> {
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
      "SELECT * FROM kiosks WHERE key_prefix = ? AND enabled = 1",
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
    managed_image?: boolean;
  }): Promise<Kiosk> {
    const result = await this._run(
      `INSERT INTO kiosks
        (name, key_hash, key_prefix, capabilities, hardware_model, paired_at, managed_image)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        input.key_hash,
        input.key_prefix,
        J(input.capabilities ?? []),
        input.hardware_model ?? null,
        isoNow(),
        input.managed_image ? 1 : 0,
      ],
    );
    const id = Number(result.lastInsertRowid);
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
    id: number,
    input: {
      key_hash: string;
      key_prefix: string;
      capabilities?: string[];
      hardware_model?: string | null;
    },
  ): Promise<void> {
    await this._run(
      `UPDATE kiosks SET
         key_hash = ?,
         key_prefix = ?,
         capabilities = ?,
         hardware_model = ?,
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
        isoNow(),
        id,
      ],
    );
    void this.notify("kiosks", "update", id);
  }

  async touchKiosk(
    id: number,
    patch: {
      bundle_version?: string | null;
      kiosk_app_version?: string | null;
      os_version?: string | null;
      cpu_temp_c?: number | null;
      cpu_load_percent?: number | null;
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
    },
  ): Promise<void> {
    await this._run(
      `UPDATE kiosks SET
         last_seen_at = ?,
         last_bundle_version = COALESCE(?, last_bundle_version),
         kiosk_app_version = COALESCE(?, kiosk_app_version),
         os_version = COALESCE(?, os_version),
         cpu_temp_c = ?,
         cpu_load_percent = ?,
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
         network_interfaces_json = COALESCE(?, network_interfaces_json)
       WHERE id = ?`,
      [
        isoNow(),
        patch.bundle_version ?? null,
        patch.kiosk_app_version ?? null,
        patch.os_version ?? null,
        patch.cpu_temp_c ?? null,
        patch.cpu_load_percent ?? null,
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
        id,
      ],
    );
  }

  // ===========================================================================
  // audit_log
  // ===========================================================================

  async insertAudit(input: {
    actor_type: AuditActorType;
    actor_id: number | null;
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
    uploaded_by: number | null;
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
    kioskId: number,
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
    kioskId: number,
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
    target_kiosk_ids: number[];
    percentage: number;
    created_by: number | null;
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
  async listActiveRolloutsForKiosk(kioskId: number): Promise<FirmwareRollout[]> {
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
    uploaded_by: number | null;
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
    kioskId: number,
    version: string,
    error: string | null,
  ): Promise<void> {
    await this._run(
      `UPDATE kiosks SET
         os_update_last_attempt_at = ?,
         os_update_last_attempt_version = ?,
         os_update_last_error = ?
       WHERE id = ?`,
      [isoNow(), version, error, kioskId],
    );
    void this.notify("kiosks", "update", kioskId);
  }

  async setKioskOsUpdatePref(
    kioskId: number,
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
    target_kiosk_ids: number[];
    percentage: number;
    created_by: number | null;
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

  async listActiveOsUpdateRolloutsForKiosk(kioskId: number): Promise<OsUpdateRollout[]> {
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

  async createPairingCode(input: {
    code: string;
    kiosk_proposed_name: string | null;
    kiosk_hardware_model: string | null;
    kiosk_capabilities: string[];
    expires_at: string;
    extras: Record<string, unknown>;
  }): Promise<PairingCode> {
    await this._run(
      `INSERT INTO pairing_codes
         (code, kiosk_proposed_name, kiosk_hardware_model, kiosk_capabilities,
          expires_at, extras)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.code,
        input.kiosk_proposed_name,
        input.kiosk_hardware_model,
        J(input.kiosk_capabilities),
        input.expires_at,
        J(input.extras),
      ],
    );
    const r = await this._get("SELECT * FROM pairing_codes WHERE code = ?", [input.code]);
    if (!r) throw new Error("pairing_code vanished after insert");
    return rowToPairingCode(r as Record<string, unknown>);
  }

  async getPairingCode(code: string): Promise<PairingCode | null> {
    const r = await this._get("SELECT * FROM pairing_codes WHERE code = ?", [code]);
    return r ? rowToPairingCode(r as Record<string, unknown>) : null;
  }

  async listPendingPairingCodes(): Promise<PairingCode[]> {
    const rs = await this._all(
      `SELECT * FROM pairing_codes
        WHERE consumed_at IS NULL AND expires_at > ?
        ORDER BY issued_at DESC`,
      [isoNow()],
    );
    return rs.map((r) => rowToPairingCode(r as Record<string, unknown>));
  }

  async markPairingCodeClaimed(
    code: string,
    kioskId: number,
    extras: Record<string, unknown>,
  ): Promise<void> {
    await this._run(
      `UPDATE pairing_codes
          SET consumed_at = ?,
              consumed_by_kiosk_id = ?,
              extras = ?
        WHERE code = ?`,
      [isoNow(), kioskId, J(extras), code],
    );
  }

  async updatePairingCodeExtras(code: string, extras: Record<string, unknown>): Promise<void> {
    await this._run("UPDATE pairing_codes SET extras = ? WHERE code = ?", [
      J(extras),
      code,
    ]);
  }

  // ===========================================================================
  // event_log
  // ===========================================================================

  async insertEvent(input: {
    source_kiosk_id: number | null;
    source_camera_id: number | null;
    source_type: EventSourceType;
    topic: string;
    property_op: string | null;
    payload: Record<string, unknown>;
    forwarded_to_nodered: boolean;
  }): Promise<number> {
    const result = await this._run(
      `INSERT INTO event_log
         (source_kiosk_id, source_camera_id, source_type, topic,
          property_op, payload, forwarded_to_nodered)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.source_kiosk_id,
        input.source_camera_id,
        input.source_type,
        input.topic,
        input.property_op,
        J(input.payload),
        B(input.forwarded_to_nodered),
      ],
    );
    return Number(result.lastInsertRowid);
  }

  async recentEvents(limit = 10): Promise<EventLog[]> {
    const rs = await this._all(
      "SELECT * FROM event_log ORDER BY received_at DESC LIMIT ?",
      [limit],
    );
    return rs.map((r) => rowToEventLog(r as Record<string, unknown>));
  }

  async markEventForwarded(eventId: number): Promise<void> {
    await this._run("UPDATE event_log SET forwarded_to_nodered = 1 WHERE id = ?", [eventId]);
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
    kioskId: number,
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

  private async trimKioskLogs(kioskId: number, maxRows: number): Promise<void> {
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
  async bundleScope(kioskId: number): Promise<{
    labelIds: number[];
    labelNames: string[];
    operateLabelIds: number[];
    operateLabelNames: string[];
  }> {
    const all = await this.listKioskLabels(kioskId);
    const labelIds: number[] = [];
    const labelNames: string[] = [];
    const operateLabelIds: number[] = [];
    const operateLabelNames: string[] = [];
    const seen = new Set<number>();
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
  async camerasForLabelIds(labelIds: number[]): Promise<Camera[]> {
    if (labelIds.length === 0) return [];
    const placeholders = labelIds.map(() => "?").join(",");
    const rs = await this._all(
      `SELECT DISTINCT c.* FROM cameras c
         JOIN camera_labels cl ON cl.camera_id = c.id
        WHERE cl.label_id IN (${placeholders})
          AND c.enabled = 1
        ORDER BY c.name`,
      labelIds,
    );
    return rs.map((r) => rowToCamera(r as Record<string, unknown>));
  }

  async layoutsForLabelIds(labelIds: number[]): Promise<Layout[]> {
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

  async layoutCells(layoutId: number): Promise<LayoutCell[]> {
    return this.listLayoutCells(layoutId);
  }

  // Deprecated — layout_templates dropped in v0.5
  layoutTemplates(_ids: number[]): LayoutTemplate[] {
    return [];
  }

  async cameraLabelNames(cameraId: number): Promise<string[]> {
    const rs = await this._all(
      `SELECT l.name FROM camera_labels cl
         JOIN labels l ON l.id = cl.label_id
        WHERE cl.camera_id = ?`,
      [cameraId],
    );
    return rs.map((r) => String((r as Record<string, unknown>)["name"]));
  }

  async cameraLabelIds(cameraId: number): Promise<Array<{ label_id: number; name: string }>> {
    const rs = await this._all(
      `SELECT cl.label_id, l.name FROM camera_labels cl
         JOIN labels l ON l.id = cl.label_id
        WHERE cl.camera_id = ?`,
      [cameraId],
    );
    return rs.map((r) => {
      const row = r as Record<string, unknown>;
      return { label_id: Number(row["label_id"]), name: String(row["name"]) };
    });
  }

  async updateCamera(id: number, patch: Partial<Camera>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "created_at") continue;
      sets.push(`${k} = ?`);
      if (k === "capabilities") vals.push(J(v));
      else if (typeof v === "boolean") vals.push(B(v));
      else vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this._run(`UPDATE cameras SET ${sets.join(", ")} WHERE id = ?`, vals);
    void this.notify("cameras", "update", id);
  }

  async deleteCamera(id: number): Promise<void> {
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

  async getEntityById(id: number): Promise<Entity | null> {
    const r = await this._get("SELECT * FROM entities WHERE id = ?", [id]);
    return r ? rowToEntity(r as Record<string, unknown>) : null;
  }

  async getEntityByName(name: string): Promise<Entity | null> {
    const r = await this._get("SELECT * FROM entities WHERE name = ?", [name]);
    return r ? rowToEntity(r as Record<string, unknown>) : null;
  }

  async getEntityForCamera(cameraId: number): Promise<Entity | null> {
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
    camera_id?: number | null;
    html_content?: string | null;
    web_url?: string | null;
    dashboard_id?: string | null;
  }): Promise<Entity> {
    const result = await this._run(
      `INSERT INTO entities (name, type, description, camera_id, html_content, web_url, dashboard_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        input.type,
        input.description ?? null,
        input.type === "camera" ? (input.camera_id ?? null) : null,
        input.type === "html" ? (input.html_content ?? null) : null,
        input.type === "web" ? (input.web_url ?? null) : null,
        input.type === "dashboard" ? (input.dashboard_id ?? null) : null,
      ],
    );
    const id = Number(result.lastInsertRowid);
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
    id: number,
    patch: {
      name?: string;
      description?: string | null;
      camera_id?: number | null;
      html_content?: string | null;
      web_url?: string | null;
      dashboard_id?: string | null;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      vals.push(v === undefined ? null : v);
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

  async deleteEntity(id: number): Promise<void> {
    // FK ON DELETE SET NULL clears layout_cells.entity_id.
    await this._run(`DELETE FROM entities WHERE id = ?`, [id]);
    void this.notify("entities", "delete", id);
  }

  /**
   * Idempotent: ensure a camera-type entity exists for the given camera. If
   * the camera's name is already taken by another entity, append the camera
   * id to keep the name unique.
   */
  async ensureCameraEntity(camera: Camera): Promise<Entity> {
    const existing = await this.getEntityForCamera(camera.id);
    if (existing) return existing;
    let name = camera.name;
    if (await this.getEntityByName(name)) {
      name = `${camera.name} (cam #${String(camera.id)})`;
    }
    return this.createEntity({ name, type: "camera", camera_id: camera.id });
  }

  async updateKiosk(id: number, patch: Partial<Kiosk>): Promise<void> {
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

  async deleteKiosk(id: number): Promise<void> {
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

  async detachCameraLabel(cameraId: number, labelId: number): Promise<void> {
    await this._run(`DELETE FROM camera_labels WHERE camera_id = ? AND label_id = ?`, [cameraId, labelId]);
  }

  async detachKioskLabel(kioskId: number, labelId: number): Promise<void> {
    await this._run(`DELETE FROM kiosk_labels WHERE kiosk_id = ? AND label_id = ?`, [kioskId, labelId]);
  }

  async deleteLabel(id: number): Promise<void> {
    await this._run(`DELETE FROM camera_labels WHERE label_id = ?`, [id]);
    await this._run(`DELETE FROM kiosk_labels WHERE label_id = ?`, [id]);
    await this._run(`DELETE FROM layout_labels WHERE label_id = ?`, [id]);
    await this._run(`DELETE FROM labels WHERE id = ?`, [id]);
    void this.notify("labels", "delete", id);
  }

  // ===========================================================================
  // kiosk GPIO bindings
  // ===========================================================================

  async listGpioBindings(kioskId: number): Promise<KioskGpioBinding[]> {
    const rs = await this._all(
      "SELECT * FROM kiosk_gpio_bindings WHERE kiosk_id = ? ORDER BY chip, pin",
      [kioskId],
    );
    return rs.map((r) => rowToKioskGpioBinding(r as Record<string, unknown>));
  }

  async getGpioBindingById(id: number): Promise<KioskGpioBinding | null> {
    const r = await this._get("SELECT * FROM kiosk_gpio_bindings WHERE id = ?", [id]);
    return r ? rowToKioskGpioBinding(r as Record<string, unknown>) : null;
  }

  async createGpioBinding(input: {
    kiosk_id: number;
    chip?: string;
    pin: number;
    direction: GpioDirection;
    pull?: GpioPull | null;
    edge?: GpioEdge | null;
    topic: string;
  }): Promise<KioskGpioBinding> {
    const result = await this._run(
      `INSERT INTO kiosk_gpio_bindings (kiosk_id, chip, pin, direction, pull, edge, topic)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.kiosk_id,
        input.chip ?? "gpiochip0",
        input.pin,
        input.direction,
        input.pull ?? null,
        input.edge ?? null,
        input.topic,
      ],
    );
    const id = Number(result.lastInsertRowid);
    void this.notify("kiosk_gpio_bindings", "create", id);
    const b = await this.getGpioBindingById(id);
    if (!b) throw new Error("gpio binding vanished after insert");
    return b;
  }

  async deleteGpioBinding(id: number): Promise<void> {
    await this._run(`DELETE FROM kiosk_gpio_bindings WHERE id = ?`, [id]);
    void this.notify("kiosk_gpio_bindings", "delete", id);
  }

  async updateLabel(id: number, patch: { name?: string; description?: string | null; color?: string | null }): Promise<void> {
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
}
