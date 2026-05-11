import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(__dirname, "..", "..");
const SRC_STATIC_DIR = join(SERVER_ROOT, "src", "web-static");
const LIB_STATIC_DIR = join(SERVER_ROOT, "lib", "web-static");

if (!existsSync(SRC_STATIC_DIR)) {
  throw new Error(`Static asset source not found: ${SRC_STATIC_DIR}`);
}

rmSync(LIB_STATIC_DIR, { recursive: true, force: true });
mkdirSync(LIB_STATIC_DIR, { recursive: true });
cpSync(SRC_STATIC_DIR, LIB_STATIC_DIR, { recursive: true });

// eslint-disable-next-line no-console
console.log(`Copied web-static assets to ${LIB_STATIC_DIR}`);
