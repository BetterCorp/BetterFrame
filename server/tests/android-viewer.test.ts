import assert from "node:assert/strict";
import test from "node:test";
import { H3 } from "h3";
import { AsyncLocalStorage } from "node:async_hooks";
import { registerKioskRoutes } from "../src/plugins/service-api-http/index.js";
import { generateBundle } from "../src/shared/bundle.js";
import { androidViewerCommandAllowed, androidViewerRouteAllowed, viewerAssignment } from "../src/shared/android-viewer.js";
import { registerViewerDeviceAuth } from "../src/shared/display-session.js";

function fixture() {
  const kiosk = { id: "viewer", name: "Viewer", enabled: true, capabilities: ["android-viewer"], key_hash: "hash", encrypt_key_encrypted: Buffer.from("cluster").toString("base64url"), operator_console_enabled: true, simple_vms_enabled: true, operator_tools_json: '[{"label":"secret","url":"https://secret"}]' };
  const display = { id: "display", is_enabled: true, name: "Main", width_px: 1920, height_px: 1080, idle_timeout_seconds: 0, sleep_timeout_seconds: 0, default_layout_id: "layout" };
  const camera = { id: "camera", name: "Cam", enabled: true, type: "rtsp", rtsp_url: "rtsp://user:password@cam/live", onvif_host: "private", onvif_username: "user", onvif_password: "password", event_source: "auto", event_sink: "both", capabilities: ["ptz"], recording_config_json: { secret: "recording" } };
  const cells = [
    { id: "cell", entity_id: "entity", content_type: "camera", camera_id: "stale-camera", row: 0, col: 0, row_span: 1, col_span: 1, fit: "contain", options: { smart_url: { steps: [{ type: "fill", value: "secret" }] } } },
    { id: "dash-cell", content_type: "web", web_url: "/dash/assigned", row: 0, col: 1, row_span: 1, col_span: 1 },
    { id: "html-cell", content_type: "html", html_content: "<p>Offline</p>", row: 1, col: 0, row_span: 1, col_span: 1 },
    { id: "sign-cell", entity_id: "sign", row: 1, col: 1, row_span: 1, col_span: 1 },
  ];
  const repo = {
    adapter: { withSearchPath: async (_schema: string, fn: () => unknown) => fn() },
    getKioskById: async () => kiosk,
    getTenantBySlug: async () => ({ id: "tenant", slug: "default", schema_name: "public", name: "Default", is_active: true }),
    listDisplaysForKiosk: async () => [display, { ...display, id: "hidden" }],
    layoutsForDisplayId: async (id: string) => [{ id: id === "display" ? "layout" : "unassigned", name: "Layout", preload_camera_ids: ["private"], priority: "normal", resets_idle_timer: true }],
    layoutCells: async () => cells,
    getEntityById: async (id: string) => id === "sign" ? ({ id, type: "ablesign", web_url: "https://player.example/", ablesign_screen_id: "screen" }) : ({ id, type: "camera", camera_id: "camera", name: "Cam" }),
    getAbleSignScreen: async () => ({ ablesign_screen_id: "screen-identity", ablesign_screen_token_encrypted: "token" }),
    listCameraDevices: async () => [],
    getCameraById: async (id: string) => { assert.equal(id, "camera"); return camera; },
    listCameraStreams: async () => [],
    cameraLabelNames: async () => [],
    // Forbidden branches throw if viewer bundle accidentally widens scope.
    bundleScope: async () => { throw new Error("operator scope accessed"); },
    releaseStaleEventOwnership: async () => { throw new Error("ONVIF ownership changed"); },
    listGpioBindings: async () => { throw new Error("GPIO accessed"); },
    listEntities: async () => { throw new Error("operator content accessed"); },
  };
  const secrets = {
    encryptForCluster: (value: string) => `encrypted:${value}`,
    encryptString: (value: string) => Buffer.from(value).toString("base64url"),
    decryptString: (value: string) => value === "token" ? "signage-token" : Buffer.from(value, "base64url").toString(),
  };
  return { kiosk, repo, secrets, cells };
}

test("Android bundle follows resolved assigned camera entities and preserves HTML/signage only", async () => {
  const { repo, secrets } = fixture();
  const bundle = await generateBundle(repo as never, secrets as never, "viewer", "cluster");
  assert.ok(bundle);
  assert.equal(bundle.displays.length, 1);
  assert.deepEqual(bundle.cameras.map((c) => c.id), ["camera"]);
  assert.equal(bundle.cameras[0]?.onvif_host, null);
  assert.equal(bundle.cameras[0]?.onvif_password_encrypted, null);
  assert.equal(bundle.cameras[0]?.event_callback_token, "");
  assert.equal(bundle.cameras[0]?.playback_password_encrypted, "encrypted:password");
  assert.equal(bundle.cameras[0]?.streams[0]?.rtsp_uri, "rtsp://cam/live");
  assert.equal(bundle.operator_console.enabled, false);
  assert.deepEqual(bundle.operator_console.tools, []);
  assert.deepEqual(bundle.gpio_bindings, []);
  assert.deepEqual(bundle.layouts[0]?.preload_camera_ids, []);
  assert.deepEqual(bundle.layouts[0]?.cells[0]?.smart_url, { steps: [] });
  assert.equal(bundle.layouts[0]?.cells[2]?.html_content, "<p>Offline</p>");
  assert.deepEqual(bundle.layouts[0]?.cells[3]?.local_storage, { screenId: "screen-identity", screenToken: "signage-token" });
});

