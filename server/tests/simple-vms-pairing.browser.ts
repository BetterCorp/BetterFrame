// Optional cross-site browser regression. Uses the real BF routes and built native web UI;
// the native API is a test double. Native endpoint authorization and plugin persistence have .NET tests.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { tmpdir } from "node:os";
import { H3, toNodeHandler } from "h3";
import { PgAdapter } from "../src/shared/db/pg-adapter.js";
import { initDb } from "../src/shared/db/init.js";
import { initSecrets } from "../src/shared/secrets.js";
import { createAuth } from "../src/shared/auth.js";
import { registerMiddleware } from "../src/plugins/service-admin-http/middleware.js";
import { registerAuthRoutes } from "../src/plugins/service-admin-http/routes-auth.js";
import { registerSimpleVmsAdminRoutes } from "../src/plugins/service-admin-http/routes-simple-vms.js";
import { registerSimpleVmsIngress } from "../src/shared/simple-vms-http.js";
import { listSimpleVmsSources } from "../src/shared/simple-vms.js";
import { SimpleVmsKioskCard } from "../src/web-templates/simple-vms-pages.js";
import { htmlPage } from "../src/plugins/service-admin-http/html-response.js";
import type { SimpleVmsPairGrant } from "../src/shared/simple-vms-pairing.js";

