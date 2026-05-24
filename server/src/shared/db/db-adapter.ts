/**
 * Backend-agnostic DB adapter. Repository talks to this; concrete adapters
 * (sqlite, postgres) implement it.
 *
 * Design choices:
 * - All methods return Promises so the Postgres path can use real async I/O.
 *   The SQLite adapter wraps node:sqlite's synchronous calls in
 *   Promise.resolve to keep the same interface.
 * - `?` is the canonical placeholder in SQL strings. The Postgres adapter
 *   rewrites them to `$1, $2, ...` at execute time so repository code stays
 *   dialect-neutral.
 * - INSERTs that need to return the new row id must use `... RETURNING id`
 *   explicitly. Both SQLite (3.35+) and Postgres support it.
 *
 * Migrations and DDL fragments still differ between dialects (AUTOINCREMENT
 * vs SERIAL, STRICT vs nothing, strftime vs now()), so each backend ships
 * its own migration set rather than trying to abstract DDL.
 */

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;
export type Row = Record<string, unknown>;

export interface RunResult {
  /** New row id when the statement used `RETURNING id`, else 0n. */
  lastInsertRowid: bigint;
  /** Rows affected (approximate for some Postgres queries). */
  changes: number;
}

export interface DbAdapter {
  /** Execute a write statement (INSERT / UPDATE / DELETE). */
  run(sql: string, params?: ReadonlyArray<SqlValue>): Promise<RunResult>;
  /** Single-row query. Undefined if no row. */
  get<T = Row>(sql: string, params?: ReadonlyArray<SqlValue>): Promise<T | undefined>;
  /** Multi-row query. */
  all<T = Row>(sql: string, params?: ReadonlyArray<SqlValue>): Promise<T[]>;
  /** Execute multi-statement DDL (no params, no result). */
  exec(sql: string): Promise<void>;
  /** Run a callback inside a transaction. Rolls back on throw. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Identifies the backend. */
  dialect(): "sqlite" | "postgres";
  /** Release the connection / pool. */
  close(): Promise<void>;
}

export interface DbAdapterConfig {
  driver: "sqlite" | "postgres";
  /** SQLite-only: filesystem path. */
  sqlitePath?: string;
  /** Postgres-only: connection string (postgres://user:pass@host:port/db). */
  pgUrl?: string;
}
