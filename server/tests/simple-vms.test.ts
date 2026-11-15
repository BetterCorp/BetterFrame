import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { PgAdapter } from "../src/shared/db/pg-adapter.js";
import { initDb, createTenantSchema } from "../src/shared/db/init.js";
import { saveSimpleVmsSource, applySimpleVmsSnapshot, simpleVmsCamerasForKiosk, simpleVmsTokenMatches } from "../src/shared/simple-vms.js";
import { simpleVmsAddress, validateSimpleVmsSnapshot, type VmsSnapshot } from "../src/shared/simple-vms-schema.js";
import { generateBundle } from "../src/shared/bundle.js";
import { initSecrets } from "../src/shared/secrets.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { H3 } from "h3";
import { registerSimpleVmsIngress } from "../src/shared/simple-vms-http.js";

function snapshot(revision = 1): VmsSnapshot {
  return { version: 1, instanceId: "recorder-one", revision, name: "Property NVR", cameras: [
    { id: "entrance", name: "Entrance", enabled: true, profiles: [{ id: "Profile_001", name: "High", role: "main", codec: "h264", width: 1920, height: 1080, fps: 25 }] },
    { id: "yard", name: "Yard", enabled: true, profiles: [] },
  ], groups: [{ id: "outside", name: "Outside", cameraIds: ["entrance", "yard"] }] };
}

test("SimpleVMS rejects malformed catalogs and unusable linked-kiosk addresses", () => {
  const s = snapshot();
  assert.deepEqual(validateSimpleVmsSnapshot(s), s);
  assert.throws(() => validateSimpleVmsSnapshot({ ...s, cameras: [...s.cameras, s.cameras[0]] }));
  assert.throws(() => validateSimpleVmsSnapshot({ ...s, groups: [{ id: "bad", name: "Bad", cameraIds: ["missing"] }] }));
  assert.throws(() => validateSimpleVmsSnapshot({ ...s, revision: 0 }));
  for (const address of ["rtsp://localhost:8554", "rtsp://127.0.0.1:8554", "rtsp://[::1]:8554", "http://nvr:8080", "rtsp://user:secret@nvr:8554", "rtsp://nvr:8554/path"]) assert.throws(() => simpleVmsAddress(address, true));
  assert.equal(simpleVmsAddress("rtsp://nvr.property.lan:8554", true), "rtsp://nvr.property.lan:8554");
});

