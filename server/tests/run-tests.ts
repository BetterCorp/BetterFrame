// Import tests explicitly so every node:test case is reported in this process.
import { readdir } from "node:fs/promises";
for (const file of (await readdir(new URL(".", import.meta.url))).filter((file) => file.endsWith(".test.ts")).sort()) {
  await import(new URL(file, import.meta.url).href);
}
