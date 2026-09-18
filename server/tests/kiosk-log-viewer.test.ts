import assert from "node:assert/strict";
import test from "node:test";
import { H3 } from "h3";
import { parseLogFilters, encodeLogCursor, logViewUrl, type LogSummary } from "../src/shared/kiosk-log-view.js";
import { KioskLogViewer } from "../src/web-templates/kiosk-log-viewer.js";
import { registerLogRoutes } from "../src/plugins/service-admin-http/routes-logs.js";
import { operatorMayAccess } from "../src/plugins/service-admin-http/middleware.js";

const stamp = "2026-09-18T12:00:00.123456Z";
test("log cursors preserve microseconds, filter scope and snapshot across pages", () => {
  const cursor = {time: stamp, id: "log-1"};
  const filters = parseLogFilters({before: encodeLogCursor(cursor), until: stamp, level: "error", source: "os", q: "panic", limit: "200", kiosk: "wrong-kiosk"}, "pinned-kiosk");
  assert.deepEqual(filters.before, cursor);
  assert.equal(filters.kiosk_id, "pinned-kiosk");
  const url = new URL(logViewUrl("/admin/logs", filters, cursor), "http://bf.test");
  assert.equal(url.searchParams.get("until"), stamp);
  assert.equal(url.searchParams.get("kiosk"), "pinned-kiosk");
  assert.equal(url.searchParams.get("q"), "panic");
  assert.equal(parseLogFilters({from: "2026-09-18T09:00", until: "2026-09-18T10:00"}).from, "2026-09-18T09:00Z");
  for (const input of [{limit: "10000"}, {source: "unknown"}, {level: "trace"}, {before: "invalid"}, {until: "yesterday"}, {q: ["a", "b"]}, {from: "2026-10-01T00:00Z", until: stamp}]) assert.throws(() => parseLogFilters(input));
});

test("log summaries escape uploaded text and defer full messages/context", () => {
  const hostile = '<script>alert("log")</script>';
  const row: LogSummary = {id: "id", kiosk_id: "k1", kiosk_name: hostile, level: "error", preview: hostile + "\nsecond line", characters: 14000, lines: 400, source: "os", unit: hostile, boot_id: "boot1", logged_at: stamp, received_at: stamp, cursor_time: stamp};
  const html = String(KioskLogViewer({user: "admin", devices: [{id: "k1", name: hostile}], filters: parseLogFilters({until: stamp}), page: {logs: [row], hasMore: true}}));
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /data-log-url="\/admin\/logs\/id"/);
  assert.match(html, /400 lines/);
  assert.match(html, /14,000 chars/);
  assert.match(html, /Older logs/);
  assert.doesNotMatch(html, /<pre/);
});

test("fleet and per-kiosk routes share the viewer, enforce pinned filters and handle expired details", async () => {
  const seen: unknown[] = [];
  const app = new H3();
  app.use(event => { event.context.user = {username: "admin"} as never; });
  registerLogRoutes(app, {repo: {
    listKioskLogDevices: async () => [{id: "k1", name: "Lobby"}],
    queryKioskLogs: async (filters: unknown) => { seen.push(filters); return {logs: [], hasMore: false}; },
    getKioskLog: async (id: string) => id === "valid" ? {id, message: "first\nsecond", context: {boot_id: "boot1"}} : null,
  }} as never);
  assert.equal((await app.request("http://bf.test/admin/logs")).status, 200);
  assert.equal((await app.request("http://bf.test/admin/kiosks/k1/diagnostics?kiosk=k2")).status, 200);
  assert.equal((seen[1] as {kiosk_id: string}).kiosk_id, "k1");
  assert.equal((await app.request("http://bf.test/admin/kiosks/missing/diagnostics")).status, 404);
  assert.equal((await app.request("http://bf.test/admin/logs/missing")).status, 404);
  const detail = await app.request("http://bf.test/admin/logs/valid");
  assert.equal(detail.headers.get("cache-control"), "no-store");
  assert.equal(((await detail.json()) as {message: string}).message, "first\nsecond");
  assert.equal(operatorMayAccess("/admin/logs", "GET"), true);
  assert.equal(operatorMayAccess("/admin/logs/valid", "POST"), false);
  assert.equal(operatorMayAccess("/admin/kiosks/k1/logs", "GET"), false, "live remote debug stays restricted");
});
