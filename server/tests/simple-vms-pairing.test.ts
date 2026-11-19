import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { H3 } from "h3";
import { initDb, createTenantSchema } from "../src/shared/db/init.js";
import { PgAdapter } from "../src/shared/db/pg-adapter.js";
import { TENANT_MIGRATIONS } from "../src/shared/db/migrations-pg.js";
import { initSecrets } from "../src/shared/secrets.js";
import { approveSimpleVmsPairing, claimSimpleVmsPairing, validateSimpleVmsPairRequest, simpleVmsPairReturn, packSimpleVmsPairReturn, unpackSimpleVmsPairReturn, type SimpleVmsPairGrant, type SimpleVmsPairRequest } from "../src/shared/simple-vms-pairing.js";
import { applySimpleVmsSnapshot, listSimpleVmsSources, linkSimpleVmsKiosk, getSimpleVmsSource, saveSimpleVmsSource, simpleVmsTokenMatches, simpleVmsCamerasForKiosk } from "../src/shared/simple-vms.js";
import { generateBundle } from "../src/shared/bundle.js";
import { registerSimpleVmsIngress } from "../src/shared/simple-vms-http.js";
import { registerSimpleVmsAdminRoutes } from "../src/plugins/service-admin-http/routes-simple-vms.js";
import { operatorMayAccess, registerMiddleware } from "../src/plugins/service-admin-http/middleware.js";
import { registerAuthRoutes } from "../src/plugins/service-admin-http/routes-auth.js";
import { createAuth } from "../src/shared/auth.js";
import { SimpleVmsKioskCard } from "../src/web-templates/simple-vms-pages.js";

