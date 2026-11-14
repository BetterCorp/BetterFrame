import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { H3 } from "h3";
import { registerAdminRoutes } from "../src/plugins/service-admin-http/routes-admin.js";
import { encryptCameraCredential } from "../src/shared/admin/camera-credentials.js";
import { PgAdapter } from "../src/shared/db/pg-adapter.js";
import { initDb, createTenantSchema } from "../src/shared/db/init.js";
import { TENANT_MIGRATIONS } from "../src/shared/db/migrations-pg.js";
import { tenantSchemaName } from "../src/shared/db/tenant-schema.js";

const url = process.env["BF_TEST_PG_URL"];
const log = { info() {}, warn() {} };
async function database(
  run: (
    opened: Awaited<ReturnType<typeof initDb>>,
    reopen: () => ReturnType<typeof initDb>,
  ) => Promise<void>,
) {
  const admin = new PgAdapter(url!);
  const name = `bf_bp_review_${randomBytes(6).toString("hex")}`;
  const dbUrl = new URL(url!);
  dbUrl.pathname = `/${name}`;
  await admin.exec(`CREATE DATABASE "${name}"`);
  const config = {
    url: dbUrl.toString(),
    host: "",
    port: 5432,
    user: "",
    password: "",
    database: name,
    poolMax: 4,
  };
  const handles: Awaited<ReturnType<typeof initDb>>[] = [];
  const open = async () => {
    const handle = await initDb(config, log);
    const close = handle.close;
    let closed = false;
    handle.close = async () => {
      if (!closed) {
        closed = true;
        await close();
      }
    };
    handles.push(handle);
    return handle;
  };
  try {
    await run(await open(), open);
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
    try {
      await admin.exec(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await admin.close();
    }
  }
}

test(
  "legacy discovery preserves BP ciphertext and encrypts replacement credentials",
  { skip: !url },
  async () =>
    database(async ({ repo }) => {
      const codec = {
        encryptString: (value: string) => `encrypted:${value}`,
        decryptString: (value: string) => value.slice(10),
      };
      repo.setCameraCredentialCodec(codec);
      const secret = encryptCameraCredential(codec, "initial-password");
      const device = await repo.createCameraDevice({
        name: "BP device",
        host: "camera.test",
        port: 80,
        password: secret,
      });
      const camera = await repo.createCamera({
        name: "Device channel",
        type: "onvif",
        device_id: device.id,
        onvif_password: secret,
        rtsp_url: "rtsp://viewer:initial-password@camera.test/stream",
      });
      const app = new H3();
      registerAdminRoutes(app, { repo } as never);
      const discover = (password: string) =>
        app.request("http://bf.test/admin/cameras/discover/add", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            host: device.host,
            port: "80",
            username: "viewer",
            password,
          }).toString(),
        });
      assert.equal((await discover("")).status, 302);
      assert.equal(
        (await repo.adapter.get<{ password: string }>(
          "SELECT password FROM camera_devices WHERE id = ?",
          [device.id],
        ))!.password,
        secret,
        "blank discovery input preserves the exact stored ciphertext",
      );
      const readDevice = await repo.getCameraDeviceByEndpoint(device.host, 80);
      assert.equal(readDevice!.password, "initial-password");
      await repo.updateCameraDevice(device.id, { password: readDevice!.password });
      assert.equal(
        (await repo.adapter.get<{ password: string }>(
          "SELECT password FROM camera_devices WHERE id = ?",
          [device.id],
        ))!.password,
        secret,
        "a decrypted read-model round trip cannot downgrade at-rest protection",
      );
      assert.equal((await discover("replacement-password")).status, 302);
      assert.equal(
        (await repo.adapter.get<{ password: string }>(
          "SELECT password FROM camera_devices WHERE id = ?",
          [device.id],
        ))!.password,
        encryptCameraCredential(codec, "replacement-password"),
      );
      assert.equal(
        (await repo.adapter.get<{ onvif_password: string }>(
          "SELECT onvif_password FROM cameras WHERE id = ?",
          [camera.id],
        ))!.onvif_password,
        encryptCameraCredential(codec, "replacement-password"),
      );
      assert.equal((await repo.getCameraById(camera.id))!.onvif_password, "replacement-password");
      await repo.updateCamera(camera.id, {
        rtsp_url: (await repo.getCameraById(camera.id))!.rtsp_url,
        onvif_password: "camera-replacement",
      });
      const stored = await repo.adapter.get<{ rtsp_url: string; onvif_password: string }>(
        "SELECT rtsp_url,onvif_password FROM cameras WHERE id = ?",
        [camera.id],
      );
      assert.match(stored!.rtsp_url, /^bf-camera:encrypted:rtsp:/);
      assert.equal(stored!.onvif_password, encryptCameraCredential(codec, "camera-replacement"));
      await repo.updateCameraDevice(device.id, { password: null });
      assert.equal(
        (await repo.getCameraDeviceById(device.id))!.password,
        null,
        "explicit clearing still works",
      );
    }),
);

