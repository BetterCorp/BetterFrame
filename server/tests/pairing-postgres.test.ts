import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { PgAdapter } from "../src/shared/db/pg-adapter.js";
import { initDb, createTenantSchema } from "../src/shared/db/init.js";
import { Repository } from "../src/shared/db/repository.js";
import { initiatePairing, confirmPairing, claimPairing, acknowledgePairing } from "../src/shared/pairing.js";
import { claimIoBox, acknowledgeIoBox } from "../src/shared/iobox-pairing.js";
import { tenantSchemaName, legacyTenantSchemaName, storedPostgresIdentifier } from "../src/shared/db/tenant-schema.js";

const url = process.env["BF_TEST_PG_URL"];
const log = { info() {}, warn() {} };
const secrets = { encryptString: (value: string) => `encrypted:${value}`, decryptString: (value: string) => {
  if (!value.startsWith("encrypted:")) throw Error("wrong key");
  return value.slice(10);
} };
const auth = { hashPassword: async (password: string) => `hash:${password}` };

test("PostgreSQL migrations, tenant transactions and concurrent credential delivery", { skip: !url }, async () => {
  // A fresh throwaway database prevents touching the supplied database's tables.
  const admin = new PgAdapter(url!);
  const dbName = `bf_test_${randomBytes(8).toString("hex")}`;
  await admin.exec(`CREATE DATABASE "${dbName}"`);
  const testUrl = new URL(url!); testUrl.pathname = `/${dbName}`;
  const config = { url: testUrl.toString(), host: "", port: 5432, user: "", password: "", database: dbName, poolMax: 6 };
  const handles: Array<Awaited<ReturnType<typeof initDb>>> = [];
  try {
    const open = async () => { const handle = await initDb(config, log); handles.push(handle); return handle; };
    const opened = await Promise.allSettled([open(), open()]);
    for (const result of opened) if (result.status === "rejected") throw result.reason;
    const { repo } = handles[0]!;
    const second = handles[1]!;
    const notifications: string[] = [];
    const notifyingRepo = new Repository(repo.adapter, async (table) => { notifications.push(table); });
    const tenant = await repo.transact(async () => {
      const t = await repo.createTenant({ name: "Branch one", slug: "branch-one" });
      await createTenantSchema(repo.adapter, t.slug, log);
      return t;
    });
    assert.equal(tenant.schema_name, tenantSchemaName("branch-one"));
    assert.notEqual(tenantSchemaName("branch-one"), tenantSchemaName("branch_one"));
    const publicCount = await repo.adapter.get<{ count: string }>("SELECT count(*) FROM public.kiosks");
    await assert.rejects(repo.transact(async () => {
      await repo.createTenant({ name: "Rollback", slug: "rollback-tenant" });
      await createTenantSchema(repo.adapter, "rollback-tenant", log);
      throw Error("injected provisioning failure");
    }));
    assert.equal(await repo.getTenantBySlug("rollback-tenant"), null);
    assert.equal(await repo.adapter.get("SELECT 1 FROM pg_namespace WHERE nspname = ?", [tenantSchemaName("rollback-tenant")]), undefined);
    const start = await initiatePairing(repo, { proposedName: "Lobby", hardwareModel: null, capabilities: [], codeTtlSeconds: 600, secureClaim: true });
    const input = { code: start.code, tenant: { id: tenant.id, slug: tenant.slug, schemaName: tenant.schema_name } };
    const confirm = (r: Repository) => r.adapter.withSearchPath(tenant.schema_name, () => confirmPairing(r, auth as never, secrets as never, input));
    const results = await Promise.all([confirm(repo), confirm(second.repo)]);
    assert.deepEqual(results[0], results[1]);
    assert.equal((await repo.adapter.get<{ count: string }>(`SELECT count(*) FROM "${tenant.schema_name}".kiosks`))?.count, "1");
    assert.equal((await repo.adapter.get<{ count: string }>("SELECT count(*) FROM public.kiosks"))?.count, publicCount?.count);
    assert.equal((await claimPairing(repo, start.code, secrets as never)).status, "failed");
    const delivered = await claimPairing(repo, start.code, secrets as never, undefined, start.pollingSecret);
    const retry = await claimPairing(second.repo, start.code, secrets as never, undefined, start.pollingSecret);
    assert.equal(delivered.kioskKey, retry.kioskKey);
    await acknowledgePairing(repo, start.code, results[0]!.kioskId, tenant.schema_name, start.pollingSecret);
    await acknowledgePairing(repo, start.code, results[0]!.kioskId, tenant.schema_name, start.pollingSecret);
    assert.equal((await claimPairing(repo, start.code, secrets as never, undefined, start.pollingSecret)).status, "acknowledged");
    assert.equal((await repo.getPairingCode(start.code))?.extras["pairing_claim_encrypted"], undefined);

    // Heartbeats update capability arrays through this repository method. pg
    // otherwise encodes a JS array as a PostgreSQL array literal: populated
    // arrays fail JSONB parsing, while [] can silently become a JSON object.
    await repo.adapter.withSearchPath(tenant.schema_name, async () => {
      const kioskId = results[0]!.kioskId;
      const original = await repo.getKioskById(kioskId);
      assert.ok(original);
      assert.ok(original.key_hash);
      for (const capabilities of [["android-viewer", "touch", "html"], []]) {
        await repo.updateKiosk(kioskId, { capabilities });
        const saved = await repo.getKioskById(kioskId);
        assert.ok(saved);
        assert.deepEqual(saved.capabilities, capabilities);
        const stored = await repo.adapter.get<{ kind: string; capabilities: string[] }>(
          "SELECT jsonb_typeof(capabilities) AS kind, capabilities FROM kiosks WHERE id = ?",
          [kioskId],
        );
        assert.equal(stored?.kind, "array");
        assert.deepEqual(stored?.capabilities, capabilities);
        assert.equal(saved.key_hash, original.key_hash);
        assert.equal(saved.encrypt_key_encrypted, original.encrypt_key_encrypted);
        assert.equal(saved.name, original.name);
      }
    });

    // Every write before final claim consumption rolls back, including rekeys.
    for (const failure of ["display", "envelope"]) {
      notifications.length = 0;
      const next = await initiatePairing(repo, { proposedName: `Fail-${failure}`, hardwareModel: null, capabilities: [], codeTtlSeconds: 600 });
      const originalDisplay = notifyingRepo.createDisplayForKiosk.bind(notifyingRepo);
      if (failure === "display") notifyingRepo.createDisplayForKiosk = async () => { throw Error("injected display failure"); };
      const failureSecrets = failure === "envelope" ? { ...secrets, encryptString: (value: string, context: string) => { if (context === "pairing-claim") throw Error("injected envelope failure"); return secrets.encryptString(value); } } : secrets;
      await assert.rejects(repo.adapter.withSearchPath(tenant.schema_name, () => confirmPairing(notifyingRepo, auth as never, failureSecrets as never, { ...input, code: next.code })));
      notifyingRepo.createDisplayForKiosk = originalDisplay;
      assert.equal((await repo.getPairingCode(next.code))?.consumed_at, null);
      assert.equal((await repo.adapter.get<{ count: string }>(`SELECT count(*) FROM "${tenant.schema_name}".kiosks`))?.count, "1");
      assert.deepEqual(notifications, []);
    }
    const existing = await repo.adapter.withSearchPath(tenant.schema_name, () => repo.getKioskById(results[0]!.kioskId));
    const replacement = await initiatePairing(repo, { proposedName: "Replacement", hardwareModel: null, capabilities: [], codeTtlSeconds: 600 });
    const badSecrets = { ...secrets, encryptString: (value: string, context: string) => {
      if (context === "pairing-claim") throw Error("injected replacement failure");
      return secrets.encryptString(value);
    } };
    await assert.rejects(repo.adapter.withSearchPath(tenant.schema_name, () => confirmPairing(repo, auth as never, badSecrets as never, {
      ...input, code: replacement.code, replaceKioskId: results[0]!.kioskId,
    })));
    const unchanged = await repo.adapter.withSearchPath(tenant.schema_name, () => repo.getKioskById(results[0]!.kioskId));
    assert.equal(unchanged?.key_hash, existing?.key_hash);
    assert.equal(unchanged?.encrypt_key_encrypted, existing?.encrypt_key_encrypted);
    assert.equal((await repo.getPairingCode(replacement.code))?.consumed_at, null);

    const serial = "test-serial";
    await repo.registerIoBoxSerial({ serial, model_id: "ioBOX-WIFI" });
    const secret = randomBytes(32).toString("hex");
    const claimInput = { serial, provisioning_secret: secret };
    const ioTenant = { id: tenant.id, slug: tenant.slug, schema_name: tenant.schema_name };
    const ioResults = await Promise.all([claimIoBox(repo, auth as never, secrets as never, claimInput, ioTenant), claimIoBox(second.repo, auth as never, secrets as never, claimInput, ioTenant)]);
    assert.deepEqual(ioResults[0], ioResults[1]);
    await assert.rejects(claimIoBox(repo, auth as never, secrets as never, { serial }, ioTenant));
    await assert.rejects(claimIoBox(repo, auth as never, secrets as never, { serial, provisioning_secret: "wrong" }, ioTenant));
    await acknowledgeIoBox(repo, serial, String(ioResults[0]!["iobox_id"]), tenant.id, secret);
    await acknowledgeIoBox(repo, serial, String(ioResults[0]!["iobox_id"]), tenant.id, secret);
    await assert.rejects(claimIoBox(repo, auth as never, secrets as never, claimInput, ioTenant));
    // The old route committed a hyphenated registration before schema DDL failed.
    await repo.adapter.run("INSERT INTO public.tenants (name, slug, schema_name) VALUES (?, ?, ?)", ["Legacy broken", "legacy-broken", "tenant_legacy-broken"]);
    // Old CREATE SCHEMA and SET search_path silently truncated long names,
    // while tenant registration and migration records kept the full string.
    const legacySlug = "long" + "a".repeat(140);
    const legacySchema = `tenant_${legacySlug}`;
    const storedSchema = storedPostgresIdentifier(legacySchema);
    await repo.adapter.run("INSERT INTO public.tenants (name, slug, schema_name) VALUES (?, ?, ?)", ["Long legacy", legacySlug, legacySchema]);
    await createTenantSchema(repo.adapter, legacySlug, log, storedSchema);
    await repo.adapter.exec(`CREATE TABLE "${storedSchema}".preserved_marker (value TEXT NOT NULL)`);
    await repo.adapter.run(`INSERT INTO "${storedSchema}".preserved_marker (value) VALUES ('existing tenant data')`);
    await repo.adapter.run("UPDATE public.schema_migrations SET schema_name = ? WHERE schema_name = ?", [legacySchema, storedSchema]);
    const third = await initDb(config, log); handles.push(third);
    assert.ok(await third.repo.getTenantBySlug("branch-one"));
    assert.equal((await third.repo.getTenantBySlug("legacy-broken"))?.schema_name, tenantSchemaName("legacy-broken"));
    const repairedSchema = legacyTenantSchemaName(legacySlug);
    assert.equal((await third.repo.getTenantBySlug(legacySlug))?.schema_name, repairedSchema);
    assert.deepEqual(await repo.adapter.get(`SELECT value FROM "${repairedSchema}".preserved_marker`), { value: "existing tenant data" });
    assert.equal(await repo.adapter.get("SELECT 1 FROM pg_namespace WHERE nspname::text = ?", [storedSchema]), undefined);
    assert.equal(await repo.adapter.get("SELECT 1 FROM public.schema_migrations WHERE schema_name = ?", [legacySchema]), undefined);

    const collisionPrefix = "collision" + "z".repeat(60);
    const collisionOne = `tenant_${collisionPrefix}one`;
    const collisionTwo = `tenant_${collisionPrefix}two`;
    const collisionStored = storedPostgresIdentifier(collisionOne);
    await repo.adapter.exec(`CREATE SCHEMA "${collisionStored}"`);
    await repo.adapter.exec(`CREATE TABLE "${collisionStored}".preserved_marker (value TEXT NOT NULL)`);
    await repo.adapter.run(`INSERT INTO "${collisionStored}".preserved_marker (value) VALUES ('ambiguous data retained')`);
    for (const schema of [collisionOne, collisionTwo]) {
      await repo.adapter.run("INSERT INTO public.tenants (name, slug, schema_name) VALUES (?, ?, ?)", [schema, schema.slice(7), schema]);
    }
    await assert.rejects(initDb(config, log), /ambiguous legacy tenant schema/);
    assert.deepEqual(await repo.adapter.get(`SELECT value FROM "${collisionStored}".preserved_marker`), { value: "ambiguous data retained" });
    assert.equal((await repo.getTenantBySlug(collisionOne.slice(7)))?.schema_name, collisionOne);
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
    try {
      // An initialized or rejected adapter must not leave a live backend behind.
      const deadline = Date.now() + 2_000;
      let count = -1;
      do {
        const sessions = await admin.get<{ count: string }>("SELECT count(*) FROM pg_stat_activity WHERE datname = ?", [dbName]);
        count = Number(sessions?.count);
        if (count === 0) break;
        // PostgreSQL can finish backend bookkeeping just after TCP shutdown.
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      assert.equal(count, 0, "All test database connections must be closed before cleanup");
    } finally {
      try { await admin.exec(`DROP DATABASE "${dbName}" WITH (FORCE)`); }
      finally { await admin.close(); }
    }
  }
});
