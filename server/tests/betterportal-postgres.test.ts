import {
  withBpUserAccess,
  assignExistingBpResources,
} from "../src/shared/admin/bp-access.js";
import {
  FrameTenantConfigSchemas,
  userIsolationEnabled,
} from "../src/plugins/service-betterportal-frame/config.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Observable } from "@bsb/base";
import { ConfigSchema } from "../src/plugins/service-admin-http/index.js";
import {
  AdminRuntime,
  publishAdminRuntime,
  getAdminRuntime,
  unpublishAdminRuntime,
} from "../src/shared/admin/runtime.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { uuidv7 } from "uuidv7";
import {
  createBetterPortalApp,
  createBetterPortalNodeHandler,
  createH3Router,
  createStaticJwksVerifier,
} from "@betterportal/framework";
import { PgAdapter } from "../src/shared/db/pg-adapter.js";
import { initDb } from "../src/shared/db/init.js";
import {
  ensureBpTenant,
  bindExistingBpTenant,
  type BpIdentity,
} from "../src/shared/admin/bp-tenants.js";
import { encryptCameraCredential } from "../src/shared/admin/camera-credentials.js";
import { registry } from "../src/plugins/service-betterportal-frame/.bp-generated/registry.js";
import type {
  BetterPortalResolvedApp,
  BetterPortalTenant,
  JwtClaims,
} from "@betterportal/framework";
import type { AdminDeps } from "../src/plugins/service-admin-http/index.js";

const pgUrl = process.env["BF_TEST_PG_URL"];
const log = { info() {}, warn() {} };
function identity(tenantId = uuidv7(), appId = uuidv7()): BpIdentity {
  return {
    tenant: {
      id: tenantId,
      slug: "test",
      title: "Test tenant",
      active: true,
      branding: {},
      services: [],
      activatedPlatformServices: [],
    },
    app: { id: appId, tenantId } as BetterPortalResolvedApp,
    user: {
      sub: "test-user",
      iss: "https://auth.frame.test",
      aud: "frame-tests",
      tenantId,
      appId,
      tokenType: "access",
      realm: "runtime",
      roles: ["admin"],
      jti: uuidv7(),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    },
  };
}

