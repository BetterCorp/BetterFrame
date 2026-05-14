/**
 * Tiny env-override helpers for Coolify / 12-factor deploys.
 *
 * sec-config.yaml stays the single declarative source of truth, but a handful
 * of values benefit from runtime env-var injection (URL of the upstream
 * Node-RED, the BF server's own public URL, paths to data dirs, etc.). These
 * helpers are called inline from each plugin's init() so a missing env var
 * simply falls back to the YAML value.
 */
export function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

export function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.toLowerCase();
  if (v === undefined) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
