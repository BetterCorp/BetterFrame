import assert from "node:assert/strict";
import test from "node:test";
import { H3 } from "h3";

import { registerMiddleware } from "../src/plugins/service-admin-http/middleware.js";
import { registerAuthRoutes } from "../src/plugins/service-admin-http/routes-auth.js";
import { registerAccountRoutes } from "../src/plugins/service-admin-http/routes-account.js";
import { createTenantSchema } from "../src/shared/db/init.js";
import { withDefaultTenant } from "../src/shared/default-tenant.js";
import { quotedSchema } from "../src/shared/db/platform-admin.js";
import { Repository } from "../src/shared/db/repository.js";
import type { Session, Tenant, User } from "../src/shared/types.js";
import { AccountPage } from "../src/web-templates/admin-pages.js";

const defaultTenant: Tenant = {
  id: "default-id",
  name: "Default",
  slug: "default",
  schema_name: "public",
  is_active: true,
  max_kiosks: null,
  max_cameras: null,
  max_users: null,
  created_at: new Date(0).toISOString(),
};

const tenant: Tenant = {
  ...defaultTenant,
  id: "tenant-id",
  name: "Tenant",
  slug: "tenant",
  schema_name: "tenant_tenant",
};

const admin: User = {
  id: "admin-id",
  username: "admin",
  password_hash: "hash",
  role: "admin",
  is_active: true,
  totp_enabled: false,
  totp_secret_encrypted: null,
  recovery_codes_hashed: [],
  must_change_password: false,
  failed_login_count: 0,
  locked_until: null,
  last_login_at: null,
  created_at: new Date(0).toISOString(),
};

const session: Session = {
  id: "session-id",
  user_id: admin.id,
  csrf_token: "csrf",
  totp_pending: false,
  user_agent: null,
  ip_address: null,
  issued_at: new Date(0).toISOString(),
  last_seen_at: new Date(0).toISOString(),
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  revoked_at: null,
};

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

test("login ignores stale tenant selectors", async () => {
  const searchPaths: string[] = [];
  const app = new H3();
  registerMiddleware(app, {
    cookieName: "betterframe_session",
    repo: {
      adapter: {
        dialect: () => "postgres",
        withSearchPath: async (schema: string, fn: () => unknown) => {
          searchPaths.push(schema);
          return fn();
        },
      },
      getTenantBySlug: async (slug: string) => slug === "tenant" ? tenant : defaultTenant,
      isSetupComplete: async () => true,
    },
  } as never);
  app.get("/auth/login", (event) => ({ tenant: event.context.tenant?.slug }));

  const response = await app.request("http://betterframe.test/auth/login", {
    headers: {
      cookie: "bf_tenant=tenant",
      "x-betterframe-tenant": "tenant",
    },
  });

  assert.deepEqual(await response.json(), { tenant: "default" });
  assert.deepEqual(searchPaths, ["public"]);
});

