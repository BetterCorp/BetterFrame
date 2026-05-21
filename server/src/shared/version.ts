import { readFileSync } from "node:fs";

const BAKED_VERSION = (() => {
  try {
    const v = readFileSync("/app/server/.bf-version", "utf8").trim();
    return v && v !== "dev" ? v : null;
  } catch {
    return null;
  }
})();

export function serverVersion(): string {
  return (
    process.env.BF_SERVER_VERSION
    || process.env.BF_BUILD_VERSION
    || BAKED_VERSION
    || process.env.COOLIFY_GIT_COMMIT
    || process.env.SOURCE_COMMIT
    || "dev"
  );
}
