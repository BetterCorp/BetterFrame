import { createHash } from "node:crypto";

/** Preserve existing safe schema names; punctuation/long slugs get an immutable digest. */
export function tenantSchemaName(slug: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) throw new Error("invalid tenant slug");
  if (slug === "default") return "public";
  if (/^[a-z0-9_]+$/.test(slug) && slug.length <= 56) return `tenant_${slug}`;
  return `tenant_${createHash("sha256").update(slug).digest("hex").slice(0, 48)}`;
}
