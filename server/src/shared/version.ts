import { readFileSync } from "node:fs";

let cached: string | null = null;

export function serverVersion(): string {
  if (cached) return cached;
  try {
    const v = readFileSync("/app/server/.bf-version", "utf8").trim();
    cached = v && v !== "dev" ? v : "dev";
  } catch {
    cached = "dev";
  }
  return cached;
}
