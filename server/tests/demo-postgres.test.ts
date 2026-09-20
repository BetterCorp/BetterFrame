import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { PgAdapter } from "../src/shared/db/pg-adapter.js";
import { initDb } from "../src/shared/db/init.js";
import { prepareDemo, demoTenant, enrollDemo, cleanupDemo, demoAvailable, demoTenantHidden, visibleTenants } from "../src/shared/demo.js";
import { initiatePairing, confirmPairing, claimPairing } from "../src/shared/pairing.js";

const url = process.env["BF_TEST_PG_URL"];
const log = { info() {}, warn() {} };
const secrets = { encryptString: (v: string) => `encrypted:${v}`, decryptString: (v: string) => v.slice(10) };
const auth = { hashPassword: async (v: string) => `hash:${v}` };

test("demo enrollment, display defaults and bounded tenant-only cleanup", { skip: !url }, async () => {
  const admin = new PgAdapter(url!);
  const name = `bf_demo_${randomBytes(8).toString("hex")}`;
  await admin.exec(`CREATE DATABASE "${name}"`);
  const testUrl = new URL(url!); testUrl.pathname = `/${name}`;
  const opened = await initDb({ url: testUrl.toString(), host: "", port: 5432, user: "", password: "", database: name, poolMax: 6 }, log);
  const repo = opened.repo;
  const initiate = () => initiatePairing(repo, { proposedName: "Demo kiosk", hardwareModel: null, capabilities: [], codeTtlSeconds: 600, secureClaim: true });
  try {
    assert.equal(await prepareDemo(repo, false), null);
    assert.equal(await demoTenant(repo), null);
    const legacy = await repo.createTenant({ name: "Existing customer", slug: "demo" });
    assert.equal(await demoTenantHidden(repo, false, legacy), false);
    assert.ok((await visibleTenants(repo, false)).some(t => t.id === legacy.id));
    await assert.rejects(prepareDemo(repo, true), /already in use/);
    assert.equal(await demoAvailable(repo, true), false);
    await repo.deleteTenant(legacy.id);
    const [tenant, again] = await Promise.all([prepareDemo(repo, true), prepareDemo(repo, true)]);
    assert.ok(tenant); assert.equal(again?.id, tenant.id);
    assert.equal(await demoTenantHidden(repo, false, tenant), true);
    assert.equal(await demoTenantHidden(repo, true, tenant), false);
    assert.ok(!(await visibleTenants(repo, false)).some(t => t.id === tenant.id));
    assert.equal(await demoAvailable(repo, false), false);
    assert.equal(await demoAvailable(repo, true), true);
    await repo.updateTenant(tenant.id, { is_active: false });
    assert.equal(await demoAvailable(repo, true), false);
    const disabled = await initiate();
    await assert.rejects(enrollDemo(repo, auth as never, secrets as never, true, disabled.code, disabled.pollingSecret), /unavailable/);
    await repo.updateTenant(tenant.id, { is_active: true });
    assert.equal(await demoAvailable(repo, true), true);
    const settings = await repo.adapter.withSearchPath(tenant.schema_name, () => repo.getDisplayDefaults());
    assert.equal(settings.layoutIds.length, 1);
    assert.equal(settings.defaultLayoutId, settings.layoutIds[0]);
    await repo.adapter.withSearchPath(tenant.schema_name, async () => {
      await repo.updateLayout(settings.layoutIds[0]!, { name: "Operator edited" });
    });
    await prepareDemo(repo, true);
    assert.equal(await repo.adapter.withSearchPath(tenant.schema_name, async () => (await repo.listLayouts())[0]?.name), "Operator edited");

    const session = await initiate();
    const enroll = (enabled = true, secret = session.pollingSecret) => enrollDemo(repo, auth as never, secrets as never, enabled, session.code, secret);
    await assert.rejects(enroll(false), /unavailable/);
    await assert.rejects(enroll(true, "forged-secret"), /Invalid/);
    await repo.updateTenant(tenant.id, { max_kiosks: 1 });
    assert.equal(await demoAvailable(repo, true), true);
    await Promise.all([enroll(), enroll()]);
    assert.equal(await demoAvailable(repo, true), false);
    await enroll(); // A lost response can be retried even at capacity.
    const overflow = await initiate();
    await assert.rejects(enrollDemo(repo, auth as never, secrets as never, true, overflow.code, overflow.pollingSecret), /capacity/);
    await repo.updateTenant(tenant.id, { max_kiosks: null });
    assert.equal(await demoAvailable(repo, true), true);
    const claim = await claimPairing(repo, session.code, secrets as never, undefined, session.pollingSecret);
    assert.equal(claim.demo, true); assert.ok(claim.kioskId);
    assert.equal((await claimPairing(repo, session.code, secrets as never)).status, "failed");
    await assert.rejects(confirmPairing(repo, auth as never, secrets as never, { code: session.code }), /already used/);
    await repo.adapter.withSearchPath(tenant.schema_name, async () => {
      assert.equal((await repo.listKiosks()).length, 1);
      const display = (await repo.listDisplaysForKiosk(claim.kioskId!))[0]!;
      assert.equal(display.active_layout_id, settings.defaultLayoutId);
      assert.equal(display.default_layout_id, settings.defaultLayoutId);
      assert.equal((await repo.listLayoutsForDisplay(display.id)).length, 1);
      await repo.detachLayoutFromDisplay(display.id, settings.layoutIds[0]!);
      const later = await repo.createDisplayForKiosk(claim.kioskId!, { name: "Second display" });
      assert.equal((await repo.listLayoutsForDisplay(later.id)).length, 1);
      assert.equal((await repo.listLayoutsForDisplay(display.id)).length, 0); // No enforcement.
      await repo.setSetupExtra("display_defaults", { layoutIds: ["deleted-id"], defaultLayoutId: "deleted-id" });
      const third = await repo.createDisplayForKiosk(claim.kioskId!, { name: "Third display" });
      assert.equal(third.default_layout_id, null);
      await repo.setSetupExtra("display_defaults", settings);
    });

    // Ordinary tenants use exactly the same defaults and never enter demo cleanup.
    const ordinary = await initiate();
    const normal = await confirmPairing(repo, auth as never, secrets as never, { code: ordinary.code });
    const normalLayout = await repo.createLayout({ name: "Marketing" });
    await repo.setSetupExtra("display_defaults", { layoutIds: [normalLayout.id], defaultLayoutId: normalLayout.id });
    const normalDisplay = await repo.createDisplayForKiosk(normal.kioskId, { name: "Marketing display" });
    assert.equal(normalDisplay.default_layout_id, normalLayout.id);
    assert.equal((await claimPairing(repo, ordinary.code, secrets as never, undefined, ordinary.pollingSecret)).demo, false);
    await assert.rejects(enrollDemo(repo, auth as never, secrets as never, true, ordinary.code, ordinary.pollingSecret), /already used/);

    const now = new Date("2030-01-02T12:00:00.000Z");
    const stamp = async (id: string, age: number, idle: number | null) => repo.adapter.withSearchPath(tenant.schema_name, () =>
      repo.adapter.run("UPDATE kiosks SET paired_at = ?, last_seen_at = ? WHERE id = ?", [new Date(+now - age).toISOString(), idle == null ? null : new Date(+now - idle).toISOString(), id]));
    await stamp(claim.kioskId!, 299999, null);
    assert.equal(await cleanupDemo(repo, now), 0);
    await stamp(claim.kioskId!, 300000, null);
    await repo.updateTenant(tenant.id, { max_kiosks: 1 });
    assert.equal(await demoAvailable(repo, true), false);
    assert.equal(await cleanupDemo(repo, now), 1);
    assert.equal(await demoAvailable(repo, true), true);
    assert.equal((await claimPairing(repo, session.code, secrets as never, undefined, session.pollingSecret)).status, "revoked");
    assert.ok(await repo.getKioskById(normal.kioskId));
    await repo.adapter.withSearchPath(tenant.schema_name, async () => {
      assert.equal((await repo.listDisplays()).length, 0);
      assert.equal((await repo.listLayouts()).length, 1);
    });
    const active = await initiate();
    await enrollDemo(repo, auth as never, secrets as never, true, active.code, active.pollingSecret);
    const activeClaim = await claimPairing(repo, active.code, secrets as never, undefined, active.pollingSecret);
    await stamp(activeClaim.kioskId!, 86399999, 0);
    assert.equal(await cleanupDemo(repo, now), 0);
    await stamp(activeClaim.kioskId!, 86400000, 0);
    const counts = await Promise.all([cleanupDemo(repo, now), cleanupDemo(repo, now)]);
    assert.equal(counts.reduce((a, b) => a + b, 0), 1);
    assert.ok(await demoTenant(repo));
    await repo.deleteTenant(tenant.id);
    assert.equal(await demoAvailable(repo, true), false);
  } finally {
    await opened.close();
    await admin.exec(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.close();
  }
});
