import assert from "node:assert/strict";
import test from "node:test";
import { H3 } from "h3";
import { EntitiesPage } from "../src/web-templates/admin-pages.js";
import { initNoderedBridge } from "../src/shared/nodered-bridge.js";
import { registerMiddleware } from "../src/plugins/service-admin-http/middleware.js";
import { syncDashboardsFromNodered } from "../src/plugins/service-admin-http/routes-admin.js";

const page = { id: "page-id", name: "Lobby", hidden: false, basePath: "/dashboard", path: "/dashboard/page1" };

test("dashboard catalog uses authenticated tenant UUID endpoint and surfaces discovery failures", async () => {
  const priorToken = process.env["BF_NODERED_MANAGER_SECRET"];
  const originalFetch = globalThis.fetch;
  process.env["BF_NODERED_MANAGER_SECRET"] = "test-only-dashboard-manager-token-00000000";
  try {
    let failure = false;
    globalThis.fetch = (async (url: string, options: RequestInit) => {
      assert.equal(url, "http://manager/_betterframe/v1/tenants/tenant-id/dashboards");
      assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${process.env["BF_NODERED_MANAGER_SECRET"]}`);
      return failure ? new Response(null, { status: 503 }) : Response.json([page]);
    }) as typeof fetch;
    const bridge = initNoderedBridge({ baseUrl: "http://manager" }, { info() {}, warn() {} });
    assert.deepEqual(await bridge.listDashboards("tenant-id"), [page]);
    failure = true;
    await assert.rejects(bridge.listDashboards("tenant-id"), /503/);
  } finally {
    globalThis.fetch = originalFetch;
    if (priorToken === undefined) delete process.env["BF_NODERED_MANAGER_SECRET"];
    else process.env["BF_NODERED_MANAGER_SECRET"] = priorToken;
  }
});

test("proxy auth checks return HTTP statuses and bind admin sessions to the authorized tenant", async () => {
  const tenant = { id: "a", slug: "a", schema_name: "tenant_a", is_active: true };
  const defaultTenant = { id: "default", slug: "default", schema_name: "public", is_active: true };
  let role = "admin";
  let pending = false;
  const app = new H3();
  registerMiddleware(app, {
    cookieName: "session",
    repo: {
      adapter: { dialect: () => "postgres", withSearchPath: async (_schema: string, fn: () => unknown) => fn() },
      getTenantBySlug: async (slug: string) => slug === "a" ? tenant : defaultTenant,
      isSetupComplete: async () => true,
      getUserByUsername: async () => null,
    },
    auth: { resolveSession: async (cookie: string) => cookie === "valid" ? {
      user: { role, username: "admin" }, tenant: defaultTenant, session: { totp_pending: pending },
    } : null },
  } as never);
  app.get("/api/admin/_check", (event) => new Response(null, {
    status: event.context.user?.role === "admin" ? 200 : 403,
    headers: { "x-betterframe-tenant": event.context.tenant!.id },
  }));
  const request = (cookie?: string) => app.request("http://bf.test/api/admin/_check", { headers: cookie ? { cookie } : {} });
  assert.equal((await request()).status, 401);
  assert.equal((await request("session=expired")).status, 401);
  const accepted = await request("session=valid; bf_tenant=a");
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("x-betterframe-tenant"), "a");
  pending = true;
  assert.equal((await request("session=valid; bf_tenant=a")).status, 401);
  pending = false;
  role = "operator";
  assert.equal((await request("session=valid; bf_tenant=a")).status, 403);
});

test("dashboard sync marks stale IDs unavailable, preserves assignments and restores returning pages", async () => {
  const entities = [
    { id: "e1", type: "dashboard", dashboard_id: page.id, name: "Old name", description: "Unavailable in Node-RED. My own notes" as string | null },
    { id: "e2", type: "dashboard", dashboard_id: "removed", name: "Removed", description: "Notes" as string | null },
  ];
  let pages = [page];
  const deps = {
    nodered: { listDashboards: async (tenantId: string) => { assert.equal(tenantId, "tenant-a"); return pages; } },
    repo: {
      getEntityForDashboard: async (id: string) => entities.find((entity) => entity.dashboard_id === id),
      getEntityByName: async (name: string) => entities.find((entity) => entity.name === name),
      updateEntity: async (id: string, patch: object) => Object.assign(entities.find((entity) => entity.id === id)!, patch),
      listEntities: async () => entities,
      createEntity: async () => { throw new Error("existing page must retain its entity identity"); },
    },
  };
  const first = await syncDashboardsFromNodered(deps as never, "tenant-a");
  assert.equal(first.unavailable, 1);
  assert.equal(entities[0]!.name, "Lobby");
  assert.equal(entities[1]!.description, "Notes");
  assert.equal(entities[0]!.description, "Unavailable in Node-RED. My own notes");
  assert.deepEqual(first.unavailableDashboardIds, ["removed"]);
  assert.equal((await syncDashboardsFromNodered(deps as never, "tenant-a")).updated, 0);
  pages = [page, { ...page, id: "removed", name: "Removed", path: "/dashboard/restored" }];
  assert.equal((await syncDashboardsFromNodered(deps as never, "tenant-a")).unavailable, 0);
  assert.equal(entities[1]!.description, "Notes");
  assert.equal(entities[1]!.id, "e2");
});


test("dashboard availability renders separately and discovery failure remains unknown", () => {
  const entities = [{ id: "e", type: "dashboard", dashboard_id: "missing", name: "Dashboard", description: "Owner notes" }];
  const render = (ids: string[] | null) => String(EntitiesPage({ user: "admin", entities: entities as never, unavailableDashboardIds: ids }));
  assert.match(render(["missing"]), /Unavailable in Node-RED/);
  assert.doesNotMatch(render([]), /Unavailable in Node-RED|Availability unknown/);
  assert.match(render(null), /Availability unknown/);
  assert.equal(entities[0]!.description, "Owner notes");
});
