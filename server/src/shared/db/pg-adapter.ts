/**
 * Postgres backend for the repository.
 *
 * Translates `?` placeholders to Postgres `$1, $2, ...` at execute time
 * so Repository SQL stays clean. Rewrites `INSERT OR IGNORE` to
 * `INSERT ... ON CONFLICT DO NOTHING` for Postgres compatibility.
 *
 * Pool size: default 10 — configurable via pgPoolMax in sec-config.yaml.
 */
import { Pool, type PoolClient } from "pg";

import type { DbAdapter, RunResult, Row, SqlValue } from "./db-adapter.js";

export class PgAdapter implements DbAdapter {
  private readonly pool: Pool;
  private currentTxClient: PoolClient | null = null;
  private txDepth = 0;
  private searchPath = "public";

  constructor(connectionString: string, poolMax: number = 10) {
    this.pool = new Pool({
      connectionString,
      max: poolMax,
      idleTimeoutMillis: 30_000,
    });
  }

  private rewriteSql(sql: string): string {
    // SQLite → PG dialect fixups.
    if (/INSERT\s+OR\s+IGNORE/i.test(sql)) {
      sql = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, "INSERT INTO");
      sql = sql.trimEnd().replace(/;?\s*$/, " ON CONFLICT DO NOTHING");
    }
    if (/INSERT\s+OR\s+REPLACE/i.test(sql)) {
      sql = sql.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, "INSERT INTO");
    }

    // `?` → `$1`, `$2`, ... Skips `?` characters inside string literals.
    let out = "";
    let n = 0;
    let inString = false;
    let stringChar = "";
    for (let i = 0; i < sql.length; i += 1) {
      const c = sql[i]!;
      if (inString) {
        out += c;
        if (c === stringChar) {
          // Handle '' escape.
          if (sql[i + 1] === stringChar) { out += sql[i + 1]; i += 1; }
          else inString = false;
        }
        continue;
      }
      if (c === "'" || c === '"') {
        inString = true;
        stringChar = c;
        out += c;
        continue;
      }
      if (c === "?") {
        n += 1;
        out += `$${n}`;
        continue;
      }
      out += c;
    }
    return out;
  }

  private async runner<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    if (this.currentTxClient) return fn(this.currentTxClient);
    const client = await this.pool.connect();
    try {
      await client.query(`SET search_path TO ${this.searchPath}, public`);
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async run(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<RunResult> {
    const pgSql = this.rewriteSql(sql);
    return this.runner(async (c) => {
      const res = await c.query(pgSql, params as unknown[]);
      let lastInsertRowid = 0n;
      // If the caller added RETURNING id, pluck it.
      if (res.rows.length > 0 && res.rows[0] && "id" in res.rows[0]) {
        const v = (res.rows[0] as Record<string, unknown>)["id"];
        if (typeof v === "number" || typeof v === "bigint") {
          lastInsertRowid = BigInt(v);
        }
      }
      return { lastInsertRowid, changes: Number(res.rowCount ?? 0) };
    });
  }

  async get<T = Row>(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<T | undefined> {
    const pgSql = this.rewriteSql(sql);
    return this.runner(async (c) => {
      const res = await c.query(pgSql, params as unknown[]);
      return (res.rows[0] as T | undefined);
    });
  }

  async all<T = Row>(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<T[]> {
    const pgSql = this.rewriteSql(sql);
    return this.runner(async (c) => {
      const res = await c.query(pgSql, params as unknown[]);
      return res.rows as T[];
    });
  }

  async exec(sql: string): Promise<void> {
    // PG accepts multi-statement strings via simple query protocol.
    await this.runner(async (c) => { await c.query(sql); });
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.currentTxClient) {
      // Already in a transaction — use a savepoint.
      this.txDepth += 1;
      const name = `sp_${this.txDepth}`;
      await this.currentTxClient.query(`SAVEPOINT ${name}`);
      try {
        const result = await fn();
        await this.currentTxClient.query(`RELEASE SAVEPOINT ${name}`);
        this.txDepth -= 1;
        return result;
      } catch (err) {
        try { await this.currentTxClient.query(`ROLLBACK TO SAVEPOINT ${name}`); } catch { /* ignore */ }
        this.txDepth -= 1;
        throw err;
      }
    }
    const client = await this.pool.connect();
    this.currentTxClient = client;
    this.txDepth = 1;
    try {
      await client.query("BEGIN");
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    } finally {
      this.currentTxClient = null;
      this.txDepth = 0;
      client.release();
    }
  }

  dialect(): "postgres" { return "postgres"; }

  async setSearchPath(schema: string): Promise<void> {
    if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
      throw new Error(`invalid schema name: ${schema}`);
    }
    this.searchPath = schema;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