const pgUrl = process.env["BF_TEST_PG_URL"];
test("SimpleVMS sync: idempotency, ownership, deletions, kiosk routing, rollback and tenant isolation", { skip: !pgUrl }, async () => {
  const admin = new PgAdapter(pgUrl!);
  const name = `bf_svms_${randomBytes(8).toString("hex")}`;
  await admin.exec(`CREATE DATABASE "${name}"`);
  const url = new URL(pgUrl!); url.pathname = `/${name}`;
  const data = await mkdtemp(join(tmpdir(), "bf-simplevms-"));
  const log = { info() {}, warn() {} };
  let db: Awaited<ReturnType<typeof initDb>> | undefined;
  try {
    db = await initDb({ url: url.toString(), host: "", port: 5432, user: "", password: "", database: name, poolMax: 8 }, log);
    const { repo } = db;
    const secrets = await initSecrets({ dataDir: data }, log);
    const owner = await repo.createKiosk({ name: "Recorder kiosk", key_hash: "owner", key_prefix: "owner" });
    const linked = await repo.createKiosk({ name: "Gate kiosk", key_hash: "linked", key_prefix: "linked" });
    const other = await repo.createKiosk({ name: "Other kiosk", key_hash: "other", key_prefix: "other" });
    const android = await repo.createKiosk({ name: "Property TV", key_hash: "android", key_prefix: "android", capabilities: ["android-viewer"] });
    await repo.updateKiosk(android.id, { encrypt_key_encrypted: secrets.encryptString(secrets.generateClusterKey(), "kiosk-encrypt") });
    const display = await repo.createDisplayForKiosk(owner.id, { name: "Owner display" });
    const linkedDisplay = await repo.createDisplayForKiosk(linked.id, { name: "Linked display" });
    const otherDisplay = await repo.createDisplayForKiosk(other.id, { name: "Other display" });
    const androidDisplay = await repo.createDisplayForKiosk(android.id, { name: "TV display" });
    const config = { instanceId: "recorder-one", name: "Property NVR", localAddress: "rtsp://127.0.0.1:8554", externalAddress: "rtsp://nvr.property.lan:8554",
      linkedKioskIds: [linked.id, android.id], enabled: true, autoSync: true, viewerUsername: "betterframe", viewerPassword: "test-viewer-password", ingestToken: "test-integration-token-01234567890123456789" };
    const source = await saveSimpleVmsSource(repo, secrets, owner.id, config);
    const app = new H3(); registerSimpleVmsIngress(app, repo);
    const headers = { authorization: `Bearer ${config.ingestToken}`, "content-type": "application/json" };
    const callback = `http://bf.test/api/simplevms/default/${source.id}`;
    assert.equal((await app.request(`${callback}/events`, { method: "POST", body: JSON.stringify(snapshot()) })).status, 401);
    const initial = snapshot(); initial.groups[0]!.cameraIds = ["entrance"];
    assert.equal((await app.request(`${callback}/events`, { method: "POST", headers, body: JSON.stringify(initial) })).status, 200);
    assert.deepEqual(await (await app.request(`${callback}/access?kioskId=${linked.id}`, { headers })).json(), { allowed: true });
    assert.deepEqual(await (await app.request(`${callback}/access?kioskId=${other.id}`, { headers })).json(), { allowed: false });
    assert.deepEqual(await (await app.request(`${callback}/access?kioskId=${android.id}&cameraId=entrance`, { headers })).json(), { allowed: true });
    assert.deepEqual(await (await app.request(`${callback}/access?kioskId=${android.id}&cameraId=yard`, { headers })).json(), { allowed: false });
    assert.deepEqual(await (await app.request(`${callback}/access?kioskId=${owner.id}&cameraId=yard`, { headers })).json(), { allowed: true });
    const viewerBundle = await generateBundle(repo, secrets, android.id, undefined);
    assert.equal(viewerBundle!.cameras.length, 1);
    assert.equal(viewerBundle!.cameras[0]!.name, "Entrance");
    assert.ok(viewerBundle!.cameras[0]!.playback_username?.endsWith(`${android.id}/entrance`));
    assert.equal((await repo.listLayoutsForDisplay(androidDisplay.id)).length, 1);
    assert.ok(simpleVmsTokenMatches(source, config.ingestToken)); assert.ok(!simpleVmsTokenMatches(source, "wrong"));
    assert.deepEqual(await applySimpleVmsSnapshot(repo, source.id, snapshot()), { revision: 1, applied: false });
    const cameras = await repo.listCamerasByDevice(source.device_id); assert.equal(cameras.length, 2);
    const camera = cameras.find(c => c.name === "Entrance")!;
    const managedLayout = (await repo.listLayouts())[0]!;
    assert.equal((await repo.listLayoutsForDisplay(display.id)).length, 1);
    assert.equal((await repo.listLayoutsForDisplay(linkedDisplay.id)).length, 1);
    assert.equal((await repo.listLayoutsForDisplay(otherDisplay.id)).length, 0);
    await assert.rejects(repo.attachLayoutToDisplay(otherDisplay.id, managedLayout.id));
    await assert.rejects(repo.updateCamera(camera.id, { name: "forbidden" }));
    await assert.rejects(repo.deleteCamera(camera.id));
    await assert.rejects(repo.updateLayout(managedLayout.id, { name: "forbidden" }));
    await assert.rejects(repo.deleteLayout(managedLayout.id));
    const cell = (await repo.listLayoutCells(managedLayout.id))[0]!;
    await assert.rejects(repo.updateLayoutCell(cell.id, { row: 7 }));
    await assert.rejects(repo.assignCellEntity(cell.id, null));
    assert.deepEqual(await applySimpleVmsSnapshot(repo, source.id, snapshot()), { revision: 1, applied: false });
    const updated = snapshot(2); updated.cameras[0]!.name = "Front entrance";
    await applySimpleVmsSnapshot(repo, source.id, updated);
    assert.equal((await repo.getCameraById(camera.id))?.name, "Front entrance");
    assert.equal((await repo.getEntityForCamera(camera.id))?.name, "Front entrance");
    assert.equal((await repo.listLayouts())[0]?.id, managedLayout.id);
    assert.deepEqual(await applySimpleVmsSnapshot(repo, source.id, snapshot()), { revision: 2, applied: false });
    assert.equal((await simpleVmsCamerasForKiosk(repo, owner.id)).length, 2);
    assert.equal((await simpleVmsCamerasForKiosk(repo, linked.id)).length, 2);
    assert.equal((await simpleVmsCamerasForKiosk(repo, other.id)).length, 0);
    const ownBundle = await generateBundle(repo, secrets, owner.id, secrets.generateClusterKey());
    const linkedBundle = await generateBundle(repo, secrets, linked.id, secrets.generateClusterKey());
    assert.match(ownBundle!.cameras.find(c => c.id === camera.id)!.streams[0]!.rtsp_uri, /^rtsp:\/\/127\.0\.0\.1:8554\/bf\/entrance\/Profile_001$/);
    assert.match(linkedBundle!.cameras.find(c => c.id === camera.id)!.streams[0]!.rtsp_uri, /^rtsp:\/\/nvr\.property\.lan:8554\//);
    assert.ok(!JSON.stringify(ownBundle).includes(config.viewerPassword));
    const custom = await repo.createLayout({ name: "My layout" });
    await repo.createLayoutCell({ layout_id: custom.id, row: 0, col: 0, camera_id: camera.id, content_type: "camera" });
    await saveSimpleVmsSource(repo, secrets, owner.id, { ...config, linkedKioskIds: [], viewerPassword: "", ingestToken: "" });
    assert.deepEqual(await (await app.request(`${callback}/access?kioskId=${linked.id}`, { headers })).json(), { allowed: false });
    assert.equal((await repo.listLayoutsForDisplay(linkedDisplay.id)).length, 0);
    assert.equal((await simpleVmsCamerasForKiosk(repo, linked.id)).length, 0);
    const empty = snapshot(3); empty.cameras = []; empty.groups = [];
    await applySimpleVmsSnapshot(repo, source.id, empty);
    assert.equal(await repo.getLayoutById(managedLayout.id), null);
    assert.ok(await repo.getLayoutById(custom.id));
    assert.equal((await repo.listLayoutCells(custom.id)).length, 0);
    await assert.rejects(applySimpleVmsSnapshot(repo, source.id, { ...snapshot(4), instanceId: "wrong-instance" }));
    assert.equal((await repo.listCamerasByDevice(source.device_id)).length, 0);
    // An injected mid-sync failure must roll back the whole catalog and revision.
    const original = repo.createCameraStream.bind(repo); repo.createCameraStream = async () => { throw Error("injected"); };
    await assert.rejects(applySimpleVmsSnapshot(repo, source.id, snapshot(4))); repo.createCameraStream = original;
    assert.equal((await repo.listCamerasByDevice(source.device_id)).length, 0);
    assert.equal((await applySimpleVmsSnapshot(repo, source.id, snapshot(4))).revision, 4);
    const tenant = await repo.createTenant({ name: "Other tenant", slug: "other-tenant" });
    await createTenantSchema(repo.adapter, tenant.slug, log);
    await repo.adapter.withSearchPath(tenant.schema_name, async () => {
      await assert.rejects(applySimpleVmsSnapshot(repo, source.id, snapshot(5)));
      await assert.rejects(saveSimpleVmsSource(repo, secrets, owner.id, config));
      assert.equal((await repo.listCameras()).length, 0);
    });
  } finally {
    await db?.close(); await admin.exec(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.close(); await rm(data, { recursive: true, force: true });
  }
});