test(
  "BP PostgreSQL first-use provisioning, rollback, mappings, tenant isolation and encrypted credentials",
  { skip: !pgUrl },
  async () => {
    const admin = new PgAdapter(pgUrl!);
    const dbName = `bf_bp_${randomBytes(8).toString("hex")}`;
    await admin.exec(`CREATE DATABASE "${dbName}"`);
    const url = new URL(pgUrl!);
    url.pathname = `/${dbName}`;
    const config = {
      url: url.toString(),
      host: "",
      port: 5432,
      user: "",
      password: "",
      database: dbName,
      poolMax: 8,
    };
    const first = await initDb(config, log);
    const second = await initDb(config, log);
    try {
      const repo = first.repo;
      await repo.createUser({
        username: "legacy-admin",
        password_hash: "test-only-hash",
        role: "admin",
      });
      const ctx = identity();
      let created = 0;
      const scopes = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          ensureBpTenant(i % 2 ? repo : second.repo, "test-bp", ctx, () => {
            created++;
          }),
        ),
      );
      assert.equal(new Set(scopes.map((t) => t.id)).size, 1);
      assert.equal(created, 1);
      const local = scopes[0]!;
      assert.notEqual(local.schema_name, "public");
      await repo.adapter.withSearchPath(local.schema_name, async () => {
        assert.equal(
          await repo.countUsers(),
          0,
          "BP provisioning must not create local human users",
        );
        assert.equal(await repo.isSetupComplete(), true);
      });
      // Another BP app under the same tenant uses the same local data scope.
      assert.equal(
        (await ensureBpTenant(repo, "test-bp", identity(ctx.tenant.id))).id,
        local.id,
      );
      const other = await ensureBpTenant(repo, "test-bp", identity());
      await Promise.all(
        [local, other].map((tenant, i) =>
          repo.adapter.withSearchPath(tenant.schema_name, () =>
            repo.createLayout({ name: `Tenant ${i}` }),
          ),
        ),
      );
      const lists = await Promise.all(
        [local, other].map((tenant) =>
          repo.adapter.withSearchPath(tenant.schema_name, () =>
            repo.listLayouts(),
          ),
        ),
      );
      assert.deepEqual(
        lists.map((l) => l.map((x) => x.name)),
        [["Tenant 0"], ["Tenant 1"]],
      );
      assert.equal((await repo.listLayouts()).length, 0);
      // Revoked and inactive scopes are never recreated or silently reactivated.
      await repo.adapter.run(
        "UPDATE public.bp_tenant_bindings SET state = 'suspended' WHERE frame_tenant_id = ?",
        [local.id],
      );
      await assert.rejects(ensureBpTenant(repo, "test-bp", ctx), /unavailable/);
      await repo.adapter.run(
        "UPDATE public.bp_tenant_bindings SET state = 'ready' WHERE frame_tenant_id = ?",
        [local.id],
      );
      await repo.updateTenant(local.id, { is_active: false });
      await assert.rejects(ensureBpTenant(repo, "test-bp", ctx), /unavailable/);
      await repo.updateTenant(local.id, { is_active: true });
      for (const invalid of [
        { ...ctx, user: undefined },
        { ...ctx, app: { ...ctx.app, id: uuidv7() } },
        { ...ctx, tenant: { ...ctx.tenant, active: false } },
      ]) {
        await assert.rejects(
          ensureBpTenant(repo, "test-bp", invalid),
          /Verified active/,
        );
      }
      const before = (await repo.listTenants()).length;
      const original = repo.markSetupComplete.bind(repo);
      repo.markSetupComplete = async () => {
        throw Error("injected setup failure");
      };
      const failed = identity();
      await assert.rejects(ensureBpTenant(repo, "test-bp", failed), /injected/);
      assert.equal((await repo.listTenants()).length, before);
      repo.markSetupComplete = original;
      await ensureBpTenant(repo, "test-bp", failed);
      const migrated = identity();
      const existing = await repo.getTenantBySlug("default");
      assert.ok(existing);
      await bindExistingBpTenant(
        repo,
        "test-bp",
        migrated.tenant.id,
        existing.id,
      );
      assert.equal(
        (await ensureBpTenant(repo, "test-bp", migrated)).id,
        existing.id,
      );
      await bindExistingBpTenant(
        repo,
        "test-bp",
        migrated.tenant.id,
        existing.id,
      );
      await assert.rejects(
        bindExistingBpTenant(
          repo,
          "test-bp",
          identity().tenant.id,
          existing.id,
        ),
      );
      // Credential readers retain installation encryption without exposing ciphertext to devices.
      const codec = {
        encryptString: (value: string) => `encrypted:${value}`,
        decryptString: (value: string) => {
          assert.match(value, /^encrypted:/);
          return value.slice(10);
        },
      };
      repo.setCameraCredentialCodec(codec);
      await repo.adapter.withSearchPath(local.schema_name, async () => {
        const camera = await repo.createCamera({
          name: "Encrypted",
          type: "rtsp",
          rtsp_url: encryptCameraCredential(
            codec,
            "rtsp://user:password@camera/stream",
          ),
          onvif_password: encryptCameraCredential(codec, "password"),
        });
        const stored = await repo.adapter.get<{
          rtsp_url: string;
          onvif_password: string;
        }>("SELECT rtsp_url,onvif_password FROM cameras WHERE id = ?", [
          camera.id,
        ]);
        assert.match(stored!.onvif_password, /^bf-camera:encrypted:/);
        assert.match(stored!.rtsp_url, /^bf-camera:encrypted:/);
        assert.equal(camera.onvif_password, "password");
        assert.equal(
          (await repo.listCameras())[0]!.rtsp_url,
          "rtsp://user:password@camera/stream",
        );
        await assert.rejects(
          repo.adapter.withSearchPath(other.schema_name, async () => {
            const c = await repo.getCameraById(camera.id);
            assert.ok(c);
          }),
        );
      });
    } finally {
      await first.close();
      await second.close();
      await admin.exec(`DROP DATABASE "${dbName}" WITH (FORCE)`);
      await admin.close();
    }
  },
);

