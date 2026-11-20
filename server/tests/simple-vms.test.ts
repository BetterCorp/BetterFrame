import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { PgAdapter } from "../src/shared/db/pg-adapter.js";
import { initDb, createTenantSchema } from "../src/shared/db/init.js";
import { TENANT_MIGRATIONS } from "../src/shared/db/migrations-pg.js";
import { saveSimpleVmsSource, removeSimpleVmsSource, applySimpleVmsSnapshot, simpleVmsCamerasForKiosk, simpleVmsTokenMatches, reconcileSimpleVmsAssignments } from "../src/shared/simple-vms.js";
import { simpleVmsAddress, validateSimpleVmsSnapshot, type VmsSnapshot } from "../src/shared/simple-vms-schema.js";
import { generateBundle } from "../src/shared/bundle.js";
import { initSecrets } from "../src/shared/secrets.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { H3 } from "h3";
import { registerSimpleVmsIngress } from "../src/shared/simple-vms-http.js";
import { registerSimpleVmsAdminRoutes } from "../src/plugins/service-admin-http/routes-simple-vms.js";
import { DisplayEditPage } from "../src/web-templates/admin-pages.js";
import { createServer } from "node:net";
import { startCameraHealthChecker } from "../src/shared/camera-health.js";

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
      localHttpAddress: "http://127.0.0.1:8555", externalHttpAddress: "https://nvr.property.lan:8555",
      linkedKioskIds: [linked.id, android.id], enabled: true, autoSync: true, viewerUsername: "betterframe", viewerPassword: "test-viewer-password", ingestToken: "test-integration-token-01234567890123456789" };
    const source = await saveSimpleVmsSource(repo, secrets, owner.id, config);
    const app = new H3(); registerSimpleVmsIngress(app, repo);
    const headers = { authorization: `Bearer ${config.ingestToken}`, "content-type": "application/json" };
    const callback = `http://bf.test/api/simplevms/default/${source.id}`;
    assert.equal((await app.request(`${callback}/events`, { method: "POST", body: JSON.stringify(snapshot()) })).status, 401);
    const initial = snapshot(); initial.groups[0]!.cameraIds = ["entrance"];
    const delivered = await app.request(`${callback}/events`, { method: "POST", headers, body: JSON.stringify(initial) });
    assert.equal(delivered.status, 200);
    const acknowledgement = await delivered.json() as { grants: Array<{ kioskId: string; cameraIds: string[] }> };
    assert.deepEqual(acknowledgement.grants.find(grant => grant.kioskId === android.id)?.cameraIds, ["entrance"]);
    assert.deepEqual(new Set(acknowledgement.grants.find(grant => grant.kioskId === owner.id)?.cameraIds), new Set(["entrance", "yard"]));
    assert.deepEqual(await (await app.request(`${callback}/access?kioskId=${linked.id}`, { headers })).json(), { allowed: true });
    assert.deepEqual(await (await app.request(`${callback}/access?kioskId=${other.id}`, { headers })).json(), { allowed: false });
    assert.deepEqual(await (await app.request(`${callback}/access?kioskId=${android.id}&cameraId=entrance`, { headers })).json(), { allowed: true });
    assert.deepEqual(await (await app.request(`${callback}/access?kioskId=${android.id}&cameraId=yard`, { headers })).json(), { allowed: false });
    assert.deepEqual(await (await app.request(`${callback}/access?kioskId=${owner.id}&cameraId=yard`, { headers })).json(), { allowed: true });
    const viewerBundle = await generateBundle(repo, secrets, android.id, undefined);
    assert.equal(viewerBundle!.cameras.length, 1);
    assert.equal(viewerBundle!.catalog_metadata!.groups.length, 1);
    assert.equal(viewerBundle!.catalog_metadata!.groups[0]!.origin.instance_id, "recorder-one");
    assert.equal(viewerBundle!.catalog_metadata!.groups[0]!.camera_ids.length, 1);
    assert.equal(viewerBundle!.catalog_metadata!.camera_origins[viewerBundle!.cameras[0]!.id]!.external_id, "entrance");
    assert.ok(!JSON.stringify(viewerBundle!.catalog_metadata).includes(config.viewerPassword));
    assert.ok(!JSON.stringify(viewerBundle!.catalog_metadata).includes(config.ingestToken));
    assert.equal(viewerBundle!.cameras[0]!.name, "Entrance");
    assert.deepEqual(viewerBundle!.layouts[0]!.cells.map(cell => cell.fit), ["contain"]);
    assert.ok(viewerBundle!.cameras[0]!.playback_username?.endsWith(`${android.id}/entrance`));
    assert.equal((await repo.listLayoutsForDisplay(androidDisplay.id)).length, 1);
    assert.ok(simpleVmsTokenMatches(source, config.ingestToken)); assert.ok(!simpleVmsTokenMatches(source, "wrong"));
    assert.deepEqual(await applySimpleVmsSnapshot(repo, source.id, snapshot()), { revision: 1, applied: false });
    const cameras = await repo.listCamerasByDevice(source.device_id); assert.equal(cameras.length, 2);
    const camera = cameras.find(c => c.name === "Entrance")!;
    const managedLayout = (await repo.listLayouts())[0]!;
    await repo.setSetupExtra("display_defaults", { layoutIds: [managedLayout.id], defaultLayoutId: managedLayout.id });
    assert.deepEqual(await repo.getDisplayDefaults(), { layoutIds: [], defaultLayoutId: null });
    const unrelatedDisplay = await repo.createDisplayForKiosk(other.id, { name: "Unlinked display" });
    assert.equal(unrelatedDisplay.default_layout_id, null);
    assert.deepEqual(await repo.listLayoutsForDisplay(unrelatedDisplay.id), []);
    await repo.setSetupExtra("display_defaults", { layoutIds: [], defaultLayoutId: null });
    assert.equal((await repo.listLayoutsForDisplay(display.id)).length, 1);
    assert.equal((await repo.listLayoutsForDisplay(linkedDisplay.id)).length, 1);
    assert.equal((await repo.listLayoutsForDisplay(otherDisplay.id)).length, 0);
    await assert.rejects(repo.attachLayoutToDisplay(otherDisplay.id, managedLayout.id));
    await assert.rejects(repo.updateCamera(camera.id, { name: "forbidden" }));
    await assert.rejects(repo.updateCamera(camera.id, { last_seen_at: new Date().toISOString() }));
    const probe = createServer(socket => socket.end());
    await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
    const endpoint = probe.address(); assert.ok(endpoint && typeof endpoint !== "string");
    const uri = `rtsp://127.0.0.1:${endpoint.port}/health`;
    const ordinary = await repo.createCamera({ name: "Health regression camera", type: "rtsp", rtsp_url: uri });
    let complete!: () => void;
    const checked = new Promise<void>(resolve => { complete = resolve; });
    let deadline: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(Error("Health cycle did not reach the second camera")), 5000); });
    const health = startCameraHealthChecker({
      listCameras: async () => [camera, ordinary], listCameraStreams: async () => [{ role: "main", rtsp_uri: uri }],
      touchCamera: async (id: string, at: string) => { await repo.touchCamera(id, at); if (id === ordinary.id) complete(); },
    } as never, { intervalMs: 60_000, timeoutMs: 100 }, log);
    try {
      await Promise.race([checked, timedOut]);
      assert.ok((await repo.getCameraById(camera.id))?.last_seen_at);
      assert.ok((await repo.getCameraById(ordinary.id))?.last_seen_at);
    } finally { clearTimeout(deadline!); health.stop(); await new Promise<void>(resolve => probe.close(() => resolve())); }
    await assert.rejects(repo.deleteCamera(camera.id));
    await assert.rejects(repo.updateLayout(managedLayout.id, { name: "forbidden" }));
    await assert.rejects(repo.deleteLayout(managedLayout.id));
    const cell = (await repo.listLayoutCells(managedLayout.id))[0]!;
    assert.equal(cell.fit, "contain");
    await assert.rejects(repo.updateLayoutCell(cell.id, { row: 7 }));
    await assert.rejects(repo.assignCellEntity(cell.id, null));
    assert.deepEqual(await applySimpleVmsSnapshot(repo, source.id, snapshot()), { revision: 1, applied: false });
    // A newer snapshot repairs an existing legacy cell as well as adding new cells.
    await repo.adapter.run("UPDATE layout_cells SET fit = 'cover' WHERE id = ?", [cell.id]);
    const updated = snapshot(2); updated.cameras[0]!.name = "Front entrance";
    await applySimpleVmsSnapshot(repo, source.id, updated);
    assert.equal((await repo.getCameraById(camera.id))?.name, "Front entrance");
    assert.equal((await repo.getEntityForCamera(camera.id))?.name, "Front entrance");
    assert.equal((await repo.listLayouts())[0]?.id, managedLayout.id);
    const syncedCells = await repo.listLayoutCells(managedLayout.id);
    assert.equal(syncedCells.find(current => current.camera_id === camera.id)?.id, cell.id);
    assert.deepEqual(syncedCells.map(current => current.fit), ["contain", "contain"]);
    assert.deepEqual(await applySimpleVmsSnapshot(repo, source.id, snapshot()), { revision: 2, applied: false });
    assert.equal((await simpleVmsCamerasForKiosk(repo, owner.id)).length, 2);
    assert.equal((await simpleVmsCamerasForKiosk(repo, linked.id)).length, 2);
    assert.equal((await simpleVmsCamerasForKiosk(repo, other.id)).length, 0);
    const ownBundle = await generateBundle(repo, secrets, owner.id, secrets.generateClusterKey());
    const linkedBundle = await generateBundle(repo, secrets, linked.id, secrets.generateClusterKey());
    assert.match(ownBundle!.cameras.find(c => c.id === camera.id)!.streams[0]!.rtsp_uri, /^rtsp:\/\/127\.0\.0\.1:8554\/bf\/entrance\/Profile_001$/);
    assert.match(linkedBundle!.cameras.find(c => c.id === camera.id)!.streams[0]!.rtsp_uri, /^rtsp:\/\/nvr\.property\.lan:8554\//);
    assert.ok(!JSON.stringify(ownBundle).includes(config.viewerPassword));
    assert.equal(ownBundle!.operator_console.simple_vms.enabled, true);
    assert.equal(linkedBundle!.operator_console.simple_vms.enabled, true, "Linked kiosks can use native recording export");
    assert.equal(viewerBundle!.operator_console.simple_vms.enabled, false);
    const custom = await repo.createLayout({ name: "My layout" });
    await repo.createLayoutCell({ layout_id: custom.id, row: 0, col: 0, camera_id: camera.id, content_type: "camera" });
    await repo.createLayoutCell({ layout_id: custom.id, row: 0, col: 1, entity_id: (await repo.getEntityForCamera(camera.id))!.id, fit: "fill" });
    await repo.updateLayout(custom.id, { preload_camera_ids: [camera.id] });
    await repo.attachLayoutToDisplay(linkedDisplay.id, custom.id);
    await repo.attachLayoutToDisplay(androidDisplay.id, custom.id);
    // Upgrade already-generated layouts without a new recorder event, preserving
    // custom fits even when those cells use the same imported camera/entity.
    await repo.adapter.run("UPDATE layout_cells SET fit = 'cover' WHERE layout_id = ?", [managedLayout.id]);
    const legacyBundle = (await generateBundle(repo, secrets, linked.id, undefined))!;
    const fitMigration = TENANT_MIGRATIONS.find(sql => sql.startsWith("UPDATE layout_cells SET fit = 'contain'"));
    assert.ok(fitMigration);
    await repo.adapter.exec(fitMigration);
    await repo.adapter.exec(fitMigration);
    const upgradedCells = await repo.listLayoutCells(managedLayout.id);
    assert.deepEqual(upgradedCells.map(current => current.id), syncedCells.map(current => current.id));
    assert.deepEqual(upgradedCells.map(current => current.fit), ["contain", "contain"]);
    assert.deepEqual((await repo.listLayoutCells(custom.id)).map(current => current.fit), ["cover", "fill"]);
    const upgradedBundle = (await generateBundle(repo, secrets, linked.id, undefined))!;
    assert.notEqual(upgradedBundle.version, legacyBundle.version);
    assert.deepEqual(upgradedBundle.layouts.find(layout => layout.id === managedLayout.id)!.cells.map(current => current.fit), ["contain", "contain"]);
    assert.equal((await generateBundle(repo, secrets, linked.id, undefined))!.layouts.find(layout => layout.id === custom.id)!.cells.length, 2);
    await repo.updateDisplay(linkedDisplay.id, { default_layout_id: managedLayout.id });
    await saveSimpleVmsSource(repo, secrets, owner.id, { ...config, linkedKioskIds: [], viewerPassword: "", ingestToken: "" });
    assert.deepEqual(await (await app.request(`${callback}/access?kioskId=${linked.id}`, { headers })).json(), { allowed: false });
    assert.equal((await repo.listLayoutsForDisplay(linkedDisplay.id)).length, 1);
    assert.equal((await simpleVmsCamerasForKiosk(repo, linked.id)).length, 0);
    for (const kioskId of [linked.id, android.id]) {
      const revokedBundle = (await generateBundle(repo, secrets, kioskId, undefined))!;
      assert.equal(revokedBundle.cameras.length, 0);
      assert.equal(revokedBundle.operator_console.simple_vms.enabled, false);
      assert.deepEqual(revokedBundle.layouts.find(layout => layout.id === custom.id)!.cells, []);
      assert.deepEqual(revokedBundle.layouts.find(layout => layout.id === custom.id)!.preload_camera_ids, []);
      assert.ok(!revokedBundle.layouts.some(layout => layout.id === (cell.entity_id ?? "missing")));
    }
    assert.equal((await repo.listLayoutCells(custom.id)).length, 2, "Kiosk access does not change the custom layout definition");
    assert.equal((await repo.getDisplayById(linkedDisplay.id))?.default_layout_id, null);
    await saveSimpleVmsSource(repo, secrets, owner.id, config);
    assert.equal((await repo.getDisplayById(linkedDisplay.id))?.default_layout_id, managedLayout.id, "Relinking restores the previous managed default");
    await repo.updateDisplay(display.id, { default_layout_id: managedLayout.id });
    await saveSimpleVmsSource(repo, secrets, owner.id, { ...config, enabled: false });
    assert.equal((await repo.getDisplayById(display.id))?.default_layout_id, null);
    await repo.updateDisplay(display.id, { name: "Owner display renamed", default_layout_id: null });
    assert.ok(await repo.adapter.get("SELECT 1 FROM simple_vms_display_defaults WHERE display_id = ?", [display.id]), "Saving an unchanged default retains automatic restoration");
    await repo.attachLayoutToDisplay(linkedDisplay.id, custom.id);
    await repo.updateDisplay(linkedDisplay.id, { default_layout_id: custom.id });
    // Re-enable after reconciliation enumerates the disabled source but before its transaction begins.
    const transact = repo.transact.bind(repo); let reenabled = false;
    repo.transact = async <T>(work: () => Promise<T>): Promise<T> => {
      if (!reenabled) { reenabled = true; await saveSimpleVmsSource(repo, secrets, owner.id, config); }
      return transact(work);
    };
    try { await reconcileSimpleVmsAssignments(repo, source.id); } finally { repo.transact = transact; }
    assert.equal((await repo.getDisplayById(display.id))?.default_layout_id, managedLayout.id, "Re-enabling restores the previous managed default");
    assert.equal((await repo.getDisplayById(linkedDisplay.id))?.default_layout_id, custom.id, "A different default chosen during disconnection takes precedence");
    await saveSimpleVmsSource(repo, secrets, owner.id, { ...config, enabled: false });
    await repo.attachLayoutToDisplay(display.id, custom.id);
    await repo.updateDisplay(display.id, { default_layout_id: custom.id });
    await repo.updateDisplay(display.id, { default_layout_id: null });
    assert.equal(await repo.adapter.get("SELECT 1 FROM simple_vms_display_defaults WHERE display_id = ?", [display.id]), undefined);
    await saveSimpleVmsSource(repo, secrets, owner.id, config);
    assert.equal((await repo.getDisplayById(display.id))?.default_layout_id, null, "A changed selection ending in no default must not be restored");
    await repo.updateDisplay(display.id, { default_layout_id: managedLayout.id });
    await saveSimpleVmsSource(repo, secrets, owner.id, { ...config, enabled: false });
    const disconnected = (await repo.getDisplayById(display.id))!;
    assert.equal(disconnected.default_layout_id, null);
    const page = String(DisplayEditPage({ user: "admin", display: disconnected, attachedLayouts: [], availableLayouts: [], hasDisconnectedSimpleVmsDefault: true }));
    assert.match(page, /Keep no default/);
    assert.ok(page.includes(`/admin/displays/${display.id}/clear-default`));
    await repo.clearDisplayDefault(display.id);
    assert.equal(await repo.adapter.get("SELECT 1 FROM simple_vms_display_defaults WHERE display_id = ?", [display.id]), undefined);
    await saveSimpleVmsSource(repo, secrets, owner.id, config);
    assert.equal((await repo.getDisplayById(display.id))?.default_layout_id, null, "Explicit clear cancels restoration even while the default is already NULL");
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

    // Localhost belongs to each kiosk: another recorder can use the same local media endpoint.
    const second = await saveSimpleVmsSource(repo, secrets, other.id, { ...config, instanceId: "recorder-two", name: "Second NVR", linkedKioskIds: [linked.id] });
    const secondCatalog = { ...snapshot(), instanceId: "recorder-two", name: "Second NVR" };
    const reservedBase = await repo.createLayout({ name: "Second NVR / Outside" });
    const reservedSuffix = await repo.createLayout({ name: `Second NVR / Outside (${second.id}-outside)` });
    await applySimpleVmsSnapshot(repo, second.id, secondCatalog);
    assert.equal((await repo.listCamerasByDevice(second.device_id)).length, 2);
    const secondEntrance = (await repo.listCamerasByDevice(second.device_id)).find(camera => camera.device_channel_id === "entrance")!;
    assert.equal(secondEntrance.name, "Second NVR / Entrance");
    const secondLayout = (await repo.listLayouts()).find(layout => layout.simple_vms_source_id === second.id)!;
    assert.equal(secondLayout.name, `Second NVR / Outside (${second.id}-outside) (2)`);
    assert.ok(await repo.getLayoutById(reservedBase.id)); assert.ok(await repo.getLayoutById(reservedSuffix.id));
    const entranceCell = (await repo.listLayoutCells(secondLayout.id)).find(cell => cell.camera_id === secondEntrance.id)!;
    const mapping = await repo.createIoBoxMapping({ display_id: otherDisplay.id, layout_id: secondLayout.id, cell_id: entranceCell.id,
      source_kind: "button", target_kind: "cell", action: "fullscreen" });
    await applySimpleVmsSnapshot(repo, second.id, { ...secondCatalog, revision: 2,
      groups: secondCatalog.groups.map(group => ({ ...group, cameraIds: [...group.cameraIds].reverse() })),
      cameras: secondCatalog.cameras.map(camera => ({ ...camera, name: camera.id === "entrance" ? "Yard" : "Entrance" })) });
    assert.equal((await repo.getCameraById(secondEntrance.id))?.name, "Second NVR / Yard");
    assert.equal((await repo.getEntityForCamera(secondEntrance.id))?.name, "Second NVR / Yard");
    const reordered = (await repo.listLayoutCells(secondLayout.id)).find(cell => cell.id === entranceCell.id)!;
    assert.equal(reordered.col, 1);
    assert.ok((await repo.listIoBoxMappingsForDisplay(otherDisplay.id)).some(item => item.id === mapping.id && item.cell_id === entranceCell.id));
    const onvif = await repo.createCameraDevice({ name: "Local ONVIF device", host: "127.0.0.1", port: 8554 });
    assert.equal((await repo.getCameraDeviceByEndpoint("127.0.0.1", 8554))?.id, onvif.id);
    await assert.rejects(repo.createCameraDevice({ name: "Duplicate ONVIF device", host: "127.0.0.1", port: 8554 }));
    await repo.updateDisplay(otherDisplay.id, { default_layout_id: secondLayout.id });
    const customSecond = await repo.createLayout({ name: "Custom second recorder view" });
    const secondCamera = (await repo.listCamerasByDevice(second.device_id))[0]!;
    await repo.createLayoutCell({ layout_id: customSecond.id, row: 0, col: 0, camera_id: secondCamera.id, content_type: "camera" });

    const deleteCamera = repo.deleteCamera.bind(repo);
    repo.deleteCamera = async () => { throw Error("injected cleanup failure"); };
    await assert.rejects(removeSimpleVmsSource(repo, second.id)); repo.deleteCamera = deleteCamera;
    assert.ok(await repo.getLayoutById(secondLayout.id));
    assert.equal((await repo.listCamerasByDevice(second.device_id)).length, 2);
    assert.equal((await repo.getDisplayById(otherDisplay.id))?.default_layout_id, secondLayout.id);

    registerSimpleVmsAdminRoutes(app, { repo, secrets } as never);
    assert.equal((await app.request(`http://bf.test/admin/kiosks/${other.id}/simple-vms/remove`, { method: "POST" })).status, 303);
    assert.equal(await repo.getCameraDeviceById(second.device_id), null);
    assert.equal(await repo.getLayoutById(secondLayout.id), null);
    assert.ok(await repo.getLayoutById(customSecond.id));
    assert.equal((await repo.listLayoutCells(customSecond.id)).length, 0);
    assert.equal((await repo.getDisplayById(otherDisplay.id))?.default_layout_id, null);
    assert.equal((await repo.getKioskById(other.id))?.simple_vms_enabled, false);
    assert.equal((await repo.listCamerasByDevice(source.device_id)).length, 2);

    // An incorrect immutable instance ID can be corrected after removing its connection.
    const corrected = await saveSimpleVmsSource(repo, secrets, other.id, { ...config, instanceId: "corrected-instance", linkedKioskIds: [linked.id] });
    await applySimpleVmsSnapshot(repo, corrected.id, { ...snapshot(), instanceId: "corrected-instance", name: "Corrected NVR" });
    assert.deepEqual(await repo.deleteKiosk(other.id), [linked.id]);
    assert.equal(await repo.getKioskById(other.id), null);
    assert.equal(await repo.getCameraDeviceById(corrected.device_id), null);
    assert.equal(await repo.adapter.get("SELECT 1 FROM simple_vms_sources WHERE owner_kiosk_id = ?", [other.id]), undefined);
    const orderingKiosk = await repo.createKiosk({ name: "Catalog ordering kiosk", key_hash: "ordering", key_prefix: "ordering" });
    await repo.createDisplayForKiosk(orderingKiosk.id, { name: "Ungrouped catalog display" });
    const orderingSource = await saveSimpleVmsSource(repo, secrets, orderingKiosk.id, { ...config, instanceId: "ordering-instance", name: "Ordering NVR", linkedKioskIds: [] });
    await applySimpleVmsSnapshot(repo, orderingSource.id, { ...snapshot(), instanceId: "ordering-instance", name: "Ordering NVR", groups: [] });
    const all = repo.adapter.all.bind(repo.adapter); let reverseCatalog = false;
    repo.adapter.all = (async (sql: string, params: Parameters<typeof all>[1]) => {
      const rows = await all(sql, params);
      return reverseCatalog && sql.includes("FROM simple_vms_cameras c JOIN simple_vms_sources") ? [...rows].reverse() : rows;
    }) as typeof repo.adapter.all;
    try {
      const key = secrets.generateClusterKey();
      const first = (await generateBundle(repo, secrets, orderingKiosk.id, key))!;
      reverseCatalog = true;
      const reversed = (await generateBundle(repo, secrets, orderingKiosk.id, key))!;
      assert.equal(first.cameras.length, 2);
      assert.deepEqual(reversed.cameras.map(camera => camera.id), first.cameras.map(camera => camera.id));
      assert.equal(reversed.version, first.version, "Query order must not change an ungrouped camera catalog's bundle hash");
    } finally { repo.adapter.all = all; }
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
