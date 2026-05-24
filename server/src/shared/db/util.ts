/**
 * SQLite row → TS object mapping helpers.
 *
 * SQLite booleans are stored as INTEGER 0/1 — convert with `b()`.
 * JSON columns are stored as TEXT — parse with `j()` / serialize with `J()`.
 */

export function b(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

export function B(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function j<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function J(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function isoNow(): string {
  return new Date().toISOString();
}

/** Add `n` seconds to `now()` and return ISO. */
export function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** Compare two ISO strings as UTC datetimes. -1, 0, 1. */
export function isoCmp(a: string, b: string): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
