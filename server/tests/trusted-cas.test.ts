import assert from "node:assert/strict";
import test from "node:test";
import { X509Certificate, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { H3 } from "h3";
import { parseTrustedCa, trustedCaAssignment, trustedCaRevision, activeTrustedCas } from "../src/shared/trusted-cas.js";
import { registerTrustedCaRoutes } from "../src/plugins/service-admin-http/routes-trusted-cas.js";
import { registerMiddleware } from "../src/plugins/service-admin-http/middleware.js";
import { TrustedCasPage } from "../src/web-templates/trusted-ca-pages.js";
import { registerKioskRoutes } from "../src/plugins/service-api-http/index.js";
import { generateBundle } from "../src/shared/bundle.js";
import { PgAdapter } from "../src/shared/db/pg-adapter.js";
import { Repository } from "../src/shared/db/repository.js";
import { TENANT_MIGRATIONS } from "../src/shared/db/migrations-pg.js";

function withCertificate(fn: (pem: string, key: string) => unknown) {
  const directory = mkdtempSync(join(tmpdir(), "bf-ca-test-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=BetterFrame test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", join(directory, "key.pem"), "-out", join(directory, "ca.pem")], { stdio: "ignore" });
    return fn(readFileSync(join(directory, "ca.pem"), "utf8"), readFileSync(join(directory, "key.pem"), "utf8"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

// One generated public fixture is shared; private material exists only in this process/tempdir.
let pem = "", privateKey = "";
withCertificate((certificate, key) => { pem = certificate; privateKey = key; });
const ca = { id: "ca", name: "Internal", ...parseTrustedCa(pem) };

test("CA validation canonicalizes PEM/DER and rejects private keys, chains, leafs, forged roots and invalid lifetimes", () => {
  const x509 = new X509Certificate(pem);
  assert.deepEqual(parseTrustedCa(x509.raw), parseTrustedCa(pem.replaceAll("\n", "\r\n")));
  assert.throws(() => parseTrustedCa(pem + privateKey), /public CA/);
  assert.throws(() => parseTrustedCa(pem + pem), /public CA/);
  assert.throws(() => parseTrustedCa("not a certificate"), /Invalid X.509/);
  assert.throws(() => parseTrustedCa("x".repeat(16385)), /16 KiB/);
  assert.throws(() => parseTrustedCa(pem, Date.parse(ca.not_before) - 1), /not yet valid/);
  assert.throws(() => parseTrustedCa(pem, Date.parse(ca.not_after)), /expired/);
  const forged = Buffer.from(x509.raw); forged[forged.length - 1]! ^= 1;
  assert.throws(() => parseTrustedCa(forged), /self-signed/);
  assert.throws(() => parseTrustedCa(Buffer.concat([x509.raw, Buffer.from([0])])), /exactly one/);
  const directory = mkdtempSync(join(tmpdir(), "bf-leaf-test-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Leaf", "-addext", "basicConstraints=critical,CA:FALSE", "-keyout", join(directory, "key"), "-out", join(directory, "cert")], { stdio: "ignore" });
    assert.throws(() => parseTrustedCa(readFileSync(join(directory, "cert"))), /not a website/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("assignment parsing is bounded and revisions ignore ordering", () => {
  assert.deepEqual(trustedCaAssignment(undefined), []);
  assert.deepEqual(trustedCaAssignment("ca"), ["ca"]);
  assert.deepEqual(trustedCaAssignment(["b", "a", "b"]), ["a", "b"]);
  assert.throws(() => trustedCaAssignment(["../ca"]));
  assert.throws(() => trustedCaAssignment(Array(33).fill("ca")));
  assert.equal(trustedCaRevision([]), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(trustedCaRevision([ca, { ...ca, fingerprint_sha256: "b".repeat(64) }]), trustedCaRevision([{ ...ca, fingerprint_sha256: "b".repeat(64) }, ca]));
});

function routeFixture(middleware = false, role = "admin") {
  const certificates = new Map([[ca.id, ca]]);
  let assigned: string[] = [], reports: any[] = [];
  const audits: any[] = [];
  const kiosk = { id: "player", name: "Player", capabilities: ["android-viewer"] };
  const repo = {
    adapter: { dialect: () => "sqlite" }, isSetupComplete: async () => true,
    listTrustedCas: async () => [...certificates.values()], getTrustedCa: async (id: string) => certificates.get(id) ?? null,
    saveTrustedCa: async (value: any) => { const existing = [...certificates.values()].find(c => c.fingerprint_sha256 === value.fingerprint_sha256); if (existing) return existing; certificates.set(value.id, value); return value; },
    deleteTrustedCa: async (id: string) => { certificates.delete(id); assigned = assigned.filter(item => item !== id); },
    listKiosks: async () => [kiosk], getKioskById: async (id: string) => id === "player" ? kiosk : null,
    assignTrustedCas: async (_id: string, ids: string[]) => { assigned = ids; },
    listTrustedCaAssignments: async () => assigned.map(ca_id => ({ kiosk_id: "player", ca_id })),
    listTrustedCaReports: async () => reports, insertAudit: async (input: any) => audits.push(input),
  };
  const auth = { resolveSession: async () => ({ user: { id: "admin", username: "Admin", role }, tenant: { id: "tenant", slug: "default" }, session: { csrf_token: "csrf" } }) };
  const app = new H3();
  const deps = { repo, auth, cookieName: "session" } as never;
  if (middleware) registerMiddleware(app, deps);
  registerTrustedCaRoutes(app, deps);
  const post = (path: string, value: unknown) => app.request("http://bf.test" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  return { app, post, certificates, audits, assigned: () => assigned, setReports: (value: any[]) => { reports = value; } };
}

test("admin routes upload multipart/PEM, download and delete with audit and no trust of unknown tenant IDs", async () => {
  const f = routeFixture();
  assert.equal((await f.post("/admin/trusted-cas", { name: "Duplicate", pem })).status, 303);
  assert.equal(f.certificates.size, 1);
  assert.equal(f.audits[0].resource_id, ca.id, "Duplicate upload audits the actual stored row");
  assert.equal((await f.post("/admin/trusted-cas", { name: "Bad", pem: privateKey })).status, 422);
  const form = new FormData(); form.set("name", "Root"); form.set("certificate", new File([new X509Certificate(pem).raw], "root.der"));
  assert.equal((await f.app.request("http://bf.test/admin/trusted-cas", { method: "POST", body: form })).status, 303);
  assert.equal((await f.post("/admin/trusted-cas/players/player", { ca_ids: ["ca"] })).status, 303);
  assert.deepEqual(f.assigned(), ["ca"]);
  assert.equal((await f.post("/admin/trusted-cas/players/player", { ca_ids: ["other-tenant"] })).status, 422);
  assert.deepEqual(f.assigned(), ["ca"]);
  const encoded = new URLSearchParams(); encoded.append("ca_ids", "ca");
  assert.equal((await f.app.request("http://bf.test/admin/trusted-cas/players/player", { method: "POST", body: encoded })).status, 303);
  const download = await f.app.request("http://bf.test/admin/trusted-cas/ca/certificate");
  assert.equal(await download.text(), ca.pem);
  assert.match(download.headers.get("content-disposition")!, /attachment/);
  assert.equal((await f.post("/admin/trusted-cas/players/player", {})).status, 303);
  assert.deepEqual(f.assigned(), []);
  assert.equal((await f.post("/admin/trusted-cas/ca/delete", {})).status, 303);
  assert.equal(f.certificates.size, 0);
  assert.equal((await f.app.request("http://bf.test/admin/trusted-cas/ca/certificate")).status, 404);
  assert.ok(f.audits.some(a => a.action === "trusted-ca.assign"));
  assert.doesNotMatch(JSON.stringify(f.audits), /PRIVATE KEY|BEGIN CERTIFICATE/);
});

test("CA admin routes enforce existing authentication, operator denial, and CSRF before changes", async () => {
  assert.equal((await routeFixture(true).app.request("http://bf.test/admin/trusted-cas")).status, 302);
  const operator = routeFixture(true, "operator");
  assert.equal((await operator.app.request("http://bf.test/admin/trusted-cas", { headers: { cookie: "session=x" } })).status, 403);
  const admin = routeFixture(true);
  const request = (cookie: string, origin: string) => admin.app.request("http://bf.test/admin/trusted-cas/players/player", { method: "POST", headers: { cookie, origin, host: "bf.test", "content-type": "application/json" }, body: JSON.stringify({ ca_ids: ["ca"] }) });
  assert.equal((await request("session=x", "http://bf.test")).status, 403);
  assert.equal((await request("session=x; betterframe_csrf=csrf", "http://attacker.test")).status, 403);
  assert.deepEqual(admin.assigned(), []);
  assert.equal((await request("session=x; betterframe_csrf=csrf", "http://bf.test")).status, 303);
});

test("CA page escapes names and exposes pending, manual action and recorded application separately", () => {
  const html = String(TrustedCasPage({ cas: [{ ...ca, name: "<script>bad()</script>" }], kiosks: [{ id: "player", name: "Player" }] as never,
    assignments: [{ kiosk_id: "player", ca_id: "ca" }], reports: [{ kiosk_id: "player", revision: trustedCaRevision([ca]), state: "manual_action", message: "Install through Settings", reported_at: new Date().toISOString() }] }));
  assert.doesNotMatch(html, /<script>bad/); assert.match(html, /&lt;script&gt;/); assert.match(html, /Manual action required/);
});

test("assigned public CAs change bundle versions; removal emits an empty set and leaves unrelated players unchanged", async () => {
  let assigned = [ca];
  const repo = { getKioskById: async (id: string) => ({ id, name: "Viewer", capabilities: ["android-viewer"], encrypt_key_encrypted: "key" }),
    listDisplaysForKiosk: async () => [{ id: "display", name: "Main", is_enabled: true, width_px: 1920, height_px: 1080 }],
    layoutsForDisplayId: async () => [], listCameraDevices: async () => [],
    trustedCasForKiosk: async (id: string) => id === "assigned" ? assigned : [] };
  const secrets = { decryptString: () => "key" };
  const first = await generateBundle(repo as never, secrets as never, "assigned", undefined);
  const other = await generateBundle(repo as never, secrets as never, "other", undefined);
  const repeated = await generateBundle(repo as never, secrets as never, "assigned", undefined);
  assert.equal(first?.version, repeated?.version);
  assert.deepEqual(first?.trusted_cas, [{ pem: ca.pem, fingerprint_sha256: ca.fingerprint_sha256 }]);
  assigned = [];
  const removed = await generateBundle(repo as never, secrets as never, "assigned", undefined);
  assert.deepEqual(removed?.trusted_cas, []); assert.notEqual(first?.version, removed?.version);
  assert.equal(other?.version, (await generateBundle(repo as never, secrets as never, "other", undefined))?.version);
});

test("PostgreSQL CA assignments and reports remain tenant-local and survive reopening", { skip: !process.env["BF_TEST_PG_URL"] }, async () => {
  const adapter = new PgAdapter(process.env["BF_TEST_PG_URL"]!);
  const schemas = [0, 1].map(() => "ca_test_" + randomBytes(6).toString("hex"));
  const migrations = TENANT_MIGRATIONS.filter(sql => /^CREATE TABLE (trusted_cas|kiosk_trusted_cas|kiosk_trust_status) \(/.test(sql));
  try {
    for (const schema of schemas) await adapter.withSearchPath(schema, async () => {
      await adapter.exec(`CREATE SCHEMA ${schema}`); await adapter.exec(`CREATE TABLE ${schema}.kiosks (id TEXT PRIMARY KEY, key_hash TEXT, key_prefix TEXT, capabilities JSONB,
        hardware_model TEXT, firmware_target TEXT, paired_at TEXT, last_seen_at TEXT, last_bundle_version TEXT,
        kiosk_app_version TEXT, os_version TEXT, cpu_temp_c REAL, cpu_load_percent REAL, fan_rpm INTEGER,
        fan_pwm INTEGER, memory_total_mb INTEGER, memory_used_mb INTEGER, disk_total_mb INTEGER, disk_free_mb INTEGER, disk_used_percent REAL)`);
      for (const sql of migrations) await adapter.exec(sql);
      await adapter.run("INSERT INTO kiosks(id) VALUES (?)", ["player"]);
    });
    const repo = new Repository(adapter, async () => {});
    await adapter.withSearchPath(schemas[0]!, async () => { await repo.saveTrustedCa(ca); await repo.assignTrustedCas("player", [ca.id]); await repo.reportTrustedCas("player", { revision: trustedCaRevision([ca]), state: "applied", message: "" }); });
    await adapter.withSearchPath(schemas[1]!, async () => {
      assert.deepEqual(await repo.listTrustedCas(), []);
      await assert.rejects(() => repo.assignTrustedCas("player", [ca.id]), /this tenant/);
      assert.deepEqual(await repo.listTrustedCaReports(), []);
    });
    const reopened = new Repository(adapter, async () => {});
    await adapter.withSearchPath(schemas[0]!, async () => {
      assert.deepEqual(await reopened.trustedCasForKiosk("player"), [ca]);
      assert.equal((await reopened.listTrustedCaReports())[0]?.state, "applied");
      const duplicate = await reopened.saveTrustedCa({ ...ca, id: "duplicate-id", name: "Other name" });
      assert.equal(duplicate.id, ca.id); assert.equal(duplicate.name, ca.name);
      await reopened.transact(() => reopened.replaceKioskKey("player", { key_hash: "replacement", key_prefix: "new" }));
      assert.deepEqual(await reopened.listTrustedCaReports(), []);
      assert.deepEqual(await reopened.trustedCasForKiosk("player"), [ca]);
      await adapter.run("UPDATE trusted_cas SET not_after = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", ca.id]);
      assert.deepEqual(await reopened.trustedCasForKiosk("player"), []);
      await adapter.run("UPDATE trusted_cas SET not_after = ? WHERE id = ?", [ca.not_after, ca.id]);
      await assert.rejects(() => reopened.assignTrustedCas("player", ["missing"]));
      assert.deepEqual(await reopened.trustedCasForKiosk("player"), [ca]);
      await reopened.deleteTrustedCa(ca.id); assert.deepEqual(await reopened.trustedCasForKiosk("player"), []);
    });
  } finally { for (const schema of schemas) await adapter.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await adapter.close(); }
});

test("heartbeats provision and remove CAs without displays, layouts or a content bundle", async () => {
  for (const viewer of [false, true]) {
    let assigned = [ca]; const reports: unknown[] = [];
    const profile = { id: "player", name: "Player", enabled: true, capabilities: viewer ? ["android-viewer"] : ["linux"], managed_image: false };
    const app = new H3();
    app.use(event => { event.context.verifiedKiosk = { id: "player" }; event.context.kioskProfile = profile; });
    registerKioskRoutes(app, {
      getKioskById: async () => profile, touchKiosk: async () => {}, getSetupExtra: async () => null, listDisplaysForKiosk: async () => [],
      trustedCasForKiosk: async (id: string) => { assert.equal(id, "player"); return assigned; },
      reportTrustedCas: async (_id: string, report: unknown) => { reports.push(report); },
    } as never, {} as never, {} as never, {} as never, {} as never, {} as never, { publishTelemetry() {} } as never, "");
    const send = () => app.request("http://bf.test/api/kiosk/heartbeat", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ displays: [], trusted_ca_status: { revision: trustedCaRevision([]), state: "applied", message: "" } }) });
    const first = await send(); assert.equal(first.status, 200);
    assert.deepEqual(((await first.json()) as { trusted_cas: unknown }).trusted_cas, [{ pem: ca.pem, fingerprint_sha256: ca.fingerprint_sha256 }]);
    assigned = [];
    const removed = await send(); assert.equal(removed.status, 200);
    assert.deepEqual(((await removed.json()) as { trusted_cas: unknown }).trusted_cas, []);
    assert.equal(reports.length, 2);
  }
});

test("canonical PEM expansion is rejected at upload and certificate validity uses complete timestamps", () => {
  const directory = mkdtempSync(join(tmpdir(), "bf-large-ca-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Large root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "1.2.3.4=DER:" + "01".repeat(12000), "-keyout", join(directory, "key"), "-out", join(directory, "cert")], { stdio: "ignore" });
    const cert = new X509Certificate(readFileSync(join(directory, "cert")));
    assert.ok(cert.raw.length < 16384); assert.ok(Buffer.byteLength(cert.toString()) > 16384);
    assert.throws(() => parseTrustedCa(cert.raw), /Canonical PEM/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  const now = Date.parse("2030-01-01T00:00:00.000Z");
  const valid = { ...ca, not_before: "2029-01-01T00:00:00.000Z", not_after: "2031-01-01T00:00:00.000Z" };
  assert.deepEqual(activeTrustedCas([valid, { ...valid, id: "expired", not_after: "2030-01-01T00:00:00.000Z" }, { ...valid, id: "future", not_before: "2030-01-01T00:00:00.001Z" }], now), [valid]);
});