test("Android commands and device APIs default closed for privileged and future operations", () => {
  for (const type of ["power", "onvif-soap", "camera-proxy", "terminal-request", "firmware_check", "future"]) assert.equal(androidViewerCommandAllowed({ type }), false);
  assert.equal(androidViewerCommandAllowed({ type: "reload-bundle" }), true);
  assert.equal(androidViewerCommandAllowed({ type: "layout-switch", layout_id: "other" }, new Set(["assigned"])), false);
  assert.equal(androidViewerCommandAllowed({ type: "layout-switch", layout_id: "assigned" }, new Set(["assigned"])), true);
  assert.equal(androidViewerRouteAllowed("/api/kiosk/firmware/check", "GET"), false);
  assert.equal(androidViewerRouteAllowed("/api/kiosk/cameras/unassigned/stream", "GET"), false);
});

test("display cookie authenticates assigned dashboards but never device APIs, other pages, or cross-origin requests", async () => {
  const { repo, secrets, kiosk, cells } = fixture();
  cells[1]!.web_url = "/dash/assigned?theme=dark#overview";
  cells[0]!.web_url = "/dash/stale-camera-url";
  const bundle = await generateBundle(repo as never, secrets as never, "viewer", "cluster");
  assert.equal(bundle?.layouts[0]?.cells[1]?.web_url, cells[1]!.web_url);
  const app = new H3();
  registerViewerDeviceAuth(app, repo as never, { verifyKioskKey: async (key: string) => key === "device-key" ? { id: "viewer", schema_name: "public", tenant_slug: "default" } : null } as never, secrets as never);
  for (const path of ["/api/kiosk/_check", "/api/kiosk/bundle", "/api/kiosk/cameras/private/stream", "/api/kiosk/firmware/check"]) app.get(path, () => ({ ok: true }));
  const response = await app.request("https://bf.test/api/kiosk/display-session", { method: "POST", headers: { authorization: "Bearer device-key" } });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie")!;
  assert.match(setCookie, /Path=\/dash\/;.*Secure; HttpOnly; SameSite=Strict/);
  assert.ok(!setCookie.includes("device-key"));
  const cookie = setCookie.split(";")[0]!;
  const check = (uri: string, extra = {}) => app.request("https://bf.test/api/kiosk/_check", { headers: { cookie, "x-original-uri": uri, ...extra } });
  assert.equal((await check("/dash/assigned")).status, 200);
  assert.equal((await check("/dash/assigned?theme=dark")).status, 200);
  assert.equal((await check("/dash/assigned/details?view=compact")).status, 200);
  assert.equal((await check("/dash/assets/app.js")).status, 200);
  assert.equal((await check("/dash/other")).status, 403);
  assert.equal((await check("/dash/assigned-other?theme=dark")).status, 403);
  assert.equal((await check("/dash/stale-camera-url")).status, 403);
  assert.equal((await check("/dash/socket.io/?transport=polling")).status, 403);
  assert.equal((await check("/in/kiosk/control")).status, 403);
  assert.equal((await check("/dash/assigned", { origin: "https://evil.test" })).status, 403);
  assert.equal((await check("/dash/assigned", { "sec-fetch-site": "cross-site", origin: "https://evil.test" })).status, 403);
  assert.equal((await app.request("https://bf.test/api/kiosk/bundle", { headers: { cookie } })).status, 401);
  for (const route of ["cameras/private/stream", "firmware/check"]) assert.equal((await app.request(`https://bf.test/api/kiosk/${route}`, { headers: { authorization: "Bearer device-key" } })).status, 403);
  cells[1]!.web_url = "/dash/reassigned";
  assert.equal((await check("/dash/assigned")).status, 403);
  kiosk.key_hash = "rotated";
  assert.equal((await check("/dash/reassigned")).status, 401);
});

