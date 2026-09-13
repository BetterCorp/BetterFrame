import { createHash } from "node:crypto";

/** Preserve existing safe schema names; punctuation/long slugs get an immutable digest. */
export function tenantSchemaName(slug: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) throw new Error("invalid tenant slug");
  if (slug === "default") return "public";
  if (/^[a-z0-9_]+$/.test(slug) && slug.length <= 56) return `tenant_${slug}`;
  return legacyTenantSchemaName(slug);
}

/** Existing registrations predate input limits; hash them without rejecting their slug. */
export function legacyTenantSchemaName(slug: string): string {
  return `tenant_${createHash("sha256").update(slug).digest("hex").slice(0, 48)}`;
}

/** PostgreSQL truncates identifiers to 63 bytes without splitting UTF-8 characters. */
export function storedPostgresIdentifier(identifier: string): string {
  let stored = "";
  for (const character of identifier) {
    if (Buffer.byteLength(stored + character, "utf8") > 63) break;
    stored += character;
  }
  return stored;
}
