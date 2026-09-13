import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const backupScript = fileURLToPath(new URL("../../deploy/scripts/backup-stack.sh", import.meta.url));

async function backupHarness(failure: string, run: (fixture: {
  output: string; stagingRoot: string; log: string; invoke(): ReturnType<typeof spawnSync>;
}) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bf-backup-test-"));
  const bin = join(dir, "bin");
  const stagingRoot = join(dir, "staging");
  const log = join(dir, "calls.jsonl");
  const output = join(dir, "stack.tar.age");
  try {
    await mkdir(bin); await mkdir(stagingRoot);
    await writeFile(join(bin, "docker"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BF_BACKUP_TEST_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "inspect") {
  process.stdout.write(args.at(-1) === "server-id" ? "true\\n" : "false\\n");
} else if (args[0] === "compose" && args[1] === "ps") {
  process.stdout.write(args.at(-1) + "-id\\n");
} else if (args[0] === "compose" && args[1] === "exec") {
  if (process.env.BF_BACKUP_TEST_FAILURE === "dump") process.exit(17);
  process.stdout.write("test PostgreSQL dump\\n");
} else if (args[0] === "cp") {
  if (process.env.BF_BACKUP_TEST_FAILURE === "copy") process.exit(18);
  const dest = args.at(-1);
  fs.mkdirSync(dest, { recursive: true });
  const server = args[2].startsWith("server-id:");
  fs.writeFileSync(path.join(dest, server ? "secret.key" : "manager-state.json"), server ? "test-only-key" : "{}");
}
`, { mode: 0o700 });
    await writeFile(join(bin, "age"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(args[args.indexOf("-o") + 1], fs.readFileSync(0));
if (process.env.BF_BACKUP_TEST_FAILURE === "encrypt") process.exit(19);
`, { mode: 0o700 });
    await run({ output, stagingRoot, log, invoke: () => spawnSync("bash", [backupScript, output], {
      cwd: dir, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, TMPDIR: stagingRoot,
        BF_BACKUP_TEST_LOG: log, BF_BACKUP_TEST_FAILURE: failure },
    }) });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function assertRestartedOnlyRunningServer(log: string): Promise<void> {
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(calls.filter((args) => args[0] === "compose" && args[1] === "start"), [["compose", "start", "server"]]);
}

test("stack backup captures database and both volumes, then restarts only previously running services", async () => {
  await backupHarness("", async ({ output, stagingRoot, log, invoke }) => {
    const result = invoke();
    assert.equal(result.status, 0, String(result.stderr));
    const archive = spawnSync("tar", ["-tf", output], { encoding: "utf8" });
    assert.equal(archive.status, 0, archive.stderr);
    assert.deepEqual(archive.stdout.trim().split("\n").sort(), [
      "MANIFEST.txt", "postgres.dump", "server-data/", "server-data/secret.key",
      "nodered-data/", "nodered-data/manager-state.json",
    ].sort());
    await assertRestartedOnlyRunningServer(log);
    assert.deepEqual(await readdir(stagingRoot), []);
    await assert.rejects(readFile(`${output}.partial`), { code: "ENOENT" });
  });
});

for (const failure of ["dump", "copy", "encrypt"]) {
  test(`stack backup cleans staging and restores service state after ${failure} failure`, async () => {
    await backupHarness(failure, async ({ output, stagingRoot, log, invoke }) => {
      const result = invoke();
      assert.notEqual(result.status, 0);
      await assertRestartedOnlyRunningServer(log);
      assert.deepEqual(await readdir(stagingRoot), []);
      await assert.rejects(readFile(output), { code: "ENOENT" });
      await assert.rejects(readFile(`${output}.partial`), { code: "ENOENT" });
    });
  });
}

test("stack backup preserves an existing output before touching containers", async () => {
  await backupHarness("", async ({ output, stagingRoot, log, invoke }) => {
    await writeFile(output, "existing archive");
    const result = invoke();
    assert.equal(result.status, 2);
    assert.equal(await readFile(output, "utf8"), "existing archive");
    await assert.rejects(readFile(log), { code: "ENOENT" });
    assert.deepEqual(await readdir(stagingRoot), []);
  });
});
