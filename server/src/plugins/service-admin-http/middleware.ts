/**
 * Auth & setup gate middleware for admin-http.
 *
 * Accepts EITHER a valid session cookie OR an admin-scoped API key in
 * `Authorization: Bearer <bf-...>`. API-key callers get a synthetic User
 * record so downstream handlers (which always read `event.context.user`)
 * keep working unchanged.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { type H3, getCookie, getRequestPath } from "h3";
import type { AdminDeps } from "./index.js";
import type { User, Session } from "../../shared/types.js";

declare module "h3" {
  interface H3EventContext {
    user?: User;
    session?: Session;
    apiKeyPrefix?: string;
  }
}

function syntheticApiKeyUser(keyPrefix: string): User {
  return {
    id: 0,
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

function tokenMatchesEnv(token: string, envName: string): boolean {
  const expected = process.env[envName]?.trim();
  if (!expected || expected.length < 32 || token.length < 32) return false;
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function registerMiddleware(app: H3, deps: AdminDeps): void {
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

    if (!deps.repo.isSetupComplete()) {
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
          (tokenMatchesEnv(token, "BF_FIRMWARE_IMPORT_API_KEY") || tokenMatchesEnv(token, "BF_OTA_IMPORT_API_KEY"))
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
      const resolved = deps.auth.resolveSession(cookie);
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
