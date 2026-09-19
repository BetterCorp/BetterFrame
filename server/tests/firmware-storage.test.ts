import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initFirmware } from "../src/shared/firmware.js";

const log = { info() {}, warn() {} };

test("concurrent firmware writers publish identical complete blobs without shared staging files", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "bf-firmware-storage-"));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  const writers = [initFirmware({dataDir}, log), initFirmware({dataDir}, log)];
  const bytes = Buffer.alloc(256 * 1024, 0x5a);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const results = await Promise.allSettled(Array.from({length: 16}, (_, i) => writers[i % 2]!.storeBlob(bytes, hash)));
  for (const result of results) assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : "");
  const paths = results.map(result => result.status === "fulfilled" ? result.value : "");
  assert.equal(new Set(paths).size, 1);
  assert.deepEqual(await writers[0]!.readBlob(paths[0]!, hash), bytes);
  assert.deepEqual(await readdir(writers[0]!.firmwareDir()), [`${hash}.bin`]);
});

test("failed firmware publication cleans its staging files and preserves the destination", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "bf-firmware-storage-"));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  const firmware = initFirmware({dataDir}, log);
  const bytes = Buffer.from("firmware");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await mkdir(join(firmware.firmwareDir(), `${hash}.bin`));
  await assert.rejects(firmware.storeBlob(bytes, hash));
  assert.deepEqual(await readdir(firmware.firmwareDir()), [`${hash}.bin`]);
});
