import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { TENANT_MIGRATIONS } from "../src/shared/db/migrations-pg.js";
import { KioskLocalPanel } from "../src/web-templates/admin-pages.js";
import { rowToCamera, rowToLayout } from "../src/shared/db/mappers.js";
import type { Kiosk } from "../src/shared/types.js";

const kiosk = {
  id: "kiosk", local_key: "a".repeat(64), local_port: 18090,
  local_last_ip: "192.168.74.132",
} as Kiosk;

test("LAN panel renders assigned shortlinks within the 127-character field limit", () => {
  const html = String(KioskLocalPanel({ kiosk,
    layouts: [{ name: "Lobby", local_short_key: "abc123" }],
    cameras: [{ name: "Door", local_short_key: "def456" }],
  }));
  const links = [...html.matchAll(/http:\/\/192\.168\.74\.132:18090\/lsh\/[^<]+/g)].map(([link]) => link.replaceAll("&amp;", "&"));
  assert.equal(links.length, 4);
  for (const link of links) assert.ok(link.length <= 127, `${link.length} characters`);
  assert.ok(links.some(link => link.includes("/lsh/abc123?key=")));
  assert.ok(links.some(link => link.includes("/lsh/def456/s?key=")));
  assert.ok(links.some(link => link.includes("/lsh/def456/m?key=") && link.endsWith("&dir=left")));
  assert.ok(links.some(link => link.includes("/lsh/def456/p/1?key=")));
  assert.match(html, /Preset token 1 \(example\)/);
  // Smart keys are additive: retain every normal endpoint example.
  for (const endpoint of ["/local/layout/", "/local/info?", "/local/snapshot/", "/local/onvif/", "/proxy/admin/"]) {
    assert.ok(html.includes(endpoint), `normal endpoint ${endpoint} remains visible`);
  }
  for (const action of ["ptz/stop", "ptz/preset/", "ptz/move"]) assert.ok(html.includes(action));
});

test("LAN panel brackets IPv6 hosts and flags links exceeding the field limit", () => {
  const html = String(KioskLocalPanel({ kiosk: { ...kiosk, local_last_ip: "2001:0db8:1234:5678:9abc:def0:1234:5678" },
    layouts: [{ name: "Lobby", local_short_key: "abc123" }],
  }));
  assert.match(html, /http:\/\/\[2001:0db8:1234:5678:9abc:def0:1234:5678\]:18090\/lsh/);
  assert.match(html, /exceeds the endpoint field limit/);
});

test("PostgreSQL aliases backfill, persist, retry collisions and remain tenant scoped", { skip: !process.env["BF_TEST_PG_URL"] }, async () => {
  const pool = new pg.Pool({ connectionString: process.env["BF_TEST_PG_URL"] });
  const schema = `lsh_test_${randomBytes(8).toString("hex")}`;
  const client = await pool.connect();
  const start = TENANT_MIGRATIONS.findIndex(sql => sql.startsWith("CREATE TABLE local_short_keys"));
  assert.ok(start > 0);
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, pg_catalog`);
    await client.query("CREATE TABLE layouts(id TEXT PRIMARY KEY, name TEXT); CREATE TABLE cameras(id TEXT PRIMARY KEY, name TEXT)");
    await client.query("INSERT INTO layouts VALUES ('old-layout', 'Lobby'); INSERT INTO cameras VALUES ('old-camera', 'Door')");
    await client.query("CREATE SEQUENCE short_test_sequence START 3");
    await client.query(`CREATE FUNCTION gen_random_uuid() RETURNS uuid LANGUAGE sql VOLATILE AS $$
      SELECT (lpad(to_hex(nextval('short_test_sequence')), 6, '0') || '00-0000-4000-8000-000000000000')::uuid
    $$`);
    for (const sql of TENANT_MIGRATIONS.slice(start)) await client.query(sql);
    const original = (await client.query("SELECT * FROM layouts")).rows[0];
    assert.match(original.local_short_key, /^[0-9a-f]{6}$/);
    assert.equal(rowToLayout(original).local_short_key, original.local_short_key);
    const camera = (await client.query("SELECT * FROM cameras")).rows[0];
    assert.equal(rowToCamera(camera).local_short_key, camera.local_short_key);
    assert.notEqual(original.local_short_key, camera.local_short_key);
    await client.query("UPDATE layouts SET name='Renamed', local_short_key='ffffff'");
    assert.equal((await client.query("SELECT local_short_key FROM layouts")).rows[0].local_short_key, original.local_short_key);
    // Force the allocator to encounter an occupied key on its first attempt.
    await client.query("INSERT INTO local_short_keys VALUES ('000001', 'retired', 'retired')");
    await client.query("ALTER SEQUENCE short_test_sequence RESTART WITH 1");
    const created = (await client.query("INSERT INTO layouts(id,name) VALUES ('new-layout','New') RETURNING *")).rows[0];
    assert.equal(created.local_short_key, "000002");
    await client.query("DELETE FROM layouts WHERE id='new-layout'");
    assert.equal((await client.query("SELECT count(*)::int AS count FROM local_short_keys WHERE short_key='000002'")).rows[0].count, 1);
    // The trigger qualifies registry access even when invoked outside its schema.
    await client.query("SET search_path TO public");
    const inserts = await Promise.all(Array.from({ length: 30 }, (_, i) => pool.query(
      `INSERT INTO ${schema}.cameras(id,name) VALUES ($1,'Concurrent') RETURNING local_short_key`, [`camera-${i}`],
    )));
    assert.equal(new Set(inserts.map(result => result.rows[0].local_short_key)).size, 30);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${schema}.local_short_keys`)).rows[0].count, 34);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await pool.end();
  }
});