const pg = process.env.BF_TEST_PG_URL;
const configuredWebRoot = process.env.BF_PAIRING_NATIVE_WEB_ROOT;
if (!pg || !configuredWebRoot) throw new Error("Set BF_TEST_PG_URL and BF_PAIRING_NATIVE_WEB_ROOT to the patched native Client.Web/dist directory");
const webRoot = resolve(configuredWebRoot);
const { chromium } = await import(process.env.BF_PAIRING_PLAYWRIGHT_MODULE || "playwright");
const admin = new PgAdapter(pg); const database = `bf_pair_browser_${randomBytes(8).toString("hex")}`;
const cleanup: Array<() => Promise<unknown>> = [() => admin.close()];
let fixtureError: unknown; let page: any; let loginHits = 0; let nativeAuthFailures = 0;
try {
  await admin.exec(`CREATE DATABASE "${database}"`);
  cleanup.push(() => admin.exec(`DROP DATABASE "${database}" WITH (FORCE)`));
  if (process.env.BF_PAIRING_FAIL_SETUP === "1") throw new Error("Injected fixture setup failure");
  const dbUrl = new URL(pg); dbUrl.pathname = "/" + database;
  const data = await mkdtemp(join(tmpdir(), "bf-pair-browser-")); const log = { info() {}, warn() {} };
  cleanup.push(() => rm(data, { recursive: true, force: true }));
  const db = await initDb({ url: dbUrl.href, host: "", port: 5432, user: "", password: "", database, poolMax: 8 }, log);
  cleanup.push(() => db.close());
  const secrets = initSecrets({ dataDir: data }, log); const repo = db.repo;
  const auth = createAuth(repo, secrets, { sessionIdleSeconds: 3600, sessionMaxSeconds: 3600, loginLockoutThreshold: 8,
    loginLockoutSeconds: 60, argon2Memory: 8, argon2TimeCost: 1, argon2Parallelism: 1, totpIssuer: "BF", cookieName: "bf_browser_session" });
  const user = await repo.createUser({ username: "browser-admin", password_hash: await auth.hashPassword("browser-test-only"), role: "admin" });
  const tenant = (await repo.getTenantBySlug("default"))!;
  const session = await auth.createSession({ user, originTenantId: tenant.id, userAgent: null, ipAddress: null, totpPending: false });
  const kiosk = await repo.createKiosk({ name: "Regional wall", key_hash: "browser", key_prefix: "browser" });
  const display = await repo.createDisplayForKiosk(kiosk.id, { name: "Wall screen" });
  const app = new H3();
  app.use(event => { if (new URL(event.req.url).pathname === "/auth/login") loginHits++; });
  const deps = { repo, auth, secrets, cookieName: "bf_browser_session" } as never;
  registerMiddleware(app, deps); registerAuthRoutes(app, deps); registerSimpleVmsAdminRoutes(app, deps); registerSimpleVmsIngress(app, repo, secrets);
  app.get(`/admin/kiosks/${kiosk.id}`, async () => htmlPage(SimpleVmsKioskCard({ kiosk, sources: await listSimpleVmsSources(repo, kiosk.id) })));
  const frame = createServer(toNodeHandler(app)); await new Promise<void>(ready => frame.listen(0, "127.0.0.1", ready));
  cleanup.push(() => new Promise<void>(done => frame.close(() => done())));
  const frameUrl = `http://127.0.0.1:${(frame.address() as { port: number }).port}`;
  const instance = randomUUID(); const state = randomBytes(32).toString("base64url"); const verifier = randomBytes(32).toString("base64url");
  const name = "North region & cameras %2F"; const configuration: Record<string, string> = { name, betterFrameUrl: frameUrl };
  let nativeUrl = ""; let grant: SimpleVmsPairGrant | undefined;
  function envelope(response: ServerResponse, body: unknown) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ result: "success", debugTag: "test", body })); }
  async function body(request: IncomingMessage) { let value = ""; for await (const chunk of request) value += chunk; return JSON.parse(value || "{}"); }
  const native = createServer((request, response) => { void (async () => {
    const path = new URL(request.url!, nativeUrl).pathname;
    if (path === "/betterframe-pairing-return") {
      response.setHeader("content-type", "text/html"); response.end("<!doctype html><script>window.location.replace('/settings/plugins/bettercorp-betterframe'+window.location.hash)</script>"); return;
    }
    if (!(request.headers.cookie ?? "").includes("native_session=test-admin")) { nativeAuthFailures++; response.writeHead(401); response.end("Native sign-in required"); return; }
    if (path === "/api/v1/system/health") { envelope(response, { status: "healthy" }); return; }
    if (path === "/api/v1/plugins/bettercorp-betterframe") { envelope(response, { id: "bettercorp-betterframe", name: "BetterFrame" }); return; }
    if (path === "/api/v1/plugins/bettercorp-betterframe/config") {
      if (request.method === "OPTIONS") envelope(response, [{ key: "betterframe", label: "BetterFrame", fields: [
        { key: "name", label: "NVR name", type: "string", order: 0 }, { key: "betterFrameUrl", label: "BetterFrame URL", type: "string", order: 1 },
        { key: "pair", label: "Pair with BetterFrame", type: "pairing", order: 2 }] }]);
      else if (request.method === "PUT") { Object.assign(configuration, await body(request)); envelope(response, null); }
      else envelope(response, configuration); return;
    }
    if (path === "/api/v1/plugins/bettercorp-betterframe/pairing/begin") {
      assert.equal(request.headers.origin, nativeUrl); const payload = await body(request);
      assert.equal(payload.returnUrl, nativeUrl + "/betterframe-pairing-return");
      const query = new URLSearchParams({ instance_id: instance, name: configuration.name!, redirect_uri: payload.returnUrl,
        state, challenge: createHash("sha256").update(verifier).digest("base64url"), local_address: "rtsp://127.0.0.1:8554",
        external_address: "rtsp://recorder.test:8554", local_http_address: "http://127.0.0.1:8555", external_http_address: "" });
      envelope(response, { redirectUrl: frameUrl + "/simplevms/pair?" + query }); return;
    }
    if (path === "/api/v1/plugins/bettercorp-betterframe/pairing/complete") {
      assert.equal(request.headers.origin, nativeUrl); const payload = await body(request); assert.equal(payload.state, state);
      const claimed = await fetch(`${frameUrl}/api/simplevms/${payload.tenantSlug}/pair/claim`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ code: payload.code, verifier, instanceId: instance }) });
      assert.equal(claimed.status, 200); grant = await claimed.json() as SimpleVmsPairGrant;
      const activated = await fetch(grant.activationUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceId: instance, sourceId: grant.sourceId, integrationToken: grant.integrationToken }) });
      assert.equal(activated.status, 200);
      const synced = await fetch(grant.callbackUrl, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + grant.integrationToken },
        body: JSON.stringify({ version: 1, instanceId: instance, revision: 1, name, cameras: [{ id: "camera", name: "Entrance", enabled: true,
          profiles: [{ id: "High", name: "Main", role: "main", codec: "h264", width: 1920, height: 1080, fps: 25 }] }], groups: [{ id: "outside", name: "Outside", cameraIds: ["camera"] }] }) });
      assert.equal(synced.status, 200); envelope(response, { redirectUrl: grant.managementUrl }); return;
    }
    const file = path.startsWith("/assets/") ? resolve(webRoot, "." + path) : join(webRoot, "index.html");
    if (!file.startsWith(webRoot + "/")) { response.writeHead(404); response.end(); return; }
    const types: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".woff2": "font/woff2" };
    response.setHeader("content-type", types[extname(file)] || "application/octet-stream"); response.end(await readFile(file));
  })().catch(error => { response.writeHead(500); response.end(String(error)); }); });
  await new Promise<void>(ready => native.listen(0, "127.0.0.1", ready)); nativeUrl = `http://recorder.test:${(native.address() as { port: number }).port}`;
  cleanup.push(() => new Promise<void>(done => native.close(() => done())));
  let browser: any;
  browser = await chromium.launch({ headless: true, args: ["--no-proxy-server", "--host-resolver-rules=MAP recorder.test 127.0.0.1,EXCLUDE localhost"] });
  cleanup.push(() => browser.close());
  const context = await browser.newContext(); await context.addCookies([
    { name: "bf_browser_session", value: session.cookieValue, url: frameUrl, httpOnly: true, sameSite: "Strict" },
    { name: "betterframe_csrf", value: session.session.csrf_token, url: frameUrl, sameSite: "Strict" },
    { name: "native_session", value: "test-admin", url: nativeUrl, httpOnly: true, sameSite: "Strict" },
  ]);
  page = await context.newPage(); page.setDefaultTimeout(15000);
  await page.goto(nativeUrl + "/settings/plugins/bettercorp-betterframe");
  await page.getByRole("button", { name: "Pair with BetterFrame", exact: true }).click();
  await page.getByRole("button", { name: "Pair SimpleVMS", exact: true }).click();
  await page.waitForURL((url: URL) => url.origin === frameUrl && url.pathname.startsWith("/admin/simplevms/") && url.pathname !== "/admin/simplevms/pair");
  assert.ok(grant); assert.equal(loginHits, 0, "Strict BF cookies must survive native -> BF -> native -> BF navigation");
  assert.equal(nativeAuthFailures, 0, "Strict native cookies must survive the return from BF");
  assert.equal((await listSimpleVmsSources(repo))[0]!.name, name);
  await page.goto(`${frameUrl}/admin/kiosks/${kiosk.id}`);
  await page.getByLabel("SimpleVMS instance", { exact: true }).selectOption(grant.sourceId);
  await page.getByRole("button", { name: "Connect instance", exact: true }).click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).waitFor();
  assert.equal((await repo.listLayoutsForDisplay(display.id)).length, 1);
  assert.equal((await repo.getKioskById(kiosk.id))!.simple_vms_enabled, true);
  if (process.env.BF_PAIRING_SCREENSHOT) await page.screenshot({ path: process.env.BF_PAIRING_SCREENSHOT, fullPage: true });
  console.log("PASS: Native Pair button -> BF approval -> native credential exchange -> initial sync -> kiosk dropdown, with Strict cookies and no repeated sign-in.");
} catch (error) {
  fixtureError = error;
  if (page) {
    console.error("Browser stopped at", new URL(page.url()).pathname, "login requests", loginHits, "native auth failures", nativeAuthFailures);
    console.error((await page.locator("body").innerText()).slice(0, 1800));
    if (process.env.BF_PAIRING_SCREENSHOT) await page.screenshot({ path: process.env.BF_PAIRING_SCREENSHOT + ".failure.png", fullPage: true });
  }
  throw error;
} finally {
  const failures: unknown[] = [];
  for (const dispose of cleanup.reverse()) { try { await dispose(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError([...(fixtureError ? [fixtureError] : []), ...failures], "Browser fixture cleanup failed");
}
