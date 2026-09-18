import assert from "node:assert/strict";
import test from "node:test";
import { parseKioskLogs } from "../src/shared/kiosk-logs.js";
import { parseLogFilters } from "../src/shared/kiosk-log-view.js";
import { purgeTenantKioskLogs } from "../src/shared/kiosk-log-retention.js";

test("log ingestion validates bounded batches before accepting events", () => {
  const entry = { event_id: "journal:boot1:1", message: "App exited", level: "error", logged_at: "2026-09-18T10:00:00Z", context: { source: "os", boot_id: "boot1" } };
  const parsed = parseKioskLogs({ entries: [entry] });
  assert.equal(parsed[0]?.event_id, entry.event_id);
  assert.equal(parsed[0]?.logged_at, "2026-09-18T10:00:00.000Z");
  assert.deepEqual(parsed[0]?.context, entry.context);
  const multiline = "Long trace\n\t".repeat(600);
  assert.equal(parseKioskLogs({entries: [{...entry, message: multiline} ]})[0]?.message, multiline);
  for (const entries of [[], Array(101).fill(entry), [{...entry, message: ""}],
    [{...entry, logged_at: "bad-date"}], [{...entry, context: []}], [{...entry, context: {large: "x".repeat(8192)}}],
    [{...entry, message: "x".repeat(16385)}]]) {
    assert.throws(() => parseKioskLogs({ entries }));
  }
});

test("retention visits inactive tenants and continues after an individual failure", async () => {
  const visited: string[] = []; const warnings: string[] = []; let schema = "";
  const repo = {
    listTenants: async () => [{id: "a", schema_name: "public", is_active: true}, {id: "b", schema_name: "broken", is_active: true}, {id: "c", schema_name: "inactive", is_active: false}],
    adapter: { withSearchPath: async (name: string, fn: () => Promise<number>) => { schema = name; visited.push(name); return fn(); } },
    purgeOldKioskLogs: async (hours: number) => { assert.equal(hours, 24); if (schema === "broken") throw Error("unavailable"); return 2; },
  };
  assert.equal(await purgeTenantKioskLogs(repo as never, 24, message => warnings.push(message)), 4);
  assert.deepEqual(visited, ["public", "broken", "inactive"]);
  assert.equal(warnings.length, 1);
});