test("dashboard assignments normalize web cells and entities without granting the dashboard root", async () => {
  const { repo, kiosk } = fixture();
  for (const entityType of [null, "web", "ablesign"]) {
    for (const [url, expected] of [
      ["/dash/assigned?theme=dark#overview", ["/dash/assigned"]],
      ["/dash/assigned/#overview", ["/dash/assigned"]],
      ["/dash/temporary/../assigned?theme=dark", ["/dash/assigned"]],
      ["/dash/assigned/..?theme=dark", []],
      ["/dash/../../admin?theme=dark", []],
      ["https://other.test/dash/assigned?theme=dark", []],
    ] as const) {
      const assigned = await viewerAssignment({
        ...repo,
        layoutCells: async () => [{ content_type: "web", web_url: url, entity_id: entityType ? "web-entity" : null }],
        getEntityById: async () => ({ id: "web-entity", type: entityType, web_url: url }),
      } as never, kiosk as never);
      assert.deepEqual([...assigned.dashboardPaths], expected, `${entityType ?? "cell"}: ${url}`);
    }
  }
});

test("viewer cannot use raw kiosk cookies while desktop cookie authentication remains compatible", async () => {
  const { repo, secrets, kiosk } = fixture();
  const app = new H3();
  registerViewerDeviceAuth(app, repo as never, { verifyKioskKey: async (key: string) => key === "device-key" ? { id: "viewer", schema_name: "public", tenant_slug: "default" } : null } as never, secrets as never);
  app.get("/api/kiosk/bundle", () => ({ ok: true }));
  const headers = { cookie: "betterframe_kiosk_key=device-key" };
  assert.equal((await app.request("https://bf.test/api/kiosk/bundle", { headers })).status, 403);
  kiosk.capabilities = ["windows"];
  assert.equal((await app.request("https://bf.test/api/kiosk/bundle", { headers })).status, 200);
  kiosk.capabilities = ["linux"];
  assert.equal((await app.request("https://bf.test/api/kiosk/bundle", { headers })).status, 200);
  kiosk.enabled = false;
  assert.equal((await app.request("https://bf.test/api/kiosk/bundle", { headers })).status, 401);
});

test("production bundle and heartbeat routes preserve tenant context and revoke disabled assignments before ETag checks", async () => {
  const { repo: base, secrets, kiosk } = fixture();
  const scope = new AsyncLocalStorage<string>();
  const displays = [(await base.listDisplaysForKiosk())[0]!];
  const updates: Record<string, unknown>[] = [];
  const repo = {
    ...base,
    adapter: { withSearchPath: async (schema: string, fn: () => unknown) => scope.run(schema, fn) },
    getKioskById: async () => { assert.equal(scope.getStore(), "tenant_viewer"); return kiosk; },
    getSetupExtra: async () => null,
    touchKiosk: async () => { assert.equal(scope.getStore(), "tenant_viewer"); },
    listDisplaysForKiosk: async () => displays,
    updateDisplay: async (_id: string, patch: Record<string, unknown>) => { updates.push(patch); Object.assign(displays[0]!, patch); },
    deleteDisplayIfUnused: async () => false,
  };
  const auth = { verifyKioskKey: async (key: string) => key === "device-key" ? { id: "viewer", schema_name: "tenant_viewer", tenant_slug: "tenant-viewer" } : null };
  const app = new H3();
  registerViewerDeviceAuth(app, repo as never, auth as never, secrets as never);
  // Same trailing tenant middleware used by Plugin.init: authenticated kiosk
  // paths must retain the scope wrapping the entire route continuation.
  app.use((event, next) => new URL(event.req.url).pathname.startsWith("/api/kiosk/") ? next() : repo.adapter.withSearchPath("public", next));
  registerKioskRoutes(app, repo as never, auth as never, secrets as never, { forward: () => {} } as never, {} as never, {} as never, { publishTelemetry: () => {} } as never, "");
  const headers = { authorization: "Bearer device-key" };
  const initial = await app.request("https://bf.test/api/kiosk/bundle", { headers });
  assert.equal(initial.status, 200);
  assert.equal(((await initial.json()) as { tenant_slug: string }).tenant_slug, "tenant-viewer");
  assert.equal(initial.headers.get("cache-control"), "private, no-store");
  const etag = initial.headers.get("etag")!;
  assert.equal((await app.request("https://bf.test/api/kiosk/bundle", { headers: { ...headers, "if-none-match": etag } })).status, 304);
  displays[0]!.is_enabled = false;
  const heartbeat = await app.request("https://bf.test/api/kiosk/heartbeat", {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ displays: [{ index: 0, name: "Main", width_px: 1280, height_px: 720, power_state: "awake" }] }),
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(displays[0]!.is_enabled, false);
  assert.ok(updates.length > 0, "exercise actual display update branch");
  const revoked = await app.request("https://bf.test/api/kiosk/bundle", { headers: { ...headers, "if-none-match": etag } });
  assert.equal(revoked.status, 409);
  assert.deepEqual(await revoked.json(), { error: "display_unassigned" });
  kiosk.enabled = false;
  assert.equal((await app.request("https://bf.test/api/kiosk/bundle", { headers: { ...headers, "if-none-match": etag } })).status, 401);
});
