/**
 * Backend-agnostic DB adapter. Repository talks to this; PG adapter implements it.
 *
 * Design choices:
 * - All methods return Promises (real async I/O with PG pool).
 * - `?` is the canonical placeholder in SQL strings. The PG adapter
 *   rewrites them to `$1, $2, ...` at execute time so repository code stays
 *   dialect-neutral.
 */

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;
export type Row = Record<string, unknown>;

export interface RunResult {
  lastInsertRowid: bigint;
  changes: number;
}

export interface DbAdapter {
  run(sql: string, params?: ReadonlyArray<SqlValue>): Promise<RunResult>;
  get<T = Row>(sql: string, params?: ReadonlyArray<SqlValue>): Promise<T | undefined>;
  all<T = Row>(sql: string, params?: ReadonlyArray<SqlValue>): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  dialect(): "postgres";
  setSearchPath(schema: string): Promise<void>;
  close(): Promise<void>;
}