test("PostgreSQL log retries, row IDs, retention and tenant isolation", { skip: !process.env["BF_TEST_PG_URL"] }, async () => {
  const { randomBytes } = await import("node:crypto");
  const { PgAdapter } = await import("../src/shared/db/pg-adapter.js");
  const { initDb, createTenantSchema } = await import("../src/shared/db/init.js");
  const admin = new PgAdapter(process.env["BF_TEST_PG_URL"]!);
  const dbName = `bf_logs_${randomBytes(8).toString("hex")}`;
  await admin.exec(`CREATE DATABASE "${dbName}"`);
  const url = new URL(process.env["BF_TEST_PG_URL"]!); url.pathname = `/${dbName}`;
  let close: (() => Promise<void>) | undefined;
  try {
    const handle = await initDb({url: url.toString(), host: "", port: 5432, user: "", password: "", database: dbName, poolMax: 3}, {info() {}, warn() {}});
    close = handle.close;
    const repo = handle.repo;
    const tenant = await repo.createTenant({name: "Log tenant", slug: "log-tenant"});
    await createTenantSchema(repo.adapter, tenant.slug, {info() {}, warn() {}});
    await repo.adapter.run("UPDATE public.tenants SET is_active = false WHERE id = ?", [tenant.id]);
    for (const schema of ["public", tenant.schema_name]) {
      await repo.adapter.withSearchPath(schema, async () => {
        const kiosk = await repo.createKiosk({name: "Test kiosk", key_hash: "unused", key_prefix: "unused"});
        const log = {level: "error" as const, message: "GPU failed", event_id: "journal:boot1:1", context: {source: "os", boot_id: "boot1"}};
        assert.equal(await repo.insertKioskLogs(kiosk.id, [log]), 1);
        assert.equal(await repo.insertKioskLogs(kiosk.id, [log]), 0);
        // Legacy clients without event IDs continue to work.
        assert.equal(await repo.insertKioskLogs(kiosk.id, [{level: "info", message: "legacy"}]), 1);
        for (let i = 0; i < 6; i++) await repo.insertKioskLogs(kiosk.id, Array.from({length: 100}, (_, n) => ({...log, event_id: `app:${i}:${n}`})));
        const filters = parseLogFilters({limit: "50"}, kiosk.id);
        const rows = await repo.queryKioskLogs(filters);
        assert.equal((await repo.adapter.get<{count: string}>("SELECT count(*) FROM kiosk_logs"))?.count, "602", "retention must not cut off at 500 rows");
        assert.equal(rows.logs.length, 50);
        assert.equal(rows.hasMore, true);
        assert.ok(rows.logs.every(row => !("message" in row) && !("context" in row)), "large payloads are loaded only on expansion");
        const infoRows = await repo.queryKioskLogs({...filters, level: "info"});
        assert.equal(infoRows.logs.length, 1);
        const last = rows.logs.at(-1)!;
        const nextPage = await repo.queryKioskLogs({...filters, before: {time: last.cursor_time, id: last.id}});
        assert.equal(nextPage.logs.length, 50);
        assert.ok(nextPage.logs.every(row => !rows.logs.some(first => first.id === row.id)));
        const detail = await repo.getKioskLog(last.id);
        assert.equal(detail?.message, "GPU failed");
        assert.deepEqual(detail?.context, log.context);
        assert.equal((await repo.queryKioskLogs({...filters, source: "app"})).logs.length, 0);
        assert.equal((await repo.queryKioskLogs({...filters, search: "GPU"})).logs.length, 50);
        assert.equal((await repo.queryKioskLogs({...filters, search: "%"})).logs.length, 0, "search metacharacters are literal");
        assert.equal((await repo.queryKioskLogs({...filters, search: "boot1"})).logs.length, 50, "structured context is searchable");
        const kiosk2 = await repo.createKiosk({name: "Second kiosk", key_hash: "unused-2", key_prefix: "unused-2"});
        await repo.insertKioskLogs(kiosk2.id, [{level: "warn", message: "Other kiosk"}]);
        const fleet = await repo.queryKioskLogs({...filters, kiosk_id: undefined});
        // Snapshot excludes logs received after the page opened, even on another kiosk.
        assert.ok(fleet.logs.every(row => row.kiosk_id === kiosk.id));
        const freshFleet = await repo.queryKioskLogs(parseLogFilters({until: new Date(Date.now() + 1000).toISOString()}));
        assert.ok(freshFleet.logs.some(row => row.kiosk_id === kiosk2.id));
        await repo.adapter.run("DELETE FROM kiosk_logs WHERE kiosk_id = ?", [kiosk2.id]);
        await repo.adapter.run("UPDATE kiosk_logs SET received_at = now() - interval '25 hours' WHERE event_id = ?", [log.event_id]);
        await repo.adapter.run("UPDATE kiosk_logs SET received_at = now() - interval '23 hours' WHERE event_id = ?", ["app:0:0"]);
      });
    }
    assert.equal(await purgeTenantKioskLogs(repo, 24, message => assert.fail(message)), 2);
    for (const schema of ["public", tenant.schema_name]) {
      await repo.adapter.withSearchPath(schema, async () => {
        assert.equal((await repo.adapter.get<{count: string}>("SELECT count(*) FROM kiosk_logs"))?.count, "601");
        assert.equal((await repo.adapter.get<{count: string}>("SELECT count(*) FROM kiosk_logs WHERE event_id = ?", ["app:0:0"]))?.count, "1");
      });
    }
    assert.equal(await purgeTenantKioskLogs(repo, 12, message => assert.fail(message)), 2, "custom retention is honored");
  } finally {
    await close?.();
    await admin.exec(`DROP DATABASE "${dbName}" WITH (FORCE)`);
    await admin.close();
  }
});