const proof = () => randomBytes(32).toString("base64url");
function request(instance = "region-one") {
  const verifier = proof();
  const input: SimpleVmsPairRequest = { instance_id: instance, name: "Region one & two %2F", redirect_uri: "https://recorder.test/betterframe-pairing-return",
    state: proof(), challenge: createHash("sha256").update(verifier).digest("base64url"), local_address: "rtsp://127.0.0.1:8554",
    external_address: "rtsp://recorder.test:8554", local_http_address: "http://127.0.0.1:8555", external_http_address: "https://recorder.test:8555" };
  return { input, verifier };
}
const log = { info() {}, warn() {} };
const pgUrl = process.env.BF_TEST_PG_URL;
async function database(run: (repo: Awaited<ReturnType<typeof initDb>>["repo"], secrets: ReturnType<typeof initSecrets>) => Promise<void>) {
  const admin = new PgAdapter(pgUrl!); const name = `bf_pair_${randomBytes(8).toString("hex")}`;
  await admin.exec(`CREATE DATABASE "${name}"`); const url = new URL(pgUrl!); url.pathname = `/${name}`;
  const data = await mkdtemp(join(tmpdir(), "bf-svms-pair-")); let db: Awaited<ReturnType<typeof initDb>> | undefined;
  try { db = await initDb({ url: url.href, host: "", port: 5432, user: "", password: "", database: name, poolMax: 8 }, log); await run(db.repo, initSecrets({ dataDir: data }, log)); }
  finally { await db?.close(); await admin.exec(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.close(); await rm(data, { recursive: true, force: true }); }
}
function codeFrom(redirect: string) { return new URLSearchParams(new URL(redirect).hash.slice(1)).get("bf_pair_code")!; }

test("SimpleVMS pairing validates identity, proof, return paths, media addresses and login continuation", () => {
  const { input } = request(); assert.deepEqual(validateSimpleVmsPairRequest(input as unknown as Record<string, unknown>), input);
  for (const patch of [{ challenge: "short" }, { state: [input.state] }, { instance_id: "" }, { name: "x".repeat(256) },
    { redirect_uri: "javascript:alert(1)" }, { redirect_uri: "https://attacker.test/redirect" }, { redirect_uri: input.redirect_uri + "?next=elsewhere" },
    { external_address: "rtsp://127.0.0.1:8554" }, { external_http_address: "http://recorder.test:8555" }]) assert.throws(() => validateSimpleVmsPairRequest({ ...input, ...patch }));
  assert.equal(simpleVmsPairReturn("/admin/simplevms/pair?state=abc"), "/admin/simplevms/pair?state=abc");
  const continuation = "/admin/simplevms/pair?" + new URLSearchParams(input);
  assert.equal(unpackSimpleVmsPairReturn(packSimpleVmsPairReturn(continuation)), continuation);
  assert.equal(unpackSimpleVmsPairReturn("not-compressed"), null); assert.equal(unpackSimpleVmsPairReturn("a".repeat(4000)), null);
  for (const value of ["//evil.test/admin/simplevms/pair?x=1", "https://evil.test", "/admin/simplevms/pair?x=1\r\nLocation: elsewhere", "/admin/simplevms/pair?x=1#bad", "/admin/", undefined]) assert.equal(simpleVmsPairReturn(value), null);
  assert.equal(operatorMayAccess("/admin/simplevms/pair", "POST"), false);
  assert.equal(operatorMayAccess("/admin/kiosks/id/simple-vms/link", "POST"), false);
});

test("Pairing resumes after BF login and two-factor approval without weakening CSRF protection", { skip: !pgUrl }, () => database(async (repo, secrets) => {
  const auth = createAuth(repo, secrets, { sessionIdleSeconds: 3600, sessionMaxSeconds: 3600, loginLockoutThreshold: 8,
    loginLockoutSeconds: 60, argon2Memory: 8, argon2TimeCost: 1, argon2Parallelism: 1, totpIssuer: "BetterFrame", cookieName: "bf_test_session" });
  const user = await repo.createUser({ username: "pair-admin", password_hash: await auth.hashPassword("test-password"), role: "admin" });
  const deps = { repo, secrets, auth, cookieName: "bf_test_session" } as never;
  const app = new H3(); registerMiddleware(app, deps); registerAuthRoutes(app, deps); registerSimpleVmsAdminRoutes(app, deps);
  const { input } = request(); const path = "/admin/simplevms/pair?" + new URLSearchParams(input);
  const landing = await app.request("http://127.0.0.1/simplevms/pair?" + new URLSearchParams(input));
  assert.equal(landing.status, 200); assert.match(await landing.text(), /http-equiv="refresh"/);
  const first = await app.request("http://127.0.0.1" + path); assert.equal(first.status, 302); assert.equal(first.headers.get("location"), "/auth/login");
  const continuation = first.headers.getSetCookie()[0]!.split(";")[0]!;
  assert.match(continuation, /^bf_simplevms_pair_return=/);
  const login = await app.request("http://127.0.0.1/auth/login", { method: "POST", headers: { "content-type": "application/json", cookie: continuation },
    body: JSON.stringify({ username: user.username, password: "test-password" }) });
  assert.equal(login.status, 302); assert.equal(login.headers.get("location"), path);
  const cookies = login.headers.getSetCookie().filter(cookie => !cookie.includes("Max-Age=0")).map(cookie => cookie.split(";")[0]).join("; ");
  assert.equal((await app.request("http://127.0.0.1" + path, { headers: { cookie: cookies } })).status, 200);
  const sessionCookie = cookies.split("; ").find(cookie => cookie.startsWith("bf_test_session="))!;
  const submit = (cookie: string, origin = "http://127.0.0.1") => app.request("http://127.0.0.1/admin/simplevms/pair", {
    method: "POST", headers: { cookie, origin, host: "127.0.0.1", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(input).toString() });
  assert.equal((await submit(sessionCookie)).status, 403);
  assert.equal((await submit(cookies, "https://attacker.test")).status, 403);
  assert.equal((await submit(cookies)).status, 200);

  await repo.updateUser(user.id, { totp_enabled: true, totp_secret_encrypted: auth.encryptTotpSecret("TESTSECRET") });
  const tenant = (await repo.getTenantBySlug("default"))!;
  const pending = await auth.createSession({ user, originTenantId: tenant.id, userAgent: null, ipAddress: null, totpPending: true });
  const twoFactorCookies = `bf_test_session=${pending.cookieValue}; betterframe_csrf=${pending.session.csrf_token}`;
  const gate = await app.request("http://127.0.0.1" + path, { headers: { cookie: twoFactorCookies } });
  assert.equal(gate.headers.get("location"), "/auth/totp");
  auth.verifyTotpCode = () => true;
  const verified = await app.request("http://127.0.0.1/auth/totp", { method: "POST", headers: { "content-type": "application/json",
    cookie: twoFactorCookies + "; " + gate.headers.getSetCookie()[0]!.split(";")[0] }, body: JSON.stringify({ code: "123456" }) });
  assert.equal(verified.status, 302); assert.equal(verified.headers.get("location"), path);
}));

test("SimpleVMS browser approval requires an administrator; PKCE redemption is bounded, tenant-local, expiring and single-use", { skip: !pgUrl }, () => database(async (repo, secrets) => {
  const { input, verifier } = request();
  const app = new H3(); let role: "admin" | "operator" | undefined;
  app.use(event => { if (role) event.context.user = { username: "owner", role } as never; });
  registerSimpleVmsAdminRoutes(app, { repo, secrets } as never); registerSimpleVmsIngress(app, repo, secrets);
  const url = "http://127.0.0.1/admin/simplevms/pair";
  const form = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(input).toString() };
  assert.equal((await app.request(url, form)).status, 403); role = "operator"; assert.equal((await app.request(url, form)).status, 403);
  role = "admin";
  const page = await app.request(url + "?" + new URLSearchParams(input)); assert.equal(page.status, 200);
  assert.match(await page.text(), /Pair SimpleVMS/);
  const approved = await app.request(url, form); assert.equal(approved.status, 200);
  const redirect = (await approved.text()).match(/<a href="([^"]+)"/)![1]!.replaceAll("&amp;", "&"); const code = codeFrom(redirect);
  assert.equal(new URL(redirect).origin, "https://recorder.test");
  assert.equal(new URLSearchParams(new URL(redirect).hash.slice(1)).get("bf_pair_state"), input.state);
  assert.doesNotMatch(redirect, /integrationToken|viewerPassword|verifier/);
  assert.equal((await listSimpleVmsSources(repo)).length, 0, "Approval alone must not create or rotate a recorder");
  const claim = async (patch: Record<string, unknown> = {}, tenant = "default") => app.request(`http://127.0.0.1/api/simplevms/${tenant}/pair/claim`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, verifier, instanceId: input.instance_id, ...patch }) });
  assert.equal((await claim({ verifier: proof() })).status, 400);
  assert.equal((await claim({ instanceId: "different-recorder" })).status, 400);
  assert.equal((await claim({ padding: "x".repeat(9000) })).status, 400);
  const other = await repo.createTenant({ name: "Other", slug: "other" }); await createTenantSchema(repo.adapter, other.slug, log);
  assert.equal((await claim({}, other.slug)).status, 400);
  const response = await claim(); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const grant = await response.json() as SimpleVmsPairGrant;
  const source = (await getSimpleVmsSource(repo, grant.sourceId))!;
  assert.equal(source.owner_kiosk_id, null); assert.equal(source.enabled, true); assert.equal(source.auto_sync, true);
  assert.ok(grant.integrationToken.length >= 32); assert.ok(grant.viewerPassword.length >= 32); assert.match(grant.viewerUsername, /^bf-/);
  assert.ok(simpleVmsTokenMatches(source, grant.integrationToken)); assert.equal(secrets.decryptString(source.viewer_password_encrypted, "simple-vms-viewer"), grant.viewerPassword);
  assert.ok(grant.callbackUrl.endsWith(`/${grant.sourceId}/events`)); assert.equal((await claim()).status, 400);
  const expired = request("expired"); const expiredCode = codeFrom(await approveSimpleVmsPairing(repo, secrets, expired.input, "default", "http://127.0.0.1"));
  await repo.adapter.run("UPDATE simple_vms_pairings SET expires_at = now() - interval '1 second' WHERE instance_id = 'expired'", []);
  await assert.rejects(claimSimpleVmsPairing(repo, secrets, { code: expiredCode, verifier: expired.verifier, instanceId: "expired" }));
}));

