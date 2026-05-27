/**
 * Auth & setup gate middleware for admin-http.
 *
 * Accepts EITHER a valid session cookie OR an admin-scoped API key in
 * `Authorization: Bearer <bf-...>`. API-key callers get a synthetic User
 * record so downstream handlers (which always read `event.context.user`)
 * keep working unchanged.
 *
 * Multi-tenant: on PG, reads `bf_tenant` cookie to set the DB search_path
 * per request. Falls back to "default" tenant.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { type H3, getCookie, getRequestPath } from "h3";
import type { AdminDeps } from "./index.js";
import type { User, Session, Tenant } from "../../shared/types.js";

declare module "h3" {
  interface H3EventContext {
    user?: User;
    session?: Session;
    apiKeyPrefix?: string;
    obs?: import("@bsb/base").Observable;
    /** Current tenant (PG multi-tenant mode). Undefined for SQLite. */
    tenant?: Tenant;
  }
}

function syntheticApiKeyUser(keyPrefix: string): User {
  return {
    id: "",
    username: `api:${keyPrefix}`,
    password_hash: "",
    role: "admin",
    is_active: true,
    totp_enabled: false,
    totp_secret_encrypted: null,
    recovery_codes_hashed: [],
    must_change_password: false,
    failed_login_count: 0,
    locked_until: null,
    last_login_at: null,
    created_at: new Date(0).toISOString(),
  };
}

function tokenMatchesExpected(token: string, expected: string | undefined): boolean {
  if (!expected || expected.length < 32 || token.length < 32) return false;
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function registerMiddleware(app: H3, deps: AdminDeps): void {
  // Tenant resolution middleware — sets search_path for PG multi-tenant.
  // Runs before auth so that DB queries in auth resolution use the right schema.
  app.use(async (event) => {
    if (deps.repo.adapter.dialect() !== "postgres") return;

    const path = getRequestPath(event);
    // Skip tenant resolution for paths that don't query tenant-scoped data.
    if (path.startsWith("/static/") || path === "/healthz" || path === "/readyz" || path === "/version") return;

    // Read tenant slug from cookie.
    const tenantSlug = getCookie(event, "bf_tenant") || "default";
    const tenant = await deps.repo.getTenantBySlug(tenantSlug);
    if (tenant && tenant.is_active) {
      event.context.tenant = tenant;
      await deps.repo.adapter.setSearchPath(tenant.schema_name);
    } else {
      const defaultTenant = await deps.repo.getTenantBySlug("default");
      if (defaultTenant) {
        event.context.tenant = defaultTenant;
      }
      // Reset to public if we had a bad cookie.
      await deps.repo.adapter.setSearchPath("public");
    }
  });

  app.use(async (event) => {
    const path = getRequestPath(event);

    if (
      path === "/setup" ||
      path.startsWith("/static/") ||
      path === "/healthz" ||
      path === "/readyz" ||
      path === "/version" ||
      path === "/api/admin/_check" ||
      path === "/"
    ) {
      return;
    }

    if (!(await deps.repo.isSetupComplete())) {
      if (!path.startsWith("/auth/")) {
        return new Response(null, { status: 302, headers: { location: "/setup" } });
      }
    }

    if (path.startsWith("/auth/")) {
      return;
    }

    if (path.startsWith("/admin") || path.startsWith("/api/admin")) {
      // ---- Bearer API key (admin scope) -------------------------------------
      // Lets Node-RED nodes + scripted automation hit /admin/* without owning
      // a session cookie. Must come BEFORE the cookie redirect so a missing
      // cookie + present API key doesn't 302 to /auth/login.
      const authz = event.req.headers.get("authorization");
      if (authz && authz.startsWith("Bearer ")) {
        const token = authz.slice(7);
        if (
          (path === "/api/admin/firmware/import" || path === "/api/admin/os/import") &&
          (tokenMatchesExpected(token, deps.firmwareImportApiKey) || tokenMatchesExpected(token, deps.otaImportApiKey))
        ) {
          const label = path === "/api/admin/os/import" ? "ota-import" : "fw-import";
          event.context.user = syntheticApiKeyUser(label);
          event.context.apiKeyPrefix = label;
          return;
        }

        const key = await deps.auth.verifyApiKey(token, event.req.headers.get("x-real-ip"));
        if (!key || !key.scopes.includes("admin")) {
          return new Response(null, { status: 401 });
        }
        event.context.user = syntheticApiKeyUser(key.key_prefix);
        event.context.apiKeyPrefix = key.key_prefix;
        return;
      }

      const cookie = getCookie(event, deps.cookieName);
      if (!cookie) {
        return new Response(null, { status: 302, headers: { location: "/auth/login" } });
      }
      const resolved = await deps.auth.resolveSession(cookie);
      if (!resolved) {
        return new Response(null, { status: 302, headers: { location: "/auth/login" } });
      }
      if (resolved.session.totp_pending) {
        return new Response(null, { status: 302, headers: { location: "/auth/totp" } });
      }
      event.context.user = resolved.user;
      event.context.session = resolved.session;
      return;
    }
  });
}
