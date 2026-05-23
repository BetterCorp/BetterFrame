/**
 * SQLite backend for the repository. Wraps node:sqlite (sync API) in
 * Promise-returning methods so the Repository can stay async-uniform across
 * both backends.
 *
 * Prepared statements are cached per-SQL for perf parity with the
 * old direct-DatabaseSync code path.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { DbAdapter, RunResult, Row, SqlValue } from "./db-adapter.js";

export class SqliteAdapter implements DbAdapter {
  private readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA synchronous = NORMAL");
  }

  /** Wrap an already-opened DatabaseSync (e.g. after migrations ran). */
  static fromExisting(db: DatabaseSync): SqliteAdapter {
    const adapter = Object.create(SqliteAdapter.prototype) as SqliteAdapter;
    (adapter as any).db = db;
    (adapter as any).stmts = new Map();
    (adapter as any).txDepth = 0;
    return adapter;
  }

  private prep(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  async run(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<RunResult> {
    const stmt = this.prep(sql);
    const r = stmt.run(...(params as any[]));
    return {
      lastInsertRowid:
        typeof r.lastInsertRowid === "bigint" ? r.lastInsertRowid : BigInt(r.lastInsertRowid),
      changes: Number(r.changes),
    };
  }

  async get<T = Row>(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<T | undefined> {
    const stmt = this.prep(sql);
    const r = stmt.get(...(params as any[]));
    return r as T | undefined;
  }

  async all<T = Row>(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<T[]> {
    const stmt = this.prep(sql);
    return stmt.all(...(params as any[])) as T[];
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txDepth === 0) this.db.exec("BEGIN");
    this.txDepth += 1;
    try {
      const result = await fn();
      this.txDepth -= 1;
      if (this.txDepth === 0) this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.txDepth -= 1;
      if (this.txDepth === 0) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      }
      throw err;
    }
  }

  dialect(): "sqlite" { return "sqlite"; }

  async close(): Promise<void> {
    this.db.close();
  }

  /** Expose raw DB for migrations that need fine control (idempotent
   *  ALTER TABLE, PRAGMA inspection, etc). Sqlite-only. */
  rawSync(): DatabaseSync { return this.db; }
}