test("Paired regional recorders sync before kiosk selection; kiosk linking, bundles and reconnection preserve identities", { skip: !pgUrl }, () => database(async (repo, secrets) => {
  async function pair(instance: string) { const { input, verifier } = request(instance); const code = codeFrom(await approveSimpleVmsPairing(repo, secrets, input, "default", "http://127.0.0.1")); return claimSimpleVmsPairing(repo, secrets, { code, verifier, instanceId: instance }); }
  const first = await pair("north"); const second = await pair("south"); assert.notEqual(first.sourceId, second.sourceId);
  const cameraSnapshot = { version: 1 as const, instanceId: "north", revision: 1, name: "North", cameras: [{ id: "camera-one", name: "Entrance", enabled: true,
    profiles: [{ id: "High", name: "Main", role: "main" as const, codec: "h264", width: 1920, height: 1080, fps: 25 }] }], groups: [{ id: "outside", name: "Outside", cameraIds: ["camera-one"] }] };
  await applySimpleVmsSnapshot(repo, first.sourceId, cameraSnapshot);
  const camera = (await repo.listCameras())[0]!; const layout = (await repo.listLayouts())[0]!;
  await applySimpleVmsSnapshot(repo, second.sourceId, { ...cameraSnapshot, instanceId: "south", name: "South", cameras: [{ ...cameraSnapshot.cameras[0]!, name: "South entrance" }] });
  const kiosk = await repo.createKiosk({ name: "North kiosk", key_hash: "north", key_prefix: "north" });
  const display = await repo.createDisplayForKiosk(kiosk.id, { name: "Wall" });
  assert.equal((await simpleVmsCamerasForKiosk(repo, kiosk.id)).length, 0);
  const card = String(SimpleVmsKioskCard({ kiosk, sources: await listSimpleVmsSources(repo, kiosk.id) }));
  assert.match(card, /Select a paired instance/); assert.match(card, new RegExp(first.sourceId)); assert.match(card, new RegExp(second.sourceId)); assert.doesNotMatch(card, /ingest_token|viewer_password|viewer_username/);
  await linkSimpleVmsKiosk(repo, first.sourceId, kiosk.id, true);
  await linkSimpleVmsKiosk(repo, second.sourceId, kiosk.id, true);
  assert.equal((await listSimpleVmsSources(repo, kiosk.id)).filter(s => s.connected).length, 2);
  assert.equal((await repo.getKioskById(kiosk.id))!.simple_vms_enabled, true);
  assert.equal((await repo.listLayoutsForDisplay(display.id)).length, 2);
  const app = new H3(); registerSimpleVmsAdminRoutes(app, { repo, secrets } as never);
  for (let attempt = 0; attempt < 10; attempt++) {
    const [saved] = await Promise.all([
      app.request(`http://127.0.0.1/admin/simplevms/${first.sourceId}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ enabled: "1", auto_sync: "1", local_address: "rtsp://127.0.0.1:8554", external_address: "rtsp://recorder.test:8554",
          local_http_address: "http://127.0.0.1:8555", external_http_address: "https://recorder.test:8555" }).toString() }),
      linkSimpleVmsKiosk(repo, second.sourceId, kiosk.id, true),
    ]);
    assert.equal(saved.status, 303, "Updating one recorder while linking another must not deadlock shared kiosk/display rows");
  }
  const bundle = (await generateBundle(repo, secrets, kiosk.id, secrets.generateClusterKey()))!;
  assert.equal(bundle.cameras[0]!.streams[0]!.rtsp_uri, "rtsp://recorder.test:8554/bf/camera-one/High");
  await linkSimpleVmsKiosk(repo, first.sourceId, kiosk.id, true, true);
  const localBundle = (await generateBundle(repo, secrets, kiosk.id, secrets.generateClusterKey()))!;
  assert.equal(localBundle.cameras[0]!.streams[0]!.rtsp_uri, "rtsp://127.0.0.1:8554/bf/camera-one/High");
  const reconnect = await pair("north"); assert.equal(reconnect.sourceId, first.sourceId); assert.notEqual(reconnect.integrationToken, first.integrationToken);
  assert.ok(await repo.getCameraById(camera.id)); assert.ok(await repo.getLayoutById(layout.id));
  assert.equal((await listSimpleVmsSources(repo, kiosk.id)).filter(s => s.connected).length, 2);
  await linkSimpleVmsKiosk(repo, first.sourceId, kiosk.id, false);
  const remaining = await simpleVmsCamerasForKiosk(repo, kiosk.id);
  assert.equal(remaining.length, 1); assert.equal(remaining[0]!.source_id, second.sourceId);
  assert.equal((await repo.listLayoutsForDisplay(display.id)).length, 1);
  assert.equal((await repo.getKioskById(kiosk.id))!.simple_vms_enabled, true, "A second connected recorder keeps the kiosk integration enabled");
  await repo.deleteKiosk(kiosk.id); assert.ok(await getSimpleVmsSource(repo, first.sourceId)); assert.ok(await getSimpleVmsSource(repo, second.sourceId));
}));

test("Legacy owner migration preserves local playback, camera IDs and layout assignments", { skip: !pgUrl }, () => database(async (repo, secrets) => {
  const kiosk = await repo.createKiosk({ name: "Legacy recorder", key_hash: "legacy", key_prefix: "legacy" });
  const display = await repo.createDisplayForKiosk(kiosk.id, { name: "Legacy wall" });
  const source = await saveSimpleVmsSource(repo, secrets, kiosk.id, { instanceId: "legacy", name: "Legacy NVR", localAddress: "rtsp://127.0.0.1:8554", externalAddress: "",
    linkedKioskIds: [], enabled: true, autoSync: true, viewerUsername: "legacy", viewerPassword: "legacy-reader-password", ingestToken: proof() });
  await applySimpleVmsSnapshot(repo, source.id, { version: 1, instanceId: "legacy", revision: 1, name: "Legacy", cameras: [{ id: "camera", name: "Legacy camera", enabled: true, profiles: [] }], groups: [{ id: "wall", name: "Wall", cameraIds: ["camera"] }] });
  const camera = (await repo.listCameras())[0]!; const layout = (await repo.listLayouts())[0]!;
  for (const sql of TENANT_MIGRATIONS.filter(sql => sql.startsWith("INSERT INTO simple_vms_linked_kiosks(source_id, kiosk_id, use_local_address)") || sql === "UPDATE simple_vms_sources SET owner_kiosk_id = NULL")) await repo.adapter.exec(sql);
  const migrated = (await getSimpleVmsSource(repo, source.id))!; assert.equal(migrated.owner_kiosk_id, null);
  const available = await simpleVmsCamerasForKiosk(repo, kiosk.id); assert.equal(available[0]!.camera_id, camera.id); assert.equal(available[0]!.use_local_address, true);
  assert.equal((await repo.listLayoutsForDisplay(display.id))[0]!.id, layout.id);
  await repo.deleteKiosk(kiosk.id); assert.ok(await getSimpleVmsSource(repo, source.id)); assert.ok(await repo.getCameraById(camera.id));
}));
