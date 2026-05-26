/**
 * Authentication routes: login, TOTP, recovery, logout.
 */
import { type H3, readBody, getCookie, getQuery, getRequestHeader } from "h3";
import { htmlPage, redirectWithCookie, redirectClearCookie } from "./html-response.js";
import type { AdminDeps } from "./index.js";
import { LoginPage, TotpPage, RecoveryPage } from "../../web-templates/auth-pages.js";
import { audit } from "../../shared/audit.js";
import { createRateLimiter } from "../../shared/rate-limit.js";
import { LoginBody, TotpBody, validateBody } from "../../shared/api-schemas.js";


export function registerAuthRoutes(app: H3, deps: AdminDeps): void {
  // 8 attempts per 60s per IP. Paired with the user-account lockout already
  // wired via deps.auth.config.loginLockoutThreshold. In-function so the BSB
  // schema extractor doesn't evaluate at module load.
  const loginGuard = createRateLimiter({ windowMs: 60_000, max: 8 });
  // ---- Login ----------------------------------------------------------------

  app.get("/auth/login", (event) => {
    const q = getQuery(event) as Record<string, string | undefined>;
    const welcome = q["welcome"] === "1";
    return htmlPage(LoginPage({ welcome }));
  });

  app.post("/auth/login", async (event) => {
    const ip = getRequestHeader(event, "x-real-ip")
      ?? getRequestHeader(event, "x-forwarded-for")?.split(",")[0]?.trim()
      ?? "anon";
    if (!loginGuard.take(`login:${ip}`)) {
      await audit(deps.repo, event as any, "user.login", {
        result: "failed",
        metadata: { reason: "rate_limited", ip },
      });
      return new Response("Too many login attempts. Try again in a minute.", {
        status: 429,
        headers: { "retry-after": "60", "content-type": "text/plain" },
      });
    }

    let body: { username: string; password: string };
    try {
      body = validateBody(LoginBody, await readBody(event));
    } catch {
      return htmlPage(LoginPage({ error: "Username and password required.", username: "" }));
    }
    const username = body.username.trim();
    const password = body.password;

    const user = await deps.repo.getUserByUsername(username);
    if (!user || !user.is_active) {
      return htmlPage(LoginPage({ error: "Invalid credentials.", username }));
    }

    if (user.locked_until) {
      const lockEnd = new Date(user.locked_until);
      if (lockEnd > new Date()) {
        return htmlPage(LoginPage({ error: "Account locked. Try again later.", username }));
      }
    }

    const valid = await deps.auth.verifyPassword(password, user.password_hash);
    if (!valid) {
      const count = user.failed_login_count + 1;
      const patch: Record<string, unknown> = { failed_login_count: count };
      if (count >= deps.auth.config.loginLockoutThreshold) {
        patch["locked_until"] = new Date(Date.now() + deps.auth.config.loginLockoutSeconds * 1000).toISOString();
      }
      await deps.repo.updateUser(user.id, patch);
      await audit(deps.repo, event as any, "user.login", {
        result: "failed",
        actor_type: "system",
        actor_label: username,
        metadata: { failed_count: count, locked: count >= deps.auth.config.loginLockoutThreshold },
      });
      return htmlPage(LoginPage({ error: "Invalid credentials.", username }));
    }

    await deps.repo.updateUser(user.id, {
      failed_login_count: 0,
      locked_until: null,
      last_login_at: new Date().toISOString(),
    });

    await audit(deps.repo, event as any, "user.login", {
      actor_type: "user",
      actor_id: user.id,
      actor_label: user.username,
      metadata: { totp_pending: user.totp_enabled },
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

    const cookie = { name: deps.cookieName, value: cookieValue, maxAge: deps.auth.config.sessionMaxSeconds };
    if (totpPending) {
      return redirectWithCookie("/auth/totp", cookie);
    }
    return redirectWithCookie("/admin/", cookie);
  });

  // ---- TOTP -----------------------------------------------------------------

  app.get("/auth/totp", async (event) => {
    const cookie = getCookie(event, deps.cookieName);
    if (!cookie) {
      return new Response(null, { status: 302, headers: { location: "/auth/login" } });
    }
    const resolved = await deps.auth.resolveSession(cookie);
    if (!resolved || !resolved.session.totp_pending) {
      return new Response(null, { status: 302, headers: { location: "/admin/" } });
    }
    return htmlPage(TotpPage({}));
  });

  app.post("/auth/totp", async (event) => {
    const cookie = getCookie(event, deps.cookieName);
    if (!cookie) {
      return new Response(null, { status: 302, headers: { location: "/auth/login" } });
    }
    const resolved = await deps.auth.resolveSession(cookie);
    if (!resolved || !resolved.session.totp_pending) {
      return new Response(null, { status: 302, headers: { location: "/admin/" } });
    }

    let totpBody: { code: string };
    try {
      totpBody = validateBody(TotpBody, await readBody(event));
    } catch {
      return htmlPage(TotpPage({ error: "Enter a 6-digit code." }));
    }
    const code = totpBody.code.trim().replace(/\s/g, "");

    if (code.length !== 6) {
      return htmlPage(TotpPage({ error: "Enter a 6-digit code." }));
    }

    const { user, session } = resolved;
    if (!user.totp_secret_encrypted) {
      return htmlPage(TotpPage({ error: "TOTP not configured for this account." }));
    }

    const secret = deps.auth.decryptTotpSecret(user.totp_secret_encrypted);
    const valid = deps.auth.verifyTotpCode(secret, code);
    if (!valid) {
      return htmlPage(TotpPage({ error: "Invalid code. Try again." }));
    }

    await deps.repo.setSessionTotpPending(session.id, false);
    return new Response(null, { status: 302, headers: { location: "/admin/" } });
  });

  // ---- Recovery code --------------------------------------------------------

  app.get("/auth/recovery", async (event) => {
    const cookie = getCookie(event, deps.cookieName);
    if (!cookie) {
      return new Response(null, { status: 302, headers: { location: "/auth/login" } });
    }
    const resolved = await deps.auth.resolveSession(cookie);
    if (!resolved || !resolved.session.totp_pending) {
      return new Response(null, { status: 302, headers: { location: "/admin/" } });
    }
    return htmlPage(RecoveryPage({}));
  });

  app.post("/auth/recovery", async (event) => {
    const cookie = getCookie(event, deps.cookieName);
    if (!cookie) {
      return new Response(null, { status: 302, headers: { location: "/auth/login" } });
    }
    const resolved = await deps.auth.resolveSession(cookie);
    if (!resolved || !resolved.session.totp_pending) {
      return new Response(null, { status: 302, headers: { location: "/admin/" } });
    }

    const body = await readBody<{ code?: string }>(event);
    const code = (body?.code ?? "").trim().toUpperCase().replace(/\s/g, "");

    if (!code) {
      return htmlPage(RecoveryPage({ error: "Enter a recovery code." }));
    }

    const { user, session } = resolved;
    const hashedCodes: string[] = user.recovery_codes_hashed ?? [];

    const result = await deps.auth.consumeRecoveryCode(code, hashedCodes);
    if (!result.ok) {
      return htmlPage(RecoveryPage({ error: "Invalid recovery code." }));
    }

    await deps.repo.updateUser(user.id, {
      recovery_codes_hashed: result.remaining,
    });

    await deps.repo.setSessionTotpPending(session.id, false);
    return new Response(null, { status: 302, headers: { location: "/admin/" } });
  });

  // ---- Logout ---------------------------------------------------------------

  app.post("/auth/logout", async (event) => {
    const cookie = getCookie(event, deps.cookieName);
    if (cookie) {
      const resolved = await deps.auth.resolveSession(cookie);
      if (resolved) {
        await deps.auth.revokeSession(resolved.session.id);
      }
    }
    return redirectClearCookie("/auth/login", deps.cookieName);
  });
}
