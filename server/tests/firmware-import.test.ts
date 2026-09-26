import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initFirmware } from "../src/shared/firmware.js";
import { H3 } from "h3";
import { initDb } from "../src/shared/db/init.js";
import { PgAdapter } from "../src/shared/db/pg-adapter.js";
import { Repository } from "../src/shared/db/repository.js";
import { registerFirmwareRoutes } from "../src/plugins/service-admin-http/routes-firmware.js";
import type { AdminDeps } from "../src/plugins/service-admin-http/index.js";

test("firmware HTTP imports safely retry, reject conflicts and serialize concurrent registration", { skip: !process.env["BF_TEST_PG_URL"] }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "bf-firmware-import-"));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  const admin = new PgAdapter(process.env["BF_TEST_PG_URL"]!);
  const dbName = `bf_firmware_${randomBytes(8).toString("hex")}`;
  await admin.exec(`CREATE DATABASE "${dbName}"`);
  const url = new URL(process.env["BF_TEST_PG_URL"]!); url.pathname = `/${dbName}`;
  let close: (() => Promise<void>) | undefined;
  try {
    const handle = await initDb({url: url.toString(), host: "", port: 5432, user: "", password: "", database: dbName, poolMax: 8}, {info() {}, warn() {}});
    close = handle.close;
    const notifications: string[] = [];
    const repo = new Repository(handle.repo.adapter, async (table) => { notifications.push(table); });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const firmware = initFirmware({dataDir, signingKeyPem: privateKey.export({format: "pem", type: "pkcs8"}).toString()}, {info() {}, warn() {}});
    const app = new H3();
    registerFirmwareRoutes(app, {
      repo,
      clientFirmwarePublicKey: publicKey.export({format: "pem", type: "spki"}).toString(),
      firmware,
    } as unknown as AdminDeps);
    const payload = (content = "signed firmware") => {
      const bytes = Buffer.from(content);
      const hash = createHash("sha256").update(bytes).digest("hex");
      return {version: "1.0.13", channel: "dev", target: "betterframe-pc-x86_64", content_b64: bytes.toString("base64"),
        signature: sign(null, Buffer.from(hash), privateKey).toString("base64url"), release_notes: "original"};
    };
    const request = (body: ReturnType<typeof payload>) => app.request("http://bf.test/api/admin/firmware/import", {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body),
    });
    const first = await request(payload());
    assert.equal(first.status, 200);
    const original = await first.json();
    const stored = await repo.getFirmwareRelease(original.release_id);
    const retry = await request({...payload(), release_notes: "retry must not change metadata"});
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), original);
    assert.deepEqual(await repo.getFirmwareRelease(original.release_id), stored);
    assert.equal(notifications.filter(table => table === "firmware_releases").length, 1);

    assert.equal((await request(payload("different signed firmware"))).status, 409);
    assert.equal((await request({...payload(), channel: "stable"})).status, 409);
    assert.equal((await request({...payload(), signature: "invalid"})).status, 400);
    assert.deepEqual(await repo.getFirmwareRelease(original.release_id), stored);

    const concurrent = await Promise.all(Array.from({length: 8}, () => request({...payload(), version: "1.0.14"})));
    for (const response of concurrent) assert.equal(response.status, 200);
    const ids = await Promise.all(concurrent.map(async (response) => (await response.json()).release_id));
    assert.equal(new Set(ids).size, 1);
    assert.equal((await repo.listFirmwareReleases()).length, 2);
    assert.equal(notifications.filter(table => table === "firmware_releases").length, 2);
    for (const release of await repo.listFirmwareReleases()) {
      assert.deepEqual(await firmware.readBlob(release.artifact_path, release.sha256), Buffer.from("signed firmware"));
    }
    assert.ok((await readdir(firmware.firmwareDir())).every(name => name.endsWith(".bin")));

    const windows = await request({...payload("signed MSI bytes"), target: "windows-x64"});
    assert.equal(windows.status, 200);
    const windowsRelease = await repo.getFirmwareRelease((await windows.json()).release_id);
    assert.equal(windowsRelease?.arch, "windows-x64");
    assert.deepEqual(await firmware.readBlob(windowsRelease!.artifact_path, windowsRelease!.sha256), Buffer.from("signed MSI bytes"));

    await repo.yankFirmwareRelease(original.release_id);
    assert.equal((await request(payload())).status, 409);
    assert.ok((await repo.getFirmwareRelease(original.release_id))?.yanked_at);
  } finally {
    await close?.();
    await admin.exec(`DROP DATABASE "${dbName}" WITH (FORCE)`);
    await admin.close();
  }
});
