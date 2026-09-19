import { createError } from "h3";
import type { KioskLogLevel } from "./types.js";

export interface LogCursor { time: string; id: string }
export interface LogFilters {
  kiosk_id?: string;
  level?: KioskLogLevel;
  source?: "app" | "os";
  search: string;
  from?: string;
  until: string;
  limit: number;
  before?: LogCursor;
}
export interface LogSummary {
  id: string; kiosk_id: string; kiosk_name: string; level: KioskLogLevel;
  preview: string; characters: number; lines: number;
  source: string; unit: string; boot_id: string;
  logged_at: string; received_at: string; cursor_time: string;
}
export interface LogPage { logs: LogSummary[]; hasMore: boolean }

export function encodeLogCursor(cursor: LogCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
function badFilter(): never { throw createError({ statusCode: 400, statusMessage: "Invalid log filters" }); }
function timestamp(value: string): string {
  // Keep PostgreSQL's microseconds for exact pagination boundaries.
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,6})?)?Z$/.test(value) || !Number.isFinite(Date.parse(value))) badFilter();
  return value;
}
export function parseLogFilters(query: Record<string, unknown>, kioskId?: string): LogFilters {
  const text = (name: string) => {
    const value = query[name];
    if (value == null) return "";
    if (typeof value !== "string" || value.length > 512) badFilter();
    return value.trim();
  };
  const level = text("level");
  const source = text("source");
  const limit = Number(text("limit") || 100);
  if ((level && !["debug", "info", "warn", "error"].includes(level))
      || (source && !["app", "os"].includes(source)) || ![50, 100, 200].includes(limit)) badFilter();
  const from = text("from");
  const until = text("until");
  const cursor = text("before");
  let before: LogCursor | undefined;
  if (cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (typeof parsed.id !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(parsed.id) || typeof parsed.time !== "string") badFilter();
      before = { time: timestamp(parsed.time), id: parsed.id };
    } catch { badFilter(); }
  }
  const filters: LogFilters = {
    kiosk_id: kioskId || text("kiosk") || undefined,
    level: (level || undefined) as KioskLogLevel | undefined,
    source: (source || undefined) as "app" | "os" | undefined,
    search: text("q").slice(0, 256),
    from: from ? timestamp(from.endsWith("Z") ? from : from + "Z") : undefined,
    until: until ? timestamp(until.endsWith("Z") ? until : until + "Z") : new Date().toISOString(), limit, before,
  };
  if (filters.from && Date.parse(filters.from) > Date.parse(filters.until)) badFilter();
  return filters;
}

export function logViewUrl(base: string, filters: LogFilters, before?: LogCursor): string {
  const query = new URLSearchParams({ until: filters.until, limit: String(filters.limit) });
  if (filters.kiosk_id && base === "/admin/logs") query.set("kiosk", filters.kiosk_id);
  if (filters.level) query.set("level", filters.level);
  if (filters.source) query.set("source", filters.source);
  if (filters.search) query.set("q", filters.search);
  if (filters.from) query.set("from", filters.from);
  if (before) query.set("before", encodeLogCursor(before));
  return `${base}?${query}`;
}
