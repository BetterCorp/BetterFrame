/**
 * Schema export.
 *
 * Run: `npm run schemas:export` (after build) — writes every registered
 * anyvali schema to /schemas/<key>.av.json. The output is portable: Rust kiosk
 * + Node-RED nodes + the browser (via vendored @anyvali/js) all consume these
 * exact files.
 *
 * Also copies the JSON into server/src/web-static/schemas/ so the browser
 * fetches them via /static/schemas/<key>.av.json with no extra plumbing.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { schemas, type SchemaKey } from "../schemas/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname here is server/lib/scripts after build; want the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..");
const CANONICAL_DIR = join(REPO_ROOT, "schemas");
const STATIC_DIR = join(REPO_ROOT, "server", "src", "web-static", "schemas");

function freshDir(p: string): void {
  rmSync(p, { recursive: true, force: true });
  mkdirSync(p, { recursive: true });
}

function exportAll(): void {
  freshDir(CANONICAL_DIR);
  freshDir(STATIC_DIR);

  let count = 0;
  for (const key of Object.keys(schemas) as SchemaKey[]) {
    const doc = schemas[key].export("portable");
    const json = JSON.stringify(doc, null, 2) + "\n";
    const file = `${key}.av.json`;
    writeFileSync(join(CANONICAL_DIR, file), json, "utf-8");
    writeFileSync(join(STATIC_DIR, file), json, "utf-8");
    count += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`Exported ${count} schemas to:`);
  // eslint-disable-next-line no-console
  console.log(`  ${CANONICAL_DIR}`);
  // eslint-disable-next-line no-console
  console.log(`  ${STATIC_DIR}`);
}

exportAll();
