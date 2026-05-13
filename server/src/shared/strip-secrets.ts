/**
 * strip-secrets — recursively remove credential-like keys from an object
 * before serializing to JSON. Used by admin API JSON responses so callers
 * (Node-RED, scripted clients) never receive password hashes, encrypted
 * TOTP secrets, kiosk keys, etc.
 *
 * The set is conservative: anything matching a known secret-bearing key
 * name is dropped. Add keys here when new credential fields appear.
 */

const SECRET_KEYS: ReadonlySet<string> = new Set([
  "password",
  "password_hash",
  "key_hash",
  "onvif_password",
  "kiosk_key",
  "totp_secret_encrypted",
  "csrf_token",
  "recovery_codes_hashed",
  // wire-side variants in case bf-config-* responses ever proxy them
  "api_key",
  "cluster_key",
  "cluster_key_encrypted",
]);

export function stripSecrets<T>(value: T): T {
  return stripInner(value) as T;
}

function stripInner(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((item) => stripInner(item));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k)) continue;
      out[k] = stripInner(val);
    }
    return out;
  }
  return v;
}
