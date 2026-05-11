/**
 * Auth & setup gate middleware for admin-http.
 */
import { type H3, getCookie, getRequestPath } from "h3";
import type { AdminDeps } from "./index.js";
import type { User, Session } from "../../shared/types.js";

declare module "h3" {
  interface H3EventContext {
    user?: User;
    session?: Session;
  }
}

export function registerMiddleware(app: H3, deps: AdminDeps): void {
  app.use((event) => {
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
