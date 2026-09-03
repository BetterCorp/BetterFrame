import { readFileSync } from "node:fs";

let cached: string | null = null;

export function serverVersion(): string {
  if (cached) return cached;
  try {
    const v = readFileSync("/home/bsb/.bf-version", "utf8").trim();
    cached = v && v !== "dev" ? v : "dev";
  } catch {
    cached = "dev";
  }
  return cached;
}

type ParsedVersion = {
  core: [number, number, number];
  prerelease: Array<number | string>;
};

function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) return null;
  const core = match.slice(1, 4).map(Number) as ParsedVersion["core"];
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  return {
    core,
    prerelease: match[4]
      ? match[4].split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part)
      : [],
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index]! - right.core[index]!;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "number") return -1;
    if (typeof b === "number") return 1;
    return a.localeCompare(b);
  }
  return 0;
}

/** Unknown installed versions retain legacy behavior; known versions only move forward. */
export function isVersionUpgrade(candidate: string, installed: string): boolean {
  const next = parseVersion(candidate);
  if (!next) return false;
  const current = parseVersion(installed);
  return current ? compareVersions(next, current) > 0 : candidate.trim() !== installed.trim();
}
