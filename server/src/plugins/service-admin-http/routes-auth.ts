/**
 * Authentication routes: login, TOTP, recovery, logout.
 */
import { type H3, readBody, html, getCookie, setCookie, deleteCookie, getQuery, getRequestHeader } from "h3";
import type { AdminDeps } from "./index.js";
import { LoginPage, TotpPage, RecoveryPage } from "../../web-templates/auth-pages.js";

const COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
};

export function registerAuthRoutes(app: H3, deps: AdminDeps): void {
  // ---- Login ----------------------------------------------------------------

  app.get("/auth/login", (event) => {
    const q = getQuery(event) as Record<string, string | undefined>;
    const welcome = q["welcome"] === "1";
    return html(LoginPage({ welcome }));
  });

  app.post("/auth/login", async (event) => {
    const body = await readBody<{ username?: string; password?: string }>(event);
    const username = (body?.username ?? "").trim();
    const password = body?.password ?? "";

    if (!username || !password) {
      return html(LoginPage({ error: "Username and password required.", username }));
    }

    const user = deps.repo.getUserByUsername(username);
    if (!user || !user.is_active) {
      return html(LoginPage({ error: "Invalid credentials.", username }));
    }

    if (user.locked_until) {
      const lockEnd = new Date(user.locked_until);
      if (lockEnd > new Date()) {
        return html(LoginPage({ error: "Account locked. Try again later.", username }));
      }
    }

    const valid = await deps.auth.verifyPassword(password, user.password_hash);
    if (!valid) {
      const count = user.failed_login_count + 1;
      const patch: Record<string, unknown> = { failed_login_count: count };
      if (count >= deps.auth.config.loginLockoutThreshold) {
        patch["locked_until"] = new Date(Date.now() + deps.auth.config.loginLockoutSeconds * 1000).toISOString();
      }
      deps.repo.updateUser(user.id, patch);
      return html(LoginPage({ error: "Invalid credentials.", username }));
    }

    deps.repo.updateUser(user.id, {
      failed_login_count: 0,
      locked_until: null,
      last_login_at: new Date().toISOString(),
    });

    const totpPending = user.totp_enabled;
    const { cookieValue } = await deps.auth.createSession({
      user,
      userAgent: getRequestHeader(event, "user-agent") ?? null,
      ipAddress: getRequestHeader(event, "x-forwarded-for")
        ?? getRequestHeader(event, "x-real-ip")
        ?? null,
      totpPending,
    });

    setCookie(event, deps.cookieName, cookieValue, {
      ...COOKIE_OPTS,
      maxAge: deps.auth.config.sessionMaxSeconds,
    });

    if (totpPending) {
      return new Response(null, { status: 302, headers: { location: "/auth/totp" } });
    }
    return new Response(null, { status: 302, headers: { location: "/admin/" } });
  });

  // ---- TOTP -----------------------------------------------------------------

  app.get("/auth/totp", (event) => {
    const cookie = getCookie(event, deps.cookieName);
    if (!cookie) {
      return new Response(null, { status: 302, headers: { location: "/auth/login" } });
    }
    const resolved = deps.auth.resolveSession(cookie);
    if (!resolved || !resolved.session.totp_pending) {
      return new Response(null, { status: 302, headers: { location: "/admin/" } });
    }
    return html(TotpPage({}));
  });

  app.post("/auth/totp", async (event) => {
    const cookie = getCookie(event, deps.cookieName);
    if (!cookie) {
      return new Response(null, { status: 302, headers: { location: "/auth/login" } });
    }
    const resolved = deps.auth.resolveSession(cookie);
    if (!resolved || !resolved.session.totp_pending) {
      return new Response(null, { status: 302, headers: { location: "/admin/" } });
    }

    const body = await readBody<{ code?: string }>(event);
    const code = (body?.code ?? "").trim().replace(/\s/g, "");

    if (!code || code.length !== 6) {
      return html(TotpPage({ error: "Enter a 6-digit code." }));
    }

    const { user, session } = resolved;
    if (!user.totp_secret_encrypted) {
      return html(TotpPage({ error: "TOTP not configured for this account." }));
    }

    const secret = deps.auth.decryptTotpSecret(user.totp_secret_encrypted);
    const valid = deps.auth.verifyTotpCode(secret, code);
    if (!valid) {
      return html(TotpPage({ error: "Invalid code. Try again." }));
    }

    deps.repo.setSessionTotpPending(session.id, false);
    return new Response(null, { status: 302, headers: { location: "/admin/" } });
  });

  // ---- Recovery code --------------------------------------------------------

  app.get("/auth/recovery", (event) => {
    const cookie = getCookie(event, deps.cookieName);
    if (!cookie) {
      return new Response(null, { status: 302, headers: { location: "/auth/login" } });
    }
    const resolved = deps.auth.resolveSession(cookie);
    if (!resolved || !resolved.session.totp_pending) {
      return new Response(null, { status: 302, headers: { location: "/admin/" } });
    }
    return html(RecoveryPage({}));
  });

  app.post("/auth/recovery", async (event) => {
    const cookie = getCookie(event, deps.cookieName);
    if (!cookie) {
      return new Response(null, { status: 302, headers: { location: "/auth/login" } });
    }
    const resolved = deps.auth.resolveSession(cookie);
    if (!resolved || !resolved.session.totp_pending) {
      return new Response(null, { status: 302, headers: { location: "/admin/" } });
    }

    const body = await readBody<{ code?: string }>(event);
    const code = (body?.code ?? "").trim().toUpperCase().replace(/\s/g, "");

    if (!code) {
      return html(RecoveryPage({ error: "Enter a recovery code." }));
    }

    const { user, session } = resolved;
    const hashedCodes: string[] = user.recovery_codes_hashed ?? [];

    const result = await deps.auth.consumeRecoveryCode(code, hashedCodes);
    if (!result.ok) {
      return html(RecoveryPage({ error: "Invalid recovery code." }));
    }

    deps.repo.updateUser(user.id, {
      recovery_codes_hashed: result.remaining,
    });

    deps.repo.setSessionTotpPending(session.id, false);
    return new Response(null, { status: 302, headers: { location: "/admin/" } });
  });

  // ---- Logout ---------------------------------------------------------------

  app.post("/auth/logout", (event) => {
    const cookie = getCookie(event, deps.cookieName);
    if (cookie) {
      const resolved = deps.auth.resolveSession(cookie);
      if (resolved) {
        deps.auth.revokeSession(resolved.session.id);
      }
    }
    deleteCookie(event, deps.cookieName, { path: "/" });
    return new Response(null, { status: 302, headers: { location: "/auth/login" } });
  });
}