for (const lineage of ["master", "bp-parallel"] as const) {
  test(
    `merged migrations upgrade ${lineage} schemas without losing existing data`,
    { skip: !url },
    async () =>
      database(async (opened, reopen) => {
        const { repo } = opened;
        await repo.createTenant({ name: "Upgrade fixture", slug: "review-upgrade" });
        await createTenantSchema(repo.adapter, "review-upgrade", log);
        const schemas = ["public", tenantSchemaName("review-upgrade")];
        const records = new Map<string, { entity: string; layout: string }>();
        const legacy = {
          login_detect_url: "/legacy",
          steps: [{ type: "click" as const, selector: "#legacy" }],
        };
        const current = {
          login_detect_url: "/configured",
          steps: [{ type: "click" as const, selector: "#configured" }],
        };
        for (const schema of schemas)
          await repo.adapter.withSearchPath(schema, async () => {
            const entity = await repo.createEntity({
              name: "Existing web content",
              type: "web",
              web_url: "http://web.test",
              smart_url_json: lineage === "master" ? current : null,
            });
            const layout = await repo.createLayout({ name: "Existing layout" });
            await repo.createLayoutCell({
              layout_id: layout.id,
              row: 0,
              col: 0,
              entity_id: entity.id,
              options: { smart_url: legacy },
            });
            records.set(schema, { entity: entity.id, layout: layout.id });
            if (lineage === "bp-parallel") {
              // PR #39's deployed pre-merge build had all ownership DDL at versions 151–166.
              await repo.adapter.run(
                "INSERT INTO bp_resource_owners(resource_type,resource_id,owner_issuer,owner_subject) VALUES('layouts',?,'https://auth.test','existing-owner')",
                [layout.id],
              );
              await repo.adapter.exec(
                "ALTER TABLE entities DROP COLUMN smart_url_json; DROP TABLE overlay_templates",
              );
              await repo.adapter.run(
                "DELETE FROM public.schema_migrations WHERE schema_name = ? AND version > 150",
                [schema],
              );
              await repo.adapter.run(
                "INSERT INTO public.schema_migrations(schema_name,version) SELECT ?, generate_series(151,166)",
                [schema],
              );
            } else {
              // Published master used versions 151–153 for entity auth and overlay templates.
              await repo.saveOverlayTemplate({
                id: "existing-overlay",
                name: "Existing overlay",
                html: "<p>{{message}}</p>",
                sample_data: { message: "Keep me" },
              });
              await repo.adapter.exec(
                "DROP TABLE bp_resource_owners; DROP TABLE bp_owner_bootstraps; DROP FUNCTION delete_bp_resource_owner() CASCADE",
              );
              await repo.adapter.run(
                "DELETE FROM public.schema_migrations WHERE schema_name = ? AND version > 153",
                [schema],
              );
            }
          });
        await opened.close();
        const upgraded = await reopen();
        try {
          for (const schema of schemas)
            await upgraded.repo.adapter.withSearchPath(schema, async () => {
              const ids = records.get(schema)!;
              assert.deepEqual(
                (await upgraded.repo.getEntityById(ids.entity))!.smart_url_json,
                lineage === "master" ? current : legacy,
                "auth migration backfills only missing entity configuration",
              );
              assert.equal(
                (await upgraded.repo.getLayoutById(ids.layout))!.name,
                "Existing layout",
              );
              if (lineage === "bp-parallel")
                assert.equal(
                  (await upgraded.repo.adapter.get<{ owner_subject: string }>(
                    "SELECT owner_subject FROM bp_resource_owners WHERE resource_id = ?",
                    [ids.layout],
                  ))!.owner_subject,
                  "existing-owner",
                );
              else
                assert.equal(
                  (await upgraded.repo.getOverlayTemplate("existing-overlay"))!.sample_data.message,
                  "Keep me",
                );
              await upgraded.repo.saveOverlayTemplate({
                id: "new-overlay",
                name: "New overlay",
                html: "<p>Ready</p>",
                sample_data: {},
              });
              assert.ok(await upgraded.repo.getOverlayTemplate("new-overlay"));
              assert.equal(
                (await upgraded.repo.adapter.get<{ version: number }>(
                  "SELECT MAX(version) AS version FROM public.schema_migrations WHERE schema_name = ?",
                  [schema],
                ))!.version,
                TENANT_MIGRATIONS.length,
              );
              await upgraded.repo.deleteLayout(ids.layout);
              assert.equal(
                await upgraded.repo.adapter.get(
                  "SELECT 1 FROM bp_resource_owners WHERE resource_id = ?",
                  [ids.layout],
                ),
                undefined,
                "ownership cleanup triggers remain effective",
              );
            });
        } finally {
          await upgraded.close();
        }
        const restarted = await reopen();
        await restarted.close();
      }),
  );
}
