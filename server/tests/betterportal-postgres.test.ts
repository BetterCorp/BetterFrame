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
import { ensureBpTenant, bindExistingBpTenant, type BpIdentity } from "../src/shared/admin/bp-tenants.js";
import { encryptCameraCredential } from "../src/shared/admin/camera-credentials.js";
import { registry } from "../src/plugins/service-betterportal-frame/.bp-generated/registry.js";
import type { BetterPortalResolvedApp, BetterPortalTenant, JwtClaims } from "@betterportal/framework";
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
      await repo.createUser({ username: "legacy-admin", password_hash: "test-only-hash", role: "admin" });
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
        assert.equal(await repo.countUsers(), 0, "BP provisioning must not create local human users");
        assert.equal(await repo.isSetupComplete(), true);
      });
      // Another BP app under the same tenant uses the same local data scope.
      assert.equal((await ensureBpTenant(repo, "test-bp", identity(ctx.tenant.id))).id, local.id);
      const other = await ensureBpTenant(repo, "test-bp", identity());
      await Promise.all(
        [local, other].map((tenant, i) =>
          repo.adapter.withSearchPath(tenant.schema_name, () => repo.createLayout({ name: `Tenant ${i}` })),
        ),
      );
      const lists = await Promise.all(
        [local, other].map((tenant) =>
          repo.adapter.withSearchPath(tenant.schema_name, () => repo.listLayouts()),
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
        await assert.rejects(ensureBpTenant(repo, "test-bp", invalid), /Verified active/);
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
      await bindExistingBpTenant(repo, "test-bp", migrated.tenant.id, existing.id);
      assert.equal((await ensureBpTenant(repo, "test-bp", migrated)).id, existing.id);
      await bindExistingBpTenant(repo, "test-bp", migrated.tenant.id, existing.id);
      await assert.rejects(bindExistingBpTenant(repo, "test-bp", identity().tenant.id, existing.id));
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
          rtsp_url: encryptCameraCredential(codec, "rtsp://user:password@camera/stream"),
          onvif_password: encryptCameraCredential(codec, "password"),
        });
        const stored = await repo.adapter.get<{ rtsp_url: string; onvif_password: string }>(
          "SELECT rtsp_url,onvif_password FROM cameras WHERE id = ?",
          [camera.id],
        );
        assert.match(stored!.onvif_password, /^bf-camera:encrypted:/);
        assert.match(stored!.rtsp_url, /^bf-camera:encrypted:/);
        assert.equal(camera.onvif_password, "password");
        assert.equal((await repo.listCameras())[0]!.rtsp_url, "rtsp://user:password@camera/stream");
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
      { url: dbUrl.toString(), host: "", port: 5432, user: "", password: "", database: dbName, poolMax: 6 },
      log,
    );
    handle.repo.setCameraCredentialCodec({ decryptString: (value: string) => value.slice(10) });
    const ctx = identity();
    const serviceId = uuidv7();
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
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
          permissions: [{ serviceId, viewId: "frame.layouts", permissions: ["read"] }],
        },
        {
          id: "writer",
          title: "Writer",
          permissions: [
            "frame.layouts",
            "frame.layouts.cells",
            "frame.layouts.cells.detail",
            "frame.cameras",
          ].map((viewId) => ({ serviceId, viewId, permissions: ["read", "create", "update", "delete"] })),
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
    let provisionCalls = 0;
    const plugin = {
      withTenant: async <T>(identity: BpIdentity, fn: (deps: AdminDeps) => Promise<T>) => {
        provisionCalls++;
        const tenant = await ensureBpTenant(handle.repo, "http-bp", identity);
        return handle.repo.adapter.withSearchPath(tenant.schema_name, () =>
          fn({
            repo: handle.repo,
            sandboxMode: true,
            secrets: {
              encryptString: (value: string) => "encrypted:" + value,
              decryptString: (value: string) => value.slice(10),
            },
          } as AdminDeps),
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
      const head = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" })).toString(
        "base64url",
      );
      const body = Buffer.from(JSON.stringify({ ...ctx.user, roles: ["reader"], ...patch })).toString(
        "base64url",
      );
      const signature = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url");
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
      assert.equal((await request("/layouts", token({ roles: [] }))).status, 403);
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
      assert.equal(provisionCalls, 0, "Denied requests must never create local tenant resources");
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
      const cell = await write(`/layouts/${result.id}/cells`, { row: 0, col: 0 });
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
        (await write(`/layouts/${secondId}/cells/${createdCell.id}`, { row: 1, col: 1 }, "PUT")).status,
        404,
        "cell must belong to its parent layout",
      );
      assert.equal(
        (await write(`/layouts/${result.id}/cells/${createdCell.id}`, { row: 1, col: 1 }, "PUT")).status,
        200,
      );
      assert.equal((await write(`/layouts/${result.id}/cells/${createdCell.id}`, {}, "DELETE")).status, 200);
      const audit = handle.repo.insertAudit.bind(handle.repo);
      handle.repo.insertAudit = async () => {
        throw Error("injected audit failure");
      };
      assert.equal((await write("/layouts", { name: "Must roll back" })).status, 500);
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
      const html = await request("/layouts", token(), { headers: { accept: "text/html" } });
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
      assert.throws(() => publishAdminRuntime(new AdminRuntime(config)), /already initialized/);
      assert.equal(runtime.deps.sandboxMode, true);
      runtime.deps.scheduleNoderedReconcile();
      await runtime.deps.repo.adapter.get("SELECT 1");
      unpublishAdminRuntime(runtime);
      await runtime.dispose();
      await runtime.dispose();
      assert.throws(() => getAdminRuntime(), /not ready/);
      const file = join(directory, "not-a-directory");
      await writeFile(file, "test");
      const failed = new AdminRuntime({ ...config, dataDir: join(file, "child") });
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
