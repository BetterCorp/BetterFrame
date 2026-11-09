import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { PgAdapter } from "../src/shared/db/pg-adapter.js";
import { initDb, createTenantSchema } from "../src/shared/db/init.js";
import { tenantSchemaName } from "../src/shared/db/tenant-schema.js";
import { TENANT_MIGRATIONS } from "../src/shared/db/migrations-pg.js";

const url = process.env["BF_TEST_PG_URL"];
test("entity auth persists and legacy migration promotes only agreeing block configurations", { skip: !url }, async () => {
  const admin = new PgAdapter(url!);
  const name = `bf_smart_url_${randomBytes(6).toString("hex")}`;
  await admin.exec(`CREATE DATABASE "${name}"`);
  const testUrl = new URL(url!); testUrl.pathname = `/${name}`;
  let close: (() => Promise<void>) | undefined;
  try {
    const opened = await initDb({ url: testUrl.toString(), host: "", port: 5432, user: "", password: "", database: name, poolMax: 3 }, { info() {}, warn() {} });
    close = opened.close;
    const { repo } = opened;
    const first = { login_detect_url: "/auth", steps: [{ type: "fill" as const, selector: "#user", value: "name" }] };
    const second = { ...first, login_detect_url: "/login" };
    const entity = await repo.createEntity({ name: "HA", type: "web", web_url: "http://ha/lovelace/2", smart_url_json: first });
    assert.deepEqual(entity.smart_url_json, first);
    await repo.updateEntity(entity.id, { smart_url_json: second });
    assert.deepEqual((await repo.getEntityById(entity.id))?.smart_url_json, second);
    await repo.updateEntity(entity.id, { smart_url_json: null });
    assert.equal((await repo.getEntityById(entity.id))?.smart_url_json, null);
    const conflicting = await repo.createEntity({ name: "Conflicting", type: "web", web_url: "http://ha/other" });
    const layout = await repo.createLayout({ name: "Layout" });
    for (const [index, config] of [first, first, first, second].entries()) {
      await repo.createLayoutCell({ layout_id: layout.id, row: 0, col: index, entity_id: index < 2 ? entity.id : conflicting.id, options: { smart_url: config, untouched: true } });
    }
    await repo.adapter.exec("ALTER TABLE entities DROP COLUMN smart_url_json");
    const authMigration = TENANT_MIGRATIONS.findIndex(sql => sql === "ALTER TABLE entities ADD COLUMN IF NOT EXISTS smart_url_json JSONB");
    assert.ok(authMigration >= 0);
    for (const sql of TENANT_MIGRATIONS.slice(authMigration, authMigration + 2)) await repo.adapter.exec(sql);
    assert.deepEqual((await repo.getEntityById(entity.id))?.smart_url_json, first);
    assert.equal((await repo.getEntityById(conflicting.id))?.smart_url_json, null);
    assert.equal((await repo.legacyEntitySmartUrls(conflicting.id)).length, 2);
    assert.ok((await repo.layoutCells(layout.id)).every((cell) => cell.options?.["untouched"] === true));
    await createTenantSchema(repo.adapter, "new-tenant", { info() {}, warn() {} });
    await repo.adapter.withSearchPath(tenantSchemaName("new-tenant"), async () => {
      const scoped = await repo.createEntity({ name: "Tenant HA", type: "web", web_url: "http://ha", smart_url_json: first });
      assert.deepEqual(scoped.smart_url_json, first, "new tenant schemas support entity authentication");
    });
  } finally {
    if (close) await close();
    try { await admin.exec(`DROP DATABASE "${name}" WITH (FORCE)`); }
    finally { await admin.close(); }
  }
});