test("legacy tenant admin sessions clear browser state instead of returning 403", async () => {
  let revoked = "";
  const app = new H3();
  registerMiddleware(app, {
    cookieName: "betterframe_session",
    repo: {
      adapter: {
        dialect: () => "postgres",
        withSearchPath: async (_schema: string, fn: () => unknown) => fn(),
      },
      getTenantBySlug: async (slug: string) => slug === "tenant" ? tenant : defaultTenant,
      isSetupComplete: async () => true,
    },
    auth: {
      resolveSession: async () => ({ user: admin, session, tenant }),
      revokeSession: async (id: string) => { revoked = id; },
    },
  } as never);
  app.get("/admin/tenants", () => new Response("unexpected"));

  const response = await app.request("http://betterframe.test/admin/tenants", {
    headers: { cookie: "betterframe_session=signed; bf_tenant=tenant" },
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/auth/login");
  assert.equal(revoked, session.id);
  assert.deepEqual(
    setCookies(response).map((cookie) => cookie.split("=", 1)[0]),
    ["betterframe_session", "betterframe_csrf", "bf_tenant"],
  );
});

test("logout clears session, CSRF, and tenant cookies", async () => {
  const app = new H3();
  registerAuthRoutes(app, { cookieName: "betterframe_session" } as never);

  const response = await app.request("http://betterframe.test/auth/logout", { method: "POST" });

  assert.equal(response.status, 302);
  assert.deepEqual(
    setCookies(response).map((cookie) => cookie.split("=", 1)[0]),
    ["betterframe_session", "betterframe_csrf", "bf_tenant"],
  );
});

test("tenant schema bootstrap mirrors platform admins", async () => {
  const writes: string[] = [];
  const adapter = {
    exec: async () => {},
    setSearchPath: async () => {},
    get: async () => ({ version: Number.MAX_SAFE_INTEGER }),
    run: async (sql: string) => {
      writes.push(sql);
      return { lastInsertRowid: 0n, changes: 0 };
    },
  };

  await createTenantSchema(adapter as never, "tenant", { info: () => {}, warn: () => {} });

  assert.equal(writes.length, 2);
  assert.match(writes[0]!, /UPDATE "tenant_tenant"\.users/);
  assert.match(writes[0]!, /target\.username = source\.username/);
  assert.match(writes[1]!, /INSERT INTO "tenant_tenant"\.users/);
  assert.throws(() => quotedSchema("tenant;drop schema public"), /invalid schema name/);
});

test("sub-tenant account page only offers a switch to Default", () => {
  const html = String(AccountPage({ user: "admin", totpEnabled: true, rootRequired: true }));

  assert.match(html, /Default tenant required/);
  assert.match(html, /name="tenant_slug" value="default"/);
  assert.doesNotMatch(html, /Change Password/);
  assert.doesNotMatch(html, /Disable 2FA/);
});

test("sub-tenant account mutations are rejected before changing credentials", async () => {
  let updated = false;
  const app = new H3();
  registerAccountRoutes(app, {
    repo: {
      updatePlatformAdmin: async () => { updated = true; },
    },
  } as never);

  const response = await app.request(
    "http://betterframe.test/admin/account/password",
    { method: "POST" },
    { user: admin, tenant },
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin/account");
  assert.equal(updated, false);
});

test("platform admin updates run in one transaction and mirror every tenant", async () => {
  const writes: string[] = [];
  let transactions = 0;
  const adapter = {
    dialect: () => "postgres",
    get: async (sql: string) => sql.includes("public.users") ? { username: "admin" } : undefined,
    all: async () => [defaultTenant, tenant],
    run: async (sql: string) => {
      writes.push(sql);
      return { lastInsertRowid: 0n, changes: 1 };
    },
    transaction: async (fn: () => unknown) => {
      transactions += 1;
      return fn();
    },
  };
  const repo = new Repository(adapter as never, async () => {});

  await repo.updatePlatformAdmin(admin.id, { totp_enabled: true });

  assert.equal(transactions, 1);
  assert.match(writes[0]!, /UPDATE public\.users SET totp_enabled = \?/);
  assert.match(writes[1]!, /UPDATE "tenant_tenant"\.users/);
  assert.match(writes[2]!, /INSERT INTO "tenant_tenant"\.users/);
});

test("audit inserts provide the required entry id", async () => {
  let insert: { sql: string; params?: readonly unknown[] } | undefined;
  const adapter = {
    dialect: () => "postgres",
    run: async (sql: string, params?: readonly unknown[]) => {
      insert = { sql, params };
      return { lastInsertRowid: 0n, changes: 1 };
    },
  };
  const repo = new Repository(adapter as never, async () => {});

  await repo.insertAudit({
    actor_type: "user",
    actor_id: "user-1",
    actor_label: "admin",
    action: "test.action",
    resource_type: null,
    resource_id: null,
    ip: null,
    metadata: {},
    result: "success",
  });

  assert.match(insert!.sql, /\(id, actor_type/);
  assert.equal(insert!.params?.length, 10);
  assert.equal(typeof insert!.params?.[0], "string");
});

test("default-tenant queries use a scoped search path", async () => {
  const calls: string[] = [];
  const repo = {
    adapter: {
      dialect: () => "postgres",
      setSearchPath: async () => { throw new Error("must not mutate the caller context"); },
      withSearchPath: async (_schema: string, fn: () => Promise<string>) => {
        calls.push(_schema);
        return fn();
      },
    },
  };

  assert.equal(await withDefaultTenant(repo as never, "tenant_site", async () => "ok"), "ok");
  assert.deepEqual(calls, ["public"]);
});
