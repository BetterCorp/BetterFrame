/**
 * Multi-tenant schema-per-tenant model.
 *
 * PostgreSQL database layout:
 *   public schema:
 *     tenants       — registry of all tenants
 *     global_admins — platform-level admins who can provision tenants
 *
 *   tenant_<uuid> schema (one per tenant):
 *     full BetterFrame table set (users, cameras, kiosks, layouts, etc.)
 *
 * Request flow:
 *   1. Session / API key / kiosk key → resolve tenant_id
 *   2. SET search_path = tenant_<id>, public
 *   3. All queries run against tenant's schema
 *   4. Connection returned to pool with search_path reset
 *
 * Default tenant uses the public schema directly (slug = "default").
 */

export const DEFAULT_TENANT_ID = "default";

export interface Tenant {
  id: string; // UUID
  name: string;
  slug: string; // URL-safe, unique
  schema_name: string; // "tenant_<uuid>" — Postgres schema
  is_active: boolean;
  max_kiosks: number | null; // null = unlimited
  max_cameras: number | null;
  max_users: number | null;
  created_at: string;
}

/**
 * Derive the Postgres schema name from a tenant ID.
 * Sanitized to prevent SQL injection — only alphanumeric + underscore.
 */
export function tenantSchemaName(tenantId: string): string {
  const safe = tenantId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 63);
  return `tenant_${safe}`;
}

/**
 * SQL to set the search path for a tenant's schema.
 * Always includes `public` so shared tables (like a future
 * tenant registry) are accessible.
 */
export function setTenantSearchPath(tenantId: string): string {
  const schema = tenantSchemaName(tenantId);
  return `SET search_path = "${schema}", public`;
}