test(
  "BP HTTP enforces JWT, app/tenant and operation permissions before local provisioning",
  { skip: !pgUrl },
  async () => {
    const admin = new PgAdapter(pgUrl!);
    const dbName = `bf_bp_http_${randomBytes(8).toString("hex")}`;
    await admin.exec(`CREATE DATABASE "${dbName}"`);
    const dbUrl = new URL(pgUrl!);
    dbUrl.pathname = `/${dbName}`;
    const handle = await initDb(
      {
        url: dbUrl.toString(),
        host: "",
        port: 5432,
        user: "",
        password: "",
        database: dbName,
        poolMax: 6,
      },
      log,
    );
    handle.repo.setCameraCredentialCodec({
      decryptString: (value: string) => value.slice(10),
    });
    const ctx = identity();
    const serviceId = uuidv7();
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const jwk = {
      ...publicKey.export({ format: "jwk" }),
      kid: "test-key",
      alg: "RS256",
      use: "sig",
    };
    const verifier = createStaticJwksVerifier({
      jwks: { keys: [jwk] } as never,
      expectedIssuer: ctx.user!.iss,
      expectedAudience: "frame-tests",
      expectedTokenType: "access",
    });
    const authConfig = {
      serviceId: uuidv7(),
      expectedIssuer: ctx.user!.iss,
      expectedAudience: "frame-tests",
      roles: [
        {
          id: "reader",
          title: "Reader",
          permissions: [
            { serviceId, viewId: "frame.layouts", permissions: ["read"] },
          ],
        },
        {
          id: "writer",
          title: "Writer",
          permissions: [
            "frame.layouts",
            "frame.layouts.cells",
            "frame.layouts.cells.detail",
            "frame.layouts.clone",
            "frame.cameras",
            "frame.entities",
          ].map((viewId) => ({
            serviceId,
            viewId,
            permissions: ["read", "create", "update", "delete"],
          })),
        },
      ],
    };
    const app = {
      ...ctx.app,
      slug: "frame",
      title: "Frame",
      hostnames: ["frame.test"],
      originOverrides: [],
      refererOverrides: [],
      defaultRoute: "/overview",
      themeConfig: { mode: "system", bootstrap: {}, light: {}, dark: {} },
      shell: { serviceId: uuidv7(), service: "shell", renderer: "bootstrap5" },
      auth: authConfig,
      routes: registry.routes.map((route) => ({
        id: uuidv7(),
        kind: "api",
        path: route.path,
        serviceId,
        viewId: route.viewId,
        targetPath: route.path,
        enabled: true,
        operations: Object.values(route.methodRoutes).map((x) => x.operationId),
      })),
    } as BetterPortalResolvedApp;
    const h3 = createBetterPortalApp();
    h3.use("/**", (event) => {
      Object.assign(event, { __bpApp: app });
    });
    let isolateUsers = false;
    authConfig.roles.push({
      id: "admin",
      title: "Administrator",
      permissions: registry.routes.flatMap((route) =>
        Object.values(route.methodRoutes).flatMap((operation) =>
          (operation.auth?.permissions ?? []).map((grant) => ({
            ...grant,
            serviceId,
          })),
        ),
      ),
    } as never);
    let provisionCalls = 0;
    const plugin = {
      withTenant: async <T>(
        identity: BpIdentity,
        fn: (deps: AdminDeps) => Promise<T>,
      ) => {
        provisionCalls++;
        const tenant = await ensureBpTenant(handle.repo, "http-bp", identity);
        return withBpUserAccess(
          {
            repo: handle.repo,
            sandboxMode: true,
            secrets: {
              encryptString: (value: string) => "encrypted:" + value,
              decryptString: (value: string) => value.slice(10),
            },
          } as AdminDeps,
          identity,
          tenant,
          isolateUsers,
          fn,
        );
      },
    };
    createH3Router(registry, h3, {
      serviceId,
      resolveContext: () => ({ tenant: ctx.tenant, app, plugin }),
      resolveAuth: () => ({
        verifier,
        tenantId: ctx.tenant.id,
        appId: ctx.app.id,
        appAuthConfig: authConfig as never,
        serviceIdAliases: { [serviceId]: "cloud.betterportal.frame" },
      }),
    });
    const server = createServer(createBetterPortalNodeHandler(h3));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const token = (patch: Partial<JwtClaims> = {}) => {
      const head = Buffer.from(
        JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" }),
      ).toString("base64url");
      const body = Buffer.from(
        JSON.stringify({ ...ctx.user, roles: ["reader"], ...patch }),
      ).toString("base64url");
      const signature = sign(
        "RSA-SHA256",
        Buffer.from(`${head}.${body}`),
        privateKey,
      ).toString("base64url");
      return `${head}.${body}.${signature}`;
    };
    const request = (path: string, jwt?: string, init: RequestInit = {}) =>
      fetch(base + path, {
        ...init,
        headers: {
          accept: "application/json",
          ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
          ...init.headers,
        },
      });
    try {
      assert.equal((await request("/layouts")).status, 401);
      for (const claims of [
        { iss: "https://wrong.test" },
        { aud: "wrong" },
        { tenantId: uuidv7() },
        { appId: uuidv7() },
        { exp: 1 },
      ])
        assert.equal((await request("/layouts", token(claims))).status, 401);
      assert.equal(
        (await request("/layouts", token({ roles: [] }))).status,
        403,
      );
      assert.equal(
        (
          await request("/layouts", token(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Forbidden" }),
          })
        ).status,
        403,
      );
      assert.equal(
        provisionCalls,
        0,
        "Denied requests must never create local tenant resources",
      );
      assert.equal((await request("/layouts", token())).status, 200);
      assert.equal(provisionCalls, 1);
      const native = await request("/layouts", token({ roles: ["writer"] }), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name: "HTTP created", priority: "normal" }),
      });
      assert.equal(native.status, 200, await native.clone().text());
      const result = (await native.json()) as { id: string };
      assert.ok(result.id);
      const write = (path: string, body: unknown, method = "POST") =>
        request(path, token({ roles: ["writer"] }), {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const cell = await write(`/layouts/${result.id}/cells`, {
        row: 0,
        col: 0,
      });
      assert.equal(cell.status, 200, await cell.clone().text());
      const createdCell = (await cell.json()) as { id: string };
      assert.equal(
        (await write(`/layouts/${result.id}/cells`, { row: 0, col: 0 })).status,
        409,
        "overlapping cells are rejected",
      );
      const secondLayout = await write("/layouts", { name: "Other" });
      const secondId = ((await secondLayout.json()) as { id: string }).id;
      assert.equal(
        (
          await write(
            `/layouts/${secondId}/cells/${createdCell.id}`,
            { row: 1, col: 1 },
            "PUT",
          )
        ).status,
        404,
        "cell must belong to its parent layout",
      );
      assert.equal(
        (
          await write(
            `/layouts/${result.id}/cells/${createdCell.id}`,
            { row: 1, col: 1 },
            "PUT",
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await write(
            `/layouts/${result.id}/cells/${createdCell.id}`,
            {},
            "DELETE",
          )
        ).status,
        200,
      );
      const audit = handle.repo.insertAudit.bind(handle.repo);
      handle.repo.insertAudit = async () => {
        throw Error("injected audit failure");
      };
      assert.equal(
        (await write("/layouts", { name: "Must roll back" })).status,
        500,
      );
      handle.repo.insertAudit = audit;
      const createCamera = await write("/cameras", {
        name: "Safe camera",
        type: "rtsp",
        rtsp_url: "rtsp://secret-user:secret-password@camera/stream",
      });
      assert.equal(createCamera.status, 200, await createCamera.clone().text());
      const cameras = await request("/cameras", token({ roles: ["writer"] }));
      assert.equal(cameras.status, 200);
      assert.doesNotMatch(
        await cameras.text(),
        /secret-user|secret-password|rtsp_url|onvif_password|key_hash/,
      );

      const list = await request("/layouts", token());
      const data = (await list.json()) as { items: Array<{ name: string }> };
      assert.deepEqual(
        data.items.map((x) => x.name),
        ["HTTP created", "Other"],
      );
      const html = await request("/layouts", token(), {
        headers: { accept: "text/html" },
      });
      assert.equal(html.status, 200);
      const text = await html.text();
      assert.match(text, /HTTP created/);
      assert.doesNotMatch(text, /<!doctype|<html|<body|betterframe_session/i);
      const invalid = await request("/layouts", token({ roles: ["writer"] }), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "", priority: "invalid" }),
      });
      assert.equal(invalid.status, 400);

      const alice = token({ roles: ["writer"] });
      const bob = token({ sub: "other-user", roles: ["writer"] });
      const tenantAdmin = token({ sub: "tenant-admin", roles: ["admin"] });
      const asUser = (
        jwt: string,
        path: string,
        body: unknown,
        method = "POST",
      ) =>
        request(path, jwt, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      assert.equal(
        (await request(`/layouts/${result.id}`, bob)).status,
        200,
        "default internal mode shares data according to BP grants",
      );
      isolateUsers = true;
      assert.deepEqual(
        (
          (await (await request("/layouts", bob)).json()) as {
            items: unknown[];
          }
        ).items,
        [],
      );
      assert.equal((await request(`/layouts/${result.id}`, bob)).status, 404);
      assert.equal(
        (await asUser(bob, `/layouts/${result.id}`, { name: "Stolen" }, "PUT"))
          .status,
        404,
      );
      assert.equal(
        (await asUser(bob, `/layouts/${result.id}`, {}, "DELETE")).status,
        404,
      );
      assert.equal(
        (await asUser(bob, `/layouts/${result.id}/clone`, {})).status,
        404,
      );
      assert.equal(
        (
          await request(
            `/layouts/${result.id}?userIsolationEnabled=false`,
            bob,
            { headers: { "x-frame-admin": "true" } },
          )
        ).status,
        404,
      );
      const bobCreated = await asUser(bob, "/layouts", {
        name: "Bob layout",
        owner_subject: ctx.user!.sub,
      });
      assert.equal(bobCreated.status, 200, await bobCreated.clone().text());
      const bobLayout = (await bobCreated.json()) as { id: string };
      assert.equal(
        (await request(`/layouts/${bobLayout.id}`, alice)).status,
        404,
      );
      assert.equal(
        (await request(`/layouts/${bobLayout.id}`, bob)).status,
        200,
      );
      assert.equal(
        (await request(`/layouts/${bobLayout.id}`, tenantAdmin)).status,
        200,
        "admin ownership bypass is limited to the resolved tenant",
      );
      const adminGrants = authConfig.roles.at(-1)!.permissions;
      authConfig.roles.at(-1)!.permissions = [];
      assert.equal(
        (await request(`/layouts/${bobLayout.id}`, tenantAdmin)).status,
        403,
        "admin ownership access never bypasses BP route grants",
      );
      authConfig.roles.at(-1)!.permissions = adminGrants;
      const aliceCamera = (
        (await (await request("/cameras", alice)).json()) as {
          items: { id: string }[];
        }
      ).items[0]!;
      const bobChoices = await (await request("/entities", bob)).json() as {canUseNodeRed:boolean;cameras:{id:string}[]};
      assert.equal(bobChoices.canUseNodeRed,false);
      assert.ok(!bobChoices.cameras.some(camera=>camera.id===aliceCamera.id),"camera picker cannot leak another user's cameras");
      const adminChoices = await (await request("/entities",tenantAdmin)).json() as {canUseNodeRed:boolean};
      assert.equal(adminChoices.canUseNodeRed,true);
      assert.equal(
        (
          await asUser(bob, "/entities", {
            name: "Foreign camera",
            type: "camera",
            camera_id: aliceCamera.id,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await asUser(bob, "/entities", {
            name: "Forbidden Node-RED",
            type: "dashboard",
            dashboard_id: "tab",
          })
        ).status,
        403,
      );
      const aliceEntity = await asUser(alice, "/entities", {
        name: "Alice content",
        type: "html",
        html_content: "Private",
      });
      assert.equal(aliceEntity.status, 200, await aliceEntity.clone().text());
      const aliceEntityId = ((await aliceEntity.json()) as { id: string }).id;
      assert.equal(
        (
          await asUser(bob, `/layouts/${bobLayout.id}/cells`, {
            row: 0,
            col: 0,
            entity_id: aliceEntityId,
          })
        ).status,
        404,
      );
      isolateUsers = false;
      assert.equal(
        (await request(`/layouts/${result.id}`, bob)).status,
        200,
        "tenant switch restores shared mode without changing ownership",
      );
      assert.equal(
        (
          await asUser(bob, "/entities", {
            name: "Still forbidden Node-RED",
            type: "dashboard",
            dashboard_id: "tab",
          })
        ).status,
        403,
      );
      isolateUsers = true;
      assert.equal((await request(`/layouts/${result.id}`, bob)).status, 404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await handle.close();
      await admin.exec(`DROP DATABASE "${dbName}" WITH (FORCE)`);
      await admin.close();
    }
  },
);

test(
  "shared admin runtime starts once, keeps sandbox effects disabled, and closes after partial failure",
  { skip: !pgUrl },
  async () => {
    const admin = new PgAdapter(pgUrl!);
    const name = `bf_bp_runtime_${randomBytes(8).toString("hex")}`;
    await admin.exec(`CREATE DATABASE "${name}"`);
    const url = new URL(pgUrl!);
    url.pathname = `/${name}`;
    const directory = await mkdtemp(join(tmpdir(), "frame-bp-runtime-"));
    const obs = { log: { info() {}, warn() {} } } as unknown as Observable;
    const config = ConfigSchema.parse({
      db: { url: url.toString() },
      dataDir: directory,
      sandboxMode: true,
      noderedUrl: "http://127.0.0.1:9",
    });
    const runtime = new AdminRuntime(config);
    try {
      await runtime.init(obs);
      await runtime.run(obs);
      publishAdminRuntime(runtime);
      assert.equal(getAdminRuntime(), runtime);
      assert.throws(
        () => publishAdminRuntime(new AdminRuntime(config)),
        /already initialized/,
      );
      assert.equal(runtime.deps.sandboxMode, true);
      runtime.deps.scheduleNoderedReconcile();
      await runtime.deps.repo.adapter.get("SELECT 1");
      unpublishAdminRuntime(runtime);
      await runtime.dispose();
      await runtime.dispose();
      assert.throws(() => getAdminRuntime(), /not ready/);
      const file = join(directory, "not-a-directory");
      await writeFile(file, "test");
      const failed = new AdminRuntime({
        ...config,
        dataDir: join(file, "child"),
      });
      await assert.rejects(failed.init(obs));
      const connections = await admin.get<{ count: string }>(
        "SELECT count(*) FROM pg_stat_activity WHERE datname = ?",
        [name],
      );
      assert.equal(
        Number(connections!.count),
        0,
        "failed initialization and disposal release their database pools",
      );
    } finally {
      unpublishAdminRuntime(runtime);
      await runtime.dispose();
      await admin.exec(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("every BP operation requires BP authentication and an explicit permission", () => {
  for (const route of registry.routes)
    for (const operation of Object.values(route.methodRoutes)) {
      assert.equal(operation.auth?.required, true, operation.operationId);
      assert.ok(operation.auth?.permissions.length, operation.operationId);
      for (const grant of operation.auth!.permissions)
        assert.equal(grant.serviceId, "cloud.betterportal.frame");
    }
});

test("user isolation is a protected BP tenant setting, false by default", () => {
  assert.equal(userIsolationEnabled({}), false);
  assert.equal(userIsolationEnabled({ userIsolationEnabled: false }), false);
  assert.equal(userIsolationEnabled({ userIsolationEnabled: true }), true);
  assert.throws(
    () => userIsolationEnabled({ userIsolationEnabled: "false" }),
    /must be boolean/,
  );
  const descriptor = FrameTenantConfigSchemas[0]!;
  assert.equal(descriptor.scope, "tenant");
  assert.equal(descriptor.fields[0]!.defaultValue, false);
  assert.equal(descriptor.fields[0]!.visibility, "protected");
});

test(
  "BP ownership adoption, inherited device data, histories, relationships and Node-RED stay isolated",
  { skip: !pgUrl },
  async () => {
    const admin = new PgAdapter(pgUrl!);
    const dbName = `bf_bp_users_${randomBytes(8).toString("hex")}`;
    await admin.exec(`CREATE DATABASE "${dbName}"`);
    const url = new URL(pgUrl!);
    url.pathname = `/${dbName}`;
    const handle = await initDb(
      {
        url: url.toString(),
        host: "",
        port: 5432,
        user: "",
        password: "",
        database: dbName,
        poolMax: 8,
      },
      log,
    );
    try {
      const root = identity();
      root.user!.sub = "tenant-admin";
      const alice = {
        ...root,
        user: { ...root.user!, sub: "alice", roles: ["operator"] },
      };
      const bob = {
        ...root,
        user: { ...root.user!, sub: "bob", roles: ["operator"] },
      };
      const tenant = await ensureBpTenant(handle.repo, "users-test", root);
      let nodeCalls = 0;
      const deps = {
        repo: handle.repo,
        sandboxMode: true,
        nodered: {
          async listDashboards() {
            nodeCalls++;
            return [];
          },
          forward() {},
        },
      } as unknown as AdminDeps;
      const as = <T>(
        ctx: BpIdentity,
        isolate: boolean,
        fn: (deps: AdminDeps) => Promise<T>,
      ) => withBpUserAccess(deps, ctx, tenant, isolate, fn);
      const inTenant = <T>(fn: () => Promise<T>) =>
        handle.repo.adapter.withSearchPath(tenant.schema_name, fn);
      const a = await inTenant(async () => {
        const kiosk = await handle.repo.createKiosk({
          name: "Alice kiosk",
          key_hash: "test",
          key_prefix: "test-a",
        });
        const display = await handle.repo.createDisplayForKiosk(kiosk.id, {
          name: "Alice screen",
        });
        const camera = await handle.repo.createCamera({
          name: "Alice camera",
          type: "rtsp",
          rtsp_url: "rtsp://test/stream",
        });
        const layout = await handle.repo.createLayout({ name: "Alice layout" });
        const label = await handle.repo.createLabel({ name: "Alice label" });
        return { kiosk, display, camera, layout, label };
      });
      const owner = { issuer: alice.user!.iss, subject: alice.user!.sub };
      const adopted = await assignExistingBpResources(
        handle.repo,
        tenant.schema_name,
        "existing-owner",
        owner,
      );
      assert.equal(adopted.kiosks, 1);
      assert.equal(adopted.cameras, 1);
      assert.equal(
        (await as(alice, true, (d) => d.repo.listKiosks())).length,
        1,
      );
      assert.equal((await as(bob, true, (d) => d.repo.listKiosks())).length, 0);
      assert.equal(
        (await as(bob, false, (d) => d.repo.listKiosks())).length,
        1,
      );
      assert.equal(
        (await as(root, true, (d) => d.repo.listKiosks())).length,
        1,
      );
      const collision = {
        ...alice,
        user: { ...alice.user!, iss: "https://another-provider.test" },
      };
      assert.equal(
        (await as(collision, true, (d) => d.repo.listCameras())).length,
        0,
        "same subject from another issuer is not the owner",
      );
      const b = await as(bob, true, async (d) => {
        const kiosk = await d.repo.createKiosk({
          name: "Bob kiosk",
          key_hash: "test",
          key_prefix: "test-b",
        });
        const device = await d.repo.createCameraDevice({
          name: "Bob device",
          host: "camera.test",
          port: 80,
        });
        const camera = await d.repo.createCamera({
          name: "Bob channel",
          type: "onvif",
          device_id: device.id,
        });
        const layout = await d.repo.createLayout({ name: "Bob layout" });
        const label = await d.repo.createLabel({ name: "Bob label" });
        return { kiosk, device, camera, layout, label };
      });
      const freshDisplay = await inTenant(() =>
        handle.repo.createDisplayForKiosk(b.kiosk.id, {
          name: "Device-created second screen",
          skipTenantDefaults: true,
        }),
      );
      const channel = await inTenant(() =>
        handle.repo.createCamera({
          name: "Background discovered channel",
          type: "onvif",
          device_id: b.device.id,
        }),
      );
      assert.equal(
        (await as(bob, true, (d) => d.repo.listDisplays())).some(
          (d) => d.id === freshDisplay.id,
        ),
        true,
        "future fleet-created displays inherit kiosk ownership",
      );
      assert.equal(
        (await as(bob, true, (d) => d.repo.listCameras())).length,
        2,
        "discovered channels inherit device ownership",
      );
      assert.equal(
        (await as(alice, true, (d) => d.repo.listCameras())).some(
          (c) => c.id === channel.id,
        ),
        false,
      );
      assert.equal(
        (await as(bob, true, (d) => d.repo.listEntities())).length,
        2,
        "camera entity mirrors inherit camera ownership",
      );
      await assert.rejects(
        as(bob, true, (d) =>
          d.repo.updateKiosk(a.kiosk.id, { name: "stolen" }),
        ),
        { statusCode: 404 },
      );
      await assert.rejects(
        as(bob, true, (d) =>
          d.repo.attachLayoutToDisplay(freshDisplay.id, a.layout.id),
        ),
        { statusCode: 404 },
      );
      await assert.rejects(
        as(root, true, (d) =>
          d.repo.attachLayoutToDisplay(freshDisplay.id, a.layout.id),
        ),
        { statusCode: 409 },
      );
      await assert.rejects(
        as(bob, true, (d) =>
          d.repo.attachKioskLabel(b.kiosk.id, a.label.id, "consume"),
        ),
        { statusCode: 404 },
      );
      await as(bob, true, (d) =>
        d.repo.attachKioskLabel(b.kiosk.id, b.label.id, "consume"),
      );
      await assert.rejects(
        as(bob, false, (d) => d.nodered.listDashboards(tenant.id)),
        { statusCode: 403 },
      );
      assert.equal(nodeCalls, 0);
      await as(root, true, (d) => d.nodered.listDashboards(tenant.id));
      assert.equal(nodeCalls, 1);
      await assert.rejects(
        as(root, true, (d) => d.repo.adapter.all("SELECT * FROM cameras")),
        /not allowed/,
      );
      await assert.rejects(
        as(bob, false, (d) => d.repo.countUsers()),
        /no resource access policy/,
      );
      await inTenant(async () => {
        for (const [id, kiosk, camera] of [
          ["alice-event", a.kiosk.id, a.camera.id],
          ["bob-event", b.kiosk.id, b.camera.id],
          ["mixed-event", b.kiosk.id, a.camera.id],
        ] as const)
          await handle.repo.adapter.run(
            "INSERT INTO event_log(id,source_kiosk_id,source_camera_id,source_type,topic) VALUES(?,?,?,'synthetic',?)",
            [id, kiosk, camera, id],
          );
        await handle.repo.insertKioskLogs(a.kiosk.id, [
          { level: "info", message: "Alice private 1" },
          { level: "info", message: "Alice private 2" },
        ]);
        await handle.repo.insertKioskLogs(b.kiosk.id, [
          { level: "info", message: "Bob private" },
        ]);
      });
      const ae = await as(alice, true, (d) => d.repo.queryEvents({ limit: 1 }));
      const be = await as(bob, true, (d) => d.repo.queryEvents({ limit: 1 }));
      assert.equal(ae.total, 1);
      assert.equal(ae.events[0]!.id, "alice-event");
      assert.equal(be.total, 1);
      assert.equal(be.events[0]!.id, "bob-event");
      const filters = {
        until: new Date(Date.now() + 60000).toISOString(),
        limit: 1,
      };
      const logs = await as(bob, true, (d) => d.repo.queryKioskLogs(filters));
      assert.equal(logs.logs.length, 1);
      assert.equal(logs.logs[0]!.kiosk_id, b.kiosk.id);
      assert.equal(logs.hasMore, false);
      const aliceLog = (
        await as(alice, true, (d) => d.repo.queryKioskLogs(filters))
      ).logs[0]!;
      assert.equal(
        await as(bob, true, (d) => d.repo.getKioskLog(aliceLog.id)),
        null,
      );
      await as(alice, true, (d) =>
        d.repo.insertAudit({
          actor_type: "user",
          actor_id: "alice",
          actor_label: "Alice",
          action: "frame.layouts.update",
          resource_type: "layouts",
          resource_id: a.layout.id,
          ip: null,
          metadata: { bp_issuer: owner.issuer },
          result: "ok",
        }),
      );
      assert.equal((await as(bob, true, (d) => d.repo.listAudit())).length, 0);
      assert.equal(
        (await as(alice, true, (d) => d.repo.listAudit())).length,
        1,
      );
      const later = await inTenant(() =>
        handle.repo.createLayout({ name: "Unowned later resource" }),
      );
      assert.deepEqual(
        await assignExistingBpResources(
          handle.repo,
          tenant.schema_name,
          "existing-owner",
          owner,
        ),
        {},
        "ownership adoption runs once",
      );
      assert.equal(
        await as(alice, true, (d) => d.repo.getLayoutById(later.id)),
        null,
      );
      assert.ok(await as(root, true, (d) => d.repo.getLayoutById(later.id)));
      await inTenant(() => handle.repo.deleteLayout(b.layout.id));
      assert.equal(
        await inTenant(() =>
          handle.repo.adapter.get(
            "SELECT 1 FROM bp_resource_owners WHERE resource_type='layouts' AND resource_id=?",
            [b.layout.id],
          ),
        ),
        undefined,
        "legacy deletions clean up ownership too",
      );
    } finally {
      await handle.close();
      await admin.exec(`DROP DATABASE "${dbName}" WITH (FORCE)`);
      await admin.close();
    }
  },
);
