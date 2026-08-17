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
import { csrfRequestIsValid } from "../../shared/csrf.js";
import { redirectClearCookie } from "./html-response.js";

declare module "h3" {
  interface H3EventContext {
    user?: User;
    session?: Session;
    apiKeyPrefix?: string;
    obs?: import("@bsb/base").Observable;
    /** Current tenant (PG multi-tenant mode). Undefined for SQLite. */
    tenant?: Tenant;
    /** Tenant that issued the authenticated session. */
    originTenant?: Tenant;
    tenantHeaderError?: "unknown tenant" | "inactive tenant";
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

const OPERATOR_MUTATIONS = [
  /^\/api\/displays\/[^/]+\/(?:focus|clear|restore)$/,
  /^\/admin\/displays\/[^/]+\/layout(?:\/[^/]+)?$/,
  /^\/admin\/displays\/[^/]+\/power\/(?:standby|wake)$/,
  /^\/admin\/kiosks\/[^/]+\/power\/(?:standby|wake)$/,
  /^\/admin\/kiosks\/[^/]+\/volume$/,
  /^\/admin\/account\/(?:password|totp\/(?:begin|confirm|disable))$/,
];

const OPERATOR_READS = [
  /^\/admin\/?$/,
  /^\/admin\/account$/,
  /^\/admin\/(?:cameras|displays|entities|health|iobox|kiosks|labels|layouts)(?:\/.*)?$/,
  /^\/api\/admin\/(?:_check|cameras|displays|entities|kiosks|layouts)(?:\/.*)?$/,
];

function isUnsafeMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export function operatorMayAccess(path: string, method: string): boolean {
  if (/\/kiosks\/[^/]+\/(?:logs|terminal)$/.test(path)) return false;
  const patterns = isUnsafeMethod(method) ? OPERATOR_MUTATIONS : OPERATOR_READS;
  return patterns.some((pattern) => pattern.test(path));
}

export function registerMiddleware(app: H3, deps: AdminDeps): void {
  // Tenant resolution middleware — sets search_path for PG multi-tenant.
  // Runs before auth so that DB queries in auth resolution use the right schema.
  app.use(async (event, next) => {
    if (deps.repo.adapter.dialect() !== "postgres") return next();

    const path = getRequestPath(event);
    // Skip tenant resolution for paths that don't query tenant-scoped data.
    if (path.startsWith("/static/") || path === "/healthz" || path === "/readyz" || path === "/version") return next();

    let schema = "public";
    const loginRequest = path === "/auth/login";
    const headerSlug = loginRequest
      ? ""
      : (event.req.headers.get("x-betterframe-tenant") ?? "").trim().toLowerCase();
    if (headerSlug) {
      const tenant = await deps.repo.getTenantBySlug(headerSlug);
      if (tenant?.is_active) {
        event.context.tenant = tenant;
        schema = tenant.schema_name;
        return deps.repo.adapter.withSearchPath(schema, next);
      }
      event.context.tenantHeaderError = tenant ? "inactive tenant" : "unknown tenant";
    }

    const tenantSlug = loginRequest ? "default" : getCookie(event, "bf_tenant") || "default";
    const tenant = await deps.repo.getTenantBySlug(tenantSlug);
    if (tenant && tenant.is_active) {
      event.context.tenant = tenant;
      schema = tenant.schema_name;
    } else {
      const defaultTenant = await deps.repo.getTenantBySlug("default");
      if (defaultTenant) {
        event.context.tenant = defaultTenant;
        schema = defaultTenant.schema_name;
      }
    }
    return deps.repo.adapter.withSearchPath(schema, next);
  });

  app.use(async (event) => {
    const path = getRequestPath(event);

    if (
      path === "/setup" ||
      path.startsWith("/static/") ||
      path === "/healthz" ||
      path === "/readyz" ||
      path === "/version" ||
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

    if (path.startsWith("/admin") || path.startsWith("/api/admin") || path.startsWith("/api/displays/")) {
      // ---- Bearer API key (admin scope) -------------------------------------
      // Lets Node-RED nodes + scripted automation hit /admin/* without owning
      // a session cookie. Must come BEFORE the cookie redirect so a missing
      // cookie + present API key doesn't 302 to /auth/login.
      const authz = event.req.headers.get("authorization");
      if (authz && authz.startsWith("Bearer ")) {
        if (event.context.tenantHeaderError) {
          return new Response(event.context.tenantHeaderError, { status: 401 });
        }
        const token = authz.slice(7);
        if (
          (path === "/api/admin/firmware/import" || path === "/api/admin/iobox/firmware/import" || path === "/api/admin/os/import") &&
          (tokenMatchesExpected(token, deps.firmwareImportApiKey) || tokenMatchesExpected(token, deps.otaImportApiKey))
        ) {
          const label = path === "/api/admin/os/import" ? "ota-import" : path.includes("/iobox/") ? "iobox-fw-import" : "fw-import";
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
      const requestedTenant = event.context.tenant;
      const resolved = await deps.auth.resolveSession(cookie);
      if (!resolved) {
        return new Response(null, { status: 302, headers: { location: "/auth/login" } });
      }
      if (resolved.user.role === "admin" && resolved.tenant.slug !== "default") {
        await deps.repo.adapter.withSearchPath(resolved.tenant.schema_name, () =>
          deps.auth.revokeSession(resolved.session.id));
        return redirectClearCookie("/auth/login", [deps.cookieName, "betterframe_csrf", "bf_tenant"]);
      }
      if (resolved.session.totp_pending) {
        return new Response(null, { status: 302, headers: { location: "/auth/totp" } });
      }
      const platformAdmin = resolved.user.role === "admin" && resolved.tenant.slug === "default";
      const targetTenant = requestedTenant ?? resolved.tenant;
      if (targetTenant.id !== resolved.tenant.id && !platformAdmin) {
        return new Response("tenant access denied", { status: 403 });
      }
      if (path.startsWith("/admin/tenants") && !platformAdmin) {
        return new Response("platform administrator required", { status: 403 });
      }
      if (resolved.user.role === "operator" && !operatorMayAccess(path, event.req.method)) {
        return new Response("administrator required", { status: 403 });
      }
      if (isUnsafeMethod(event.req.method) && !csrfRequestIsValid(event, resolved.session)) {
        return new Response("invalid CSRF token", { status: 403 });
      }
      const tenantUser = platformAdmin && targetTenant.id !== resolved.tenant.id
        ? await deps.repo.adapter.withSearchPath(targetTenant.schema_name, () =>
            deps.repo.getUserByUsername(resolved.user.username))
        : null;
      event.context.user = tenantUser ?? resolved.user;
      event.context.session = resolved.session;
      event.context.originTenant = resolved.tenant;
      event.context.tenant = targetTenant;
      return;
    }
  });
}
