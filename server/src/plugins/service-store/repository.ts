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
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

import type {
  ApiKey,
  ApiKeyScope,
  Camera,
  CameraStream,
  CameraType,
  Display,
  EventLog,
  EventSourceType,
  Kiosk,
  KioskLabel,
  Label,
  LabelRole,
  Layout,
  LayoutCell,
  LayoutTemplate,
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
  rowToCamera,
  rowToCameraStream,
  rowToDisplay,
  rowToEventLog,
  rowToKiosk,
  rowToLabel,
  rowToLayout,
  rowToLayoutCell,
  rowToLayoutTemplate,
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
  private readonly db: DatabaseSync;
  private readonly notify: NotifyFn;
  private readonly stmts = new Map<string, StatementSync>();

  constructor(db: DatabaseSync, notify: NotifyFn) {
    this.db = db;
    this.notify = notify;
  }

  /** Cached prepared statements. */
  private prep(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** Ad-hoc transaction. */
  transact<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  // ===========================================================================
  // setup_state
  // ===========================================================================

  getSetupState(): SetupState {
    const r = this.prep("SELECT * FROM setup_state WHERE id = 1").get();
    if (!r) throw new Error("setup_state row missing");
    return rowToSetupState(r as Record<string, unknown>);
  }

  isSetupComplete(): boolean {
    return this.getSetupState().is_complete && this.countUsers() > 0;
  }

  markSetupComplete(): void {
    this.prep(
      `UPDATE setup_state
         SET is_complete = 1,
             completed_at = COALESCE(completed_at, ?)
       WHERE id = 1`,
    ).run(isoNow());
    void this.notify("setup_state", "update", 1);
  }

  setSetupExtra(key: string, value: unknown): void {
    const cur = this.getSetupState().extras;
    cur[key] = value;
    this.prep("UPDATE setup_state SET extras = ? WHERE id = 1").run(J(cur));
  }

  getSetupExtra(key: string): unknown {
    return this.getSetupState().extras[key];
  }

  markClusterKeyProvisioned(): void {
    this.prep(
      "UPDATE setup_state SET cluster_key_provisioned = 1 WHERE id = 1",
    ).run();
  }

  // ===========================================================================
  // users
  // ===========================================================================

  countUsers(): number {
    const r = this.prep("SELECT COUNT(*) AS c FROM users").get() as
      | { c: number }
      | undefined;
    return r?.c ?? 0;
  }

  getUserById(id: number): User | null {
    const r = this.prep("SELECT * FROM users WHERE id = ?").get(id);
    return r ? rowToUser(r as Record<string, unknown>) : null;
  }

  getUserByUsername(username: string): User | null {
    const r = this.prep("SELECT * FROM users WHERE username = ?").get(username);
    return r ? rowToUser(r as Record<string, unknown>) : null;
  }

  createUser(input: {
    username: string;
    password_hash: string;
    role?: UserRole;
    must_change_password?: boolean;
  }): User {
    const role: UserRole = input.role ?? "operator";
    const result = this.prep(
      `INSERT INTO users (username, password_hash, role, is_active, must_change_password)
       VALUES (?, ?, ?, 1, ?)`,
    ).run(
      input.username,
      input.password_hash,
      role,
      B(Boolean(input.must_change_password)),
    );
    const id = Number(result.lastInsertRowid);
    void this.notify("users", "create", id);
    const u = this.getUserById(id);
    if (!u) throw new Error("user vanished after insert");
    return u;
  }

  updateUser(id: number, patch: Partial<User>): void {
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
    this.db.prepare(`UPDATE users SET ${cols.join(", ")} WHERE id = ?`).run(...(vals as never[]));
    void this.notify("users", "update", id);
  }

  // ===========================================================================
  // sessions
  // ===========================================================================

  createSession(input: {
    id: string;
    user_id: number;
    csrf_token: string;
    totp_pending: boolean;
    user_agent: string | null;
    ip_address: string | null;
    expires_at: string; // absolute
  }): Session {
    this.prep(
      `INSERT INTO sessions
         (id, user_id, csrf_token, totp_pending, user_agent, ip_address, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.user_id,
      input.csrf_token,
      B(input.totp_pending),
      input.user_agent,
      input.ip_address,
      input.expires_at,
    );
    const s = this.getSessionById(input.id);
    if (!s) throw new Error("session vanished after insert");
    return s;
  }

  getSessionById(id: string): Session | null {
    const r = this.prep("SELECT * FROM sessions WHERE id = ?").get(id);
    return r ? rowToSession(r as Record<string, unknown>) : null;
  }

  touchSession(id: string, lastSeenAt: string): void {
    this.prep("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(
      lastSeenAt,
      id,
    );
  }

  setSessionTotpPending(id: string, pending: boolean): void {
    this.prep("UPDATE sessions SET totp_pending = ? WHERE id = ?").run(
      B(pending),
      id,
    );
  }

  revokeSession(id: string): void {
    this.prep("UPDATE sessions SET revoked_at = ? WHERE id = ?").run(isoNow(), id);
  }

  revokeAllSessionsForUser(userId: number): void {
    this.prep(
      `UPDATE sessions SET revoked_at = ?
        WHERE user_id = ? AND revoked_at IS NULL`,
    ).run(isoNow(), userId);
  }

  // ===========================================================================
  // api_keys
  // ===========================================================================

  createApiKey(input: {
    name: string;
    key_hash: string;
    key_prefix: string;
    scopes: ApiKeyScope[];
    expires_at: string | null;
  }): ApiKey {
    const result = this.prep(
      `INSERT INTO api_keys (name, key_hash, key_prefix, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      input.name,
      input.key_hash,
      input.key_prefix,
      J(input.scopes),
      input.expires_at,
    );
    const id = Number(result.lastInsertRowid);
    void this.notify("api_keys", "create", id);
    const k = this.getApiKeyById(id);
    if (!k) throw new Error("api_key vanished after insert");
    return k;
  }

  getApiKeyById(id: number): ApiKey | null {
    const r = this.prep("SELECT * FROM api_keys WHERE id = ?").get(id);
    return r ? rowToApiKey(r as Record<string, unknown>) : null;
  }

  /** Lookup all candidates for a given prefix (typically returns 0 or 1). */
  listApiKeysByPrefix(prefix: string): ApiKey[] {
    const rs = this.prep(
      "SELECT * FROM api_keys WHERE key_prefix = ? AND revoked_at IS NULL",
    ).all(prefix);
    return rs.map((r) => rowToApiKey(r as Record<string, unknown>));
  }

  touchApiKey(id: number, ip: string | null): void {
    this.prep(
      "UPDATE api_keys SET last_used_at = ?, last_used_ip = ? WHERE id = ?",
    ).run(isoNow(), ip, id);
  }

  // ===========================================================================
  // displays
  // ===========================================================================

  listDisplays(): Display[] {
    const rs = this.prep('SELECT * FROM displays ORDER BY "index"').all();
    return rs.map((r) => rowToDisplay(r as Record<string, unknown>));
  }

  getDisplayById(id: number): Display | null {
    const r = this.prep("SELECT * FROM displays WHERE id = ?").get(id);
    return r ? rowToDisplay(r as Record<string, unknown>) : null;
  }

  createDefaultDisplay(): Display {
    const result = this.prep(
      `INSERT INTO displays (name, "index", is_primary)
       VALUES ('primary', 0, 0)`,
    ).run();
    const id = Number(result.lastInsertRowid);
    void this.notify("displays", "create", id);
    const d = this.getDisplayById(id);
    if (!d) throw new Error("display vanished after insert");
    return d;
  }

  createDisplayForKiosk(kioskId: number, input: {
    name: string;
    index?: number;
    width_px?: number;
    height_px?: number;
  }): Display {
    // Find next available index
    const idx = input.index ?? this.nextDisplayIndex();
    const result = this.prep(
      `INSERT INTO displays (name, "index", is_primary, kiosk_id, width_px, height_px)
       VALUES (?, ?, 0, ?, ?, ?)`,
    ).run(
      input.name,
      idx,
      kioskId,
      input.width_px ?? 1920,
      input.height_px ?? 1080,
    );
    const id = Number(result.lastInsertRowid);
    void this.notify("displays", "create", id);
    const d = this.getDisplayById(id);
    if (!d) throw new Error("display vanished after insert");
    return d;
  }

  listDisplaysForKiosk(kioskId: number): Display[] {
    const rs = this.prep(
      'SELECT * FROM displays WHERE kiosk_id = ? ORDER BY "index"',
    ).all(kioskId);
    return rs.map((r) => rowToDisplay(r as Record<string, unknown>));
  }

  private nextDisplayIndex(): number {
    const r = this.prep('SELECT MAX("index") AS m FROM displays').get() as { m: number | null } | undefined;
    return (r?.m ?? -1) + 1;
  }

  updateDisplay(id: number, patch: Partial<Display>): void {
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
    this.db.prepare(`UPDATE displays SET ${sets.join(", ")} WHERE id = ?`).run(...vals as any[]);
    void this.notify("displays", "update", id);
  }

  // ===========================================================================
  // layout templates
  // ===========================================================================

  listLayoutTemplates(): LayoutTemplate[] {
    const rs = this.prep("SELECT * FROM layout_templates ORDER BY name").all();
    return rs.map((r) => rowToLayoutTemplate(r as Record<string, unknown>));
  }

  getLayoutTemplateById(id: number): LayoutTemplate | null {
    const r = this.prep("SELECT * FROM layout_templates WHERE id = ?").get(id);
    return r ? rowToLayoutTemplate(r as Record<string, unknown>) : null;
  }

  createLayoutTemplate(input: {
    name: string;
    description?: string | null;
    regions: unknown;
    grid_cols?: number;
    grid_rows?: number;
    is_builtin?: boolean;
  }): LayoutTemplate {
    const result = this.prep(
      `INSERT INTO layout_templates (name, description, regions, grid_cols, grid_rows, is_builtin)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.name,
      input.description ?? null,
      J(input.regions),
      input.grid_cols ?? 12,
      input.grid_rows ?? 12,
      B(input.is_builtin ?? false),
    );
    const id = Number(result.lastInsertRowid);
    void this.notify("layout_templates", "create", id);
    const r = this.getLayoutTemplateById(id);
    if (!r) throw new Error("layout_template vanished after insert");
    return r;
  }

  updateLayoutTemplate(id: number, patch: { name?: string; description?: string | null; regions?: unknown; grid_cols?: number; grid_rows?: number }): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id") continue;
      sets.push(`${k} = ?`);
      vals.push(k === "regions" ? J(v) : (v === undefined ? null : v));
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE layout_templates SET ${sets.join(", ")} WHERE id = ?`).run(...vals as any[]);
    void this.notify("layout_templates", "update", id);
  }

  deleteLayoutTemplate(id: number): void {
    this.db.prepare(`DELETE FROM layout_templates WHERE id = ?`).run(id);
    void this.notify("layout_templates", "delete", id);
  }

  // ===========================================================================
  // layouts
  // ===========================================================================

  listLayouts(): Layout[] {
    const rs = this.prep("SELECT * FROM layouts ORDER BY name").all();
    return rs.map((r) => rowToLayout(r as Record<string, unknown>));
  }

  getLayoutById(id: number): Layout | null {
    const r = this.prep("SELECT * FROM layouts WHERE id = ?").get(id);
    return r ? rowToLayout(r as Record<string, unknown>) : null;
  }

  /**
   * @deprecated Use `listLayoutsForDisplay` which goes through the
   *             `display_layouts` join table. Kept as a thin alias for any
   *             callers still on the old API.
   */
  layoutsForDisplay(displayId: number): Layout[] {
    return this.listLayoutsForDisplay(displayId);
  }

  /** All layouts attached to the given display, via display_layouts. */
  listLayoutsForDisplay(displayId: number): Layout[] {
    const rs = this.prep(
      `SELECT l.* FROM layouts l
         JOIN display_layouts dl ON dl.layout_id = l.id
        WHERE dl.display_id = ?
        ORDER BY l.name`,
    ).all(displayId);
    return rs.map((r) => rowToLayout(r as Record<string, unknown>));
  }

  /** Inverse: all displays that have this layout attached. */
  listDisplaysForLayout(layoutId: number): Display[] {
    const rs = this.prep(
      `SELECT d.* FROM displays d
         JOIN display_layouts dl ON dl.display_id = d.id
        WHERE dl.layout_id = ?
        ORDER BY d."index"`,
    ).all(layoutId);
    return rs.map((r) => rowToDisplay(r as Record<string, unknown>));
  }

  /** Idempotent attach. */
  attachLayoutToDisplay(displayId: number, layoutId: number): void {
    this.prep(
      `INSERT OR IGNORE INTO display_layouts (display_id, layout_id)
       VALUES (?, ?)`,
    ).run(displayId, layoutId);
    void this.notify("display_layouts", "create", layoutId);
  }

  /** Detach. If the display's default_layout_id pointed at this layout, clear it. */
  detachLayoutFromDisplay(displayId: number, layoutId: number): void {
    this.db
      .prepare(`DELETE FROM display_layouts WHERE display_id = ? AND layout_id = ?`)
      .run(displayId, layoutId);
    this.db
      .prepare(
        `UPDATE displays SET default_layout_id = NULL
          WHERE id = ? AND default_layout_id = ?`,
      )
      .run(displayId, layoutId);
    void this.notify("display_layouts", "delete", layoutId);
  }

  createLayout(input: {
    name: string;
    description?: string | null;
    priority?: string;
    cooling_timeout_seconds?: number | null;
    preload_camera_ids?: number[];
    resets_idle_timer?: boolean;
  }): Layout {
    // Legacy NOT NULL columns (template_id, display_id, regions, grid_*) are
    // populated with sentinel values: cells own their position now and the
    // grid is computed at read time. The columns will be dropped by a future
    // migration — until then they're inert.
    const result = this.prep(
      `INSERT INTO layouts (name, description, template_id, regions, grid_cols, grid_rows, display_id, priority, cooling_timeout_seconds, preload_camera_ids, is_default, resets_idle_timer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.name,
      input.description ?? null,
      null,
      J([]),
      1,
      1,
      0,
      input.priority ?? "normal",
      input.cooling_timeout_seconds ?? null,
      J(input.preload_camera_ids ?? []),
      B(false),
      B(input.resets_idle_timer ?? true),
    );
    const id = Number(result.lastInsertRowid);
    void this.notify("layouts", "create", id);
    const r = this.getLayoutById(id);
    if (!r) throw new Error("layout vanished after insert");
    return r;
  }

  updateLayout(id: number, patch: Partial<Layout>): void {
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
    this.db.prepare(`UPDATE layouts SET ${sets.join(", ")} WHERE id = ?`).run(...vals as any[]);
    void this.notify("layouts", "update", id);
  }

  deleteLayout(id: number): void {
    this.db.prepare(`DELETE FROM layout_cells WHERE layout_id = ?`).run(id);
    this.db.prepare(`DELETE FROM layout_labels WHERE layout_id = ?`).run(id);
    this.db.prepare(`DELETE FROM display_layouts WHERE layout_id = ?`).run(id);
    // Any display whose default pointed here gets cleared.
    this.db.prepare(`UPDATE displays SET default_layout_id = NULL WHERE default_layout_id = ?`).run(id);
    this.db.prepare(`DELETE FROM layouts WHERE id = ?`).run(id);
    void this.notify("layouts", "delete", id);
  }

  // ===========================================================================
  // layout cells
  // ===========================================================================

  createLayoutCell(input: {
    layout_id: number;
    row: number;
    col: number;
    row_span?: number;
    col_span?: number;
    content_type: string;
    camera_id?: number | null;
    stream_selector?: string | null;
    web_url?: string | null;
    html_content?: string | null;
    cooling_timeout_seconds?: number | null;
    options?: Record<string, unknown>;
  }): LayoutCell {
    // region_name column is legacy NOT NULL — synthesize a unique placeholder
    // until the column is dropped by a future migration. Nothing reads it.
    const placeholder = `cell_${input.layout_id}_${input.row}_${input.col}_${Date.now()}`;
    const result = this.prep(
      `INSERT INTO layout_cells (layout_id, region_name, "row", col, row_span, col_span, content_type, camera_id, stream_selector, web_url, html_content, cooling_timeout_seconds, options)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.layout_id,
      placeholder,
      input.row,
      input.col,
      input.row_span ?? 1,
      input.col_span ?? 1,
      input.content_type,
      input.camera_id ?? null,
      input.stream_selector ?? "auto",
      input.web_url ?? null,
      input.html_content ?? null,
      input.cooling_timeout_seconds ?? null,
      J(input.options ?? {}),
    );
    const id = Number(result.lastInsertRowid);
    void this.notify("layout_cells", "create", id);
    const r = this.prep("SELECT * FROM layout_cells WHERE id = ?").get(id);
    if (!r) throw new Error("layout_cell vanished after insert");
    return rowToLayoutCell(r as Record<string, unknown>);
  }

  updateLayoutCell(id: number, patch: Partial<LayoutCell>): void {
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
    this.db.prepare(`UPDATE layout_cells SET ${sets.join(", ")} WHERE id = ?`).run(...vals as any[]);
    void this.notify("layout_cells", "update", id);
  }

  deleteLayoutCell(id: number): void {
    this.db.prepare(`DELETE FROM layout_cells WHERE id = ?`).run(id);
    void this.notify("layout_cells", "delete", id);
  }

  /**
   * Shift cells along an axis to make room for an insertion (or close a gap
   * after a deletion). For axis="row", any cell whose `row >= fromIndex` has
   * its row bumped by `delta`. Same for axis="col". Used by the visual
   * builder when adding a cell to the top/left of an existing one.
   */
  shiftCellsForLayout(
    layoutId: number,
    axis: "row" | "col",
    fromIndex: number,
    delta: number,
  ): void {
    if (delta === 0) return;
    const colName = axis === "row" ? `"row"` : "col";
    this.db
      .prepare(
        `UPDATE layout_cells
            SET ${colName} = ${colName} + ?
          WHERE layout_id = ?
            AND ${colName} >= ?`,
      )
      .run(delta, layoutId, fromIndex);
    void this.notify("layout_cells", "update", layoutId);
  }

  listLayoutCells(layoutId: number): LayoutCell[] {
    const rs = this.prep(
      `SELECT * FROM layout_cells WHERE layout_id = ? ORDER BY "row", col`,
    ).all(layoutId);
    return rs.map((r) => rowToLayoutCell(r as Record<string, unknown>));
  }

  // ===========================================================================
  // display-chain bundle queries (kiosk → display → layouts → cells → cameras)
  // ===========================================================================

  /** Bundle generation: layouts attached to a display via display_layouts. */
  layoutsForDisplayId(displayId: number): Layout[] {
    return this.listLayoutsForDisplay(displayId);
  }

  camerasForLayoutIds(layoutIds: number[]): Camera[] {
    if (layoutIds.length === 0) return [];
    const placeholders = layoutIds.map(() => "?").join(",");
    const rs = this.db
      .prepare(
        `SELECT DISTINCT c.* FROM cameras c
           JOIN layout_cells lc ON lc.camera_id = c.id
          WHERE lc.layout_id IN (${placeholders})
            AND c.enabled = 1
          ORDER BY c.name`,
      )
      .all(...(layoutIds as never[]));
    return rs.map((r) => rowToCamera(r as Record<string, unknown>));
  }

  // ===========================================================================
  // cameras
  // ===========================================================================

  listCameras(): Camera[] {
    const rs = this.prep("SELECT * FROM cameras ORDER BY name").all();
    return rs.map((r) => rowToCamera(r as Record<string, unknown>));
  }

  getCameraById(id: number): Camera | null {
    const r = this.prep("SELECT * FROM cameras WHERE id = ?").get(id);
    return r ? rowToCamera(r as Record<string, unknown>) : null;
  }

  getCameraByName(name: string): Camera | null {
    const r = this.prep("SELECT * FROM cameras WHERE name = ?").get(name);
    return r ? rowToCamera(r as Record<string, unknown>) : null;
  }

  createCamera(input: {
    name: string;
    type: CameraType;
    rtsp_url?: string | null;
    onvif_host?: string | null;
    onvif_port?: number | null;
    onvif_username?: string | null;
    onvif_password?: string | null; // already-encrypted ciphertext
    capabilities?: string[];
    stream_policy?: StreamPolicy;
  }): Camera {
    const result = this.prep(
      `INSERT INTO cameras
         (name, type, rtsp_url, onvif_host, onvif_port, onvif_username,
          onvif_password, capabilities, stream_policy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.name,
      input.type,
      input.rtsp_url ?? null,
      input.onvif_host ?? null,
      input.onvif_port ?? null,
      input.onvif_username ?? null,
      input.onvif_password ?? null,
      J(input.capabilities ?? []),
      input.stream_policy ?? "auto",
    );
    const id = Number(result.lastInsertRowid);
    void this.notify("cameras", "create", id);
    const c = this.getCameraById(id);
    if (!c) throw new Error("camera vanished after insert");
    return c;
  }

  listCameraStreams(cameraId: number): CameraStream[] {
    const rs = this.prep(
      "SELECT * FROM camera_streams WHERE camera_id = ?",
    ).all(cameraId);
    return rs.map((r) => rowToCameraStream(r as Record<string, unknown>));
  }

  createCameraStream(input: {
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
  }): CameraStream {
    const result = this.prep(
      `INSERT INTO camera_streams
        (camera_id, role, name, profile_token, rtsp_uri, width, height,
         encoding, framerate, bitrate_kbps, is_discovered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
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
    );
    const id = Number(result.lastInsertRowid);
    const r = this.prep("SELECT * FROM camera_streams WHERE id = ?").get(id);
    if (!r) throw new Error("camera_stream vanished after insert");
    void this.notify("camera_streams", "create", id);
    return rowToCameraStream(r as Record<string, unknown>);
  }

  updateCameraStream(id: number, patch: Partial<CameraStream>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "camera_id") continue;
      sets.push(`${k} = ?`);
      vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE camera_streams SET ${sets.join(", ")} WHERE id = ?`).run(...vals as any[]);
    void this.notify("camera_streams", "update", id);
  }

  // ===========================================================================
  // labels (incl. join tables)
  // ===========================================================================

  listLabels(): Label[] {
    const rs = this.prep("SELECT * FROM labels ORDER BY name").all();
    return rs.map((r) => rowToLabel(r as Record<string, unknown>));
  }

  getLabelByName(name: string): Label | null {
    const r = this.prep("SELECT * FROM labels WHERE name = ?").get(name);
    return r ? rowToLabel(r as Record<string, unknown>) : null;
  }

  createLabel(input: {
    name: string;
    description?: string | null;
    color?: string | null;
  }): Label {
    const result = this.prep(
      `INSERT INTO labels (name, description, color)
       VALUES (?, ?, ?)`,
    ).run(input.name, input.description ?? null, input.color ?? null);
    const id = Number(result.lastInsertRowid);
    void this.notify("labels", "create", id);
    const r = this.prep("SELECT * FROM labels WHERE id = ?").get(id);
    if (!r) throw new Error("label vanished after insert");
    return rowToLabel(r as Record<string, unknown>);
  }

  /** Get-or-create label by name (used during pairing's free-text label input). */
  ensureLabel(name: string): Label {
    return this.getLabelByName(name) ?? this.createLabel({ name });
  }

  attachKioskLabel(kioskId: number, labelId: number, role: LabelRole): void {
    this.prep(
      `INSERT OR IGNORE INTO kiosk_labels (kiosk_id, label_id, role)
       VALUES (?, ?, ?)`,
    ).run(kioskId, labelId, role);
  }

  listKioskLabels(kioskId: number): Array<KioskLabel & { name: string }> {
    const rs = this.prep(
      `SELECT kl.kiosk_id, kl.label_id, kl.role, l.name
         FROM kiosk_labels kl
         JOIN labels l ON l.id = kl.label_id
        WHERE kl.kiosk_id = ?`,
    ).all(kioskId);
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

  attachCameraLabel(cameraId: number, labelId: number): void {
    this.prep(
      `INSERT OR IGNORE INTO camera_labels (camera_id, label_id)
       VALUES (?, ?)`,
    ).run(cameraId, labelId);
  }

  attachLayoutLabel(layoutId: number, labelId: number): void {
    this.prep(
      `INSERT OR IGNORE INTO layout_labels (layout_id, label_id)
       VALUES (?, ?)`,
    ).run(layoutId, labelId);
  }

  // ===========================================================================
  // kiosks
  // ===========================================================================

  listKiosks(): Kiosk[] {
    const rs = this.prep("SELECT * FROM kiosks ORDER BY name").all();
    return rs.map((r) => rowToKiosk(r as Record<string, unknown>));
  }

  getKioskById(id: number): Kiosk | null {
    const r = this.prep("SELECT * FROM kiosks WHERE id = ?").get(id);
    return r ? rowToKiosk(r as Record<string, unknown>) : null;
  }

  getKioskByName(name: string): Kiosk | null {
    const r = this.prep("SELECT * FROM kiosks WHERE name = ?").get(name);
    return r ? rowToKiosk(r as Record<string, unknown>) : null;
  }

  /** Lookup candidates by Bearer-key prefix; verify hash at the call site. */
  listKiosksByKeyPrefix(prefix: string): Kiosk[] {
    const rs = this.prep(
      "SELECT * FROM kiosks WHERE key_prefix = ? AND enabled = 1",
    ).all(prefix);
    return rs.map((r) => rowToKiosk(r as Record<string, unknown>));
  }

  createKiosk(input: {
    name: string;
    key_hash: string;
    key_prefix: string;
    capabilities?: string[];
    hardware_model?: string | null;
  }): Kiosk {
    const result = this.prep(
      `INSERT INTO kiosks
        (name, key_hash, key_prefix, capabilities, hardware_model, paired_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.name,
      input.key_hash,
      input.key_prefix,
      J(input.capabilities ?? []),
      input.hardware_model ?? null,
      isoNow(),
    );
    const id = Number(result.lastInsertRowid);
    void this.notify("kiosks", "create", id);
    const k = this.getKioskById(id);
    if (!k) throw new Error("kiosk vanished after insert");
    return k;
  }

  touchKiosk(
    id: number,
    patch: {
      bundle_version?: string | null;
      kiosk_app_version?: string | null;
      os_version?: string | null;
    },
  ): void {
    this.prep(
      `UPDATE kiosks SET
         last_seen_at = ?,
         last_bundle_version = COALESCE(?, last_bundle_version),
         kiosk_app_version = COALESCE(?, kiosk_app_version),
         os_version = COALESCE(?, os_version)
       WHERE id = ?`,
    ).run(
      isoNow(),
      patch.bundle_version ?? null,
      patch.kiosk_app_version ?? null,
      patch.os_version ?? null,
      id,
    );
  }

  // ===========================================================================
  // pairing_codes
  // ===========================================================================

  createPairingCode(input: {
    code: string;
    kiosk_proposed_name: string | null;
    kiosk_hardware_model: string | null;
    kiosk_capabilities: string[];
    expires_at: string;
    extras: Record<string, unknown>;
  }): PairingCode {
    this.prep(
      `INSERT INTO pairing_codes
         (code, kiosk_proposed_name, kiosk_hardware_model, kiosk_capabilities,
          expires_at, extras)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.code,
      input.kiosk_proposed_name,
      input.kiosk_hardware_model,
      J(input.kiosk_capabilities),
      input.expires_at,
      J(input.extras),
    );
    const r = this.prep("SELECT * FROM pairing_codes WHERE code = ?").get(input.code);
    if (!r) throw new Error("pairing_code vanished after insert");
    return rowToPairingCode(r as Record<string, unknown>);
  }

  getPairingCode(code: string): PairingCode | null {
    const r = this.prep("SELECT * FROM pairing_codes WHERE code = ?").get(code);
    return r ? rowToPairingCode(r as Record<string, unknown>) : null;
  }

  listPendingPairingCodes(): PairingCode[] {
    const rs = this.prep(
      `SELECT * FROM pairing_codes
        WHERE consumed_at IS NULL AND expires_at > ?
        ORDER BY issued_at DESC`,
    ).all(isoNow());
    return rs.map((r) => rowToPairingCode(r as Record<string, unknown>));
  }

  markPairingCodeClaimed(
    code: string,
    kioskId: number,
    extras: Record<string, unknown>,
  ): void {
    this.prep(
      `UPDATE pairing_codes
          SET consumed_at = ?,
              consumed_by_kiosk_id = ?,
              extras = ?
        WHERE code = ?`,
    ).run(isoNow(), kioskId, J(extras), code);
  }

  updatePairingCodeExtras(code: string, extras: Record<string, unknown>): void {
    this.prep("UPDATE pairing_codes SET extras = ? WHERE code = ?").run(
      J(extras),
      code,
    );
  }

  // ===========================================================================
  // event_log
  // ===========================================================================

  insertEvent(input: {
    source_kiosk_id: number | null;
    source_camera_id: number | null;
    source_type: EventSourceType;
    topic: string;
    property_op: string | null;
    payload: Record<string, unknown>;
    forwarded_to_nodered: boolean;
  }): number {
    const result = this.prep(
      `INSERT INTO event_log
         (source_kiosk_id, source_camera_id, source_type, topic,
          property_op, payload, forwarded_to_nodered)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.source_kiosk_id,
      input.source_camera_id,
      input.source_type,
      input.topic,
      input.property_op,
      J(input.payload),
      B(input.forwarded_to_nodered),
    );
    return Number(result.lastInsertRowid);
  }

  recentEvents(limit = 10): EventLog[] {
    const rs = this.prep(
      "SELECT * FROM event_log ORDER BY received_at DESC LIMIT ?",
    ).all(limit);
    return rs.map((r) => rowToEventLog(r as Record<string, unknown>));
  }

  // ===========================================================================
  // bundle queries (label-aware composite reads)
  // ===========================================================================

  /**
   * Returns label IDs + names attached to a kiosk by role.
   * Used by `service-bundle` to scope a kiosk's view of the world.
   */
  bundleScope(kioskId: number): {
    labelIds: number[];
    labelNames: string[];
    operateLabelIds: number[];
    operateLabelNames: string[];
  } {
    const all = this.listKioskLabels(kioskId);
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
  camerasForLabelIds(labelIds: number[]): Camera[] {
    if (labelIds.length === 0) return [];
    const placeholders = labelIds.map(() => "?").join(",");
    const rs = this.db
      .prepare(
        `SELECT DISTINCT c.* FROM cameras c
           JOIN camera_labels cl ON cl.camera_id = c.id
          WHERE cl.label_id IN (${placeholders})
            AND c.enabled = 1
          ORDER BY c.name`,
      )
      .all(...(labelIds as never[]));
    return rs.map((r) => rowToCamera(r as Record<string, unknown>));
  }

  layoutsForLabelIds(labelIds: number[]): Layout[] {
    if (labelIds.length === 0) return [];
    const placeholders = labelIds.map(() => "?").join(",");
    const rs = this.db
      .prepare(
        `SELECT DISTINCT l.* FROM layouts l
           JOIN layout_labels ll ON ll.layout_id = l.id
          WHERE ll.label_id IN (${placeholders})
          ORDER BY l.name`,
      )
      .all(...(labelIds as never[]));
    return rs.map((r) => rowToLayout(r as Record<string, unknown>));
  }

  layoutCells(layoutId: number): LayoutCell[] {
    return this.listLayoutCells(layoutId);
  }

  layoutTemplates(ids: number[]): LayoutTemplate[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rs = this.db
      .prepare(
        `SELECT * FROM layout_templates WHERE id IN (${placeholders})`,
      )
      .all(...(ids as never[]));
    return rs.map((r) => rowToLayoutTemplate(r as Record<string, unknown>));
  }

  cameraLabelNames(cameraId: number): string[] {
    const rs = this.prep(
      `SELECT l.name FROM camera_labels cl
         JOIN labels l ON l.id = cl.label_id
        WHERE cl.camera_id = ?`,
    ).all(cameraId);
    return rs.map((r) => String((r as Record<string, unknown>)["name"]));
  }

  cameraLabelIds(cameraId: number): Array<{ label_id: number; name: string }> {
    const rs = this.prep(
      `SELECT cl.label_id, l.name FROM camera_labels cl
         JOIN labels l ON l.id = cl.label_id
        WHERE cl.camera_id = ?`,
    ).all(cameraId);
    return rs.map((r) => {
      const row = r as Record<string, unknown>;
      return { label_id: Number(row["label_id"]), name: String(row["name"]) };
    });
  }

  updateCamera(id: number, patch: Partial<Camera>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "created_at") continue;
      sets.push(`${k} = ?`);
      vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE cameras SET ${sets.join(", ")} WHERE id = ?`).run(...vals as any[]);
    void this.notify("cameras", "update", id);
  }

  deleteCamera(id: number): void {
    this.db.prepare(`DELETE FROM camera_labels WHERE camera_id = ?`).run(id);
    this.db.prepare(`DELETE FROM camera_streams WHERE camera_id = ?`).run(id);
    this.db.prepare(`DELETE FROM layout_cells WHERE camera_id = ?`).run(id);
    this.db.prepare(`DELETE FROM cameras WHERE id = ?`).run(id);
    void this.notify("cameras", "delete", id);
  }

  updateKiosk(id: number, patch: Partial<Kiosk>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "created_at" || k === "paired_at") continue;
      sets.push(`${k} = ?`);
      vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE kiosks SET ${sets.join(", ")} WHERE id = ?`).run(...vals as any[]);
    void this.notify("kiosks", "update", id);
  }

  deleteKiosk(id: number): void {
    this.db.prepare(`DELETE FROM kiosk_labels WHERE kiosk_id = ?`).run(id);
    this.db.prepare(`DELETE FROM kiosks WHERE id = ?`).run(id);
    void this.notify("kiosks", "delete", id);
  }

  detachCameraLabel(cameraId: number, labelId: number): void {
    this.db.prepare(`DELETE FROM camera_labels WHERE camera_id = ? AND label_id = ?`).run(cameraId, labelId);
  }

  detachKioskLabel(kioskId: number, labelId: number): void {
    this.db.prepare(`DELETE FROM kiosk_labels WHERE kiosk_id = ? AND label_id = ?`).run(kioskId, labelId);
  }

  deleteLabel(id: number): void {
    this.db.prepare(`DELETE FROM camera_labels WHERE label_id = ?`).run(id);
    this.db.prepare(`DELETE FROM kiosk_labels WHERE label_id = ?`).run(id);
    this.db.prepare(`DELETE FROM layout_labels WHERE label_id = ?`).run(id);
    this.db.prepare(`DELETE FROM labels WHERE id = ?`).run(id);
    void this.notify("labels", "delete", id);
  }

  updateLabel(id: number, patch: { name?: string; description?: string | null; color?: string | null }): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      vals.push(v === undefined ? null : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE labels SET ${sets.join(", ")} WHERE id = ?`).run(...vals as any[]);
    void this.notify("labels", "update", id);
  }
}
