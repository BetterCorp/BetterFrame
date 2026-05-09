/**
 * Auth & setup gate middleware for admin-http.
 */
import { type H3, getCookie, createError, type H3Event, getRequestPath } from "h3";
import type { AdminDeps } from "./index.js";
import type { User, Session } from "../../shared/types.js";

/** Augment h3 event context with resolved auth info. */
declare module "h3" {
  interface H3EventContext {
    user?: User;
    session?: Session;
  }
}

/**
 * Resolve session from cookie. Returns null if invalid/missing.
 */
function resolveSession(event: H3Event, deps: AdminDeps): { user: User; session: Session } | null {
  const cookie = getCookie(event, deps.cookieName);
  if (!cookie) return null;
  return deps.auth.resolveSession(cookie);
}

export function registerMiddleware(app: H3, deps: AdminDeps): void {
  // Setup gate: if setup not complete, only /setup, /static, /healthz, /readyz, /version allowed
  app.use((event) => {
    const path = getRequestPath(event);

    // Always pass through non-gated paths
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

    // If setup not complete, block everything except setup flow
    if (!deps.store.repo.isSetupComplete()) {
      if (!path.startsWith("/auth/")) {
        return new Response(null, { status: 302, headers: { location: "/setup" } });
      }
    }

    // Auth pages don't require session (login/totp/recovery)
    if (path.startsWith("/auth/")) {
      return;
    }

    // Admin pages require valid session
    if (path.startsWith("/admin") || path.startsWith("/api/admin")) {
      const resolved = resolveSession(event, deps);
      if (!resolved) {
        return new Response(null, { status: 302, headers: { location: "/auth/login" } });
      }
      // TOTP pending — only allow /auth/totp and /auth/recovery
      if (resolved.session.totp_pending) {
        return new Response(null, { status: 302, headers: { location: "/auth/totp" } });
      }
      // Attach to context for downstream handlers
      event.context.user = resolved.user;
      event.context.session = resolved.session;
      return;
    }
  });
}
