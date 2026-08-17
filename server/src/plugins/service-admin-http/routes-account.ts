/**
 * Account management routes — password change, TOTP enrollment.
 */
import { type H3, type H3Event, readBody } from "h3";
import { htmlPage } from "./html-response.js";
import type { AdminDeps } from "./index.js";
import { AccountPage, TotpEnrollPage } from "../../web-templates/admin-pages.js";
import type { User } from "../../shared/types.js";

export function registerAccountRoutes(app: H3, deps: AdminDeps): void {
  const outsideDefaultTenant = (event: H3Event) =>
    event.context.tenant?.slug !== "default";
  const rejectTenantMutation = (event: H3Event) =>
    outsideDefaultTenant(event)
      ? new Response(null, { status: 302, headers: { location: "/admin/account" } })
      : null;
  const updateAuthenticatedUser = (user: User, patch: Partial<User>) =>
    user.role === "admin"
      ? deps.repo.updatePlatformAdmin(user.id, patch)
      : deps.repo.updateUser(user.id, patch);

  // ---- Account page ---------------------------------------------------------

  app.get("/admin/account", (event) => {
    const user = event.context.user!;
    return htmlPage(AccountPage({
      user: user.username,
      totpEnabled: user.totp_enabled,
      rootRequired: outsideDefaultTenant(event),
    }));
  });

  // ---- Change password ------------------------------------------------------

  app.post("/admin/account/password", async (event) => {
    const tenantRedirect = rejectTenantMutation(event);
    if (tenantRedirect) return tenantRedirect;
    const user = event.context.user!;
    const body = await readBody<{ current_password?: string; new_password?: string }>(event);
    const current = body?.current_password ?? "";
    const newPw = body?.new_password ?? "";

    if (!current || !newPw) {
      return htmlPage(AccountPage({
        user: user.username,
        totpEnabled: user.totp_enabled,
        error: "Both current and new password required.",
      }));
    }

    if (newPw.length < 12) {
      return htmlPage(AccountPage({
        user: user.username,
        totpEnabled: user.totp_enabled,
        error: "New password must be at least 12 characters.",
      }));
    }

    const valid = await deps.auth.verifyPassword(current, user.password_hash);
    if (!valid) {
      return htmlPage(AccountPage({
        user: user.username,
        totpEnabled: user.totp_enabled,
        error: "Current password incorrect.",
      }));
    }

    const hash = await deps.auth.hashPassword(newPw);
    await updateAuthenticatedUser(user, { password_hash: hash });

    // Revoke all sessions (force re-login)
    if (user.role === "admin") await deps.repo.revokePlatformAdminSessions(user.id);
    else await deps.repo.revokeAllSessionsForUser(user.id);

    return new Response(null, {
      status: 302,
      headers: { location: "/auth/login" },
    });
  });

  // ---- TOTP: begin enrollment -----------------------------------------------

  app.post("/admin/account/totp/begin", async (event) => {
    const tenantRedirect = rejectTenantMutation(event);
    if (tenantRedirect) return tenantRedirect;
    const user = event.context.user!;

    if (user.totp_enabled) {
      return htmlPage(AccountPage({
        user: user.username,
        totpEnabled: true,
        error: "TOTP already enabled.",
      }));
    }

    const secret = deps.auth.generateTotpSecret();
    const uri = deps.auth.totpProvisioningUri(user.username, secret);
    const codes = deps.auth.generateRecoveryCodes();

    // Store unconfirmed secret + codes
    const encrypted = deps.auth.encryptTotpSecret(secret);
    await updateAuthenticatedUser(user, {
      totp_secret_encrypted: encrypted,
    });

    return htmlPage(TotpEnrollPage({
      user: user.username,
      secret,
      provisioningUri: uri,
      recoveryCodes: codes,
    }));
  });

  // ---- TOTP: confirm enrollment ---------------------------------------------

  app.post("/admin/account/totp/confirm", async (event) => {
    const tenantRedirect = rejectTenantMutation(event);
    if (tenantRedirect) return tenantRedirect;
    const user = event.context.user!;
    const body = await readBody<{ code?: string; recovery_codes?: string }>(event);
    const code = (body?.code ?? "").trim().replace(/\s/g, "");

    if (!code || code.length !== 6) {
      return htmlPage(AccountPage({
        user: user.username,
        totpEnabled: false,
        error: "Enter a valid 6-digit code.",
      }));
    }

    if (!user.totp_secret_encrypted) {
      return htmlPage(AccountPage({
        user: user.username,
        totpEnabled: false,
        error: "No TOTP enrollment in progress. Start again.",
      }));
    }

    const secret = deps.auth.decryptTotpSecret(user.totp_secret_encrypted);
    const valid = deps.auth.verifyTotpCode(secret, code);
    if (!valid) {
      return htmlPage(AccountPage({
        user: user.username,
        totpEnabled: false,
        error: "Invalid code. Scan the QR code again and enter the current code.",
      }));
    }

    // Hash recovery codes and save
    const codesJson = body?.recovery_codes ?? "[]";
    const codes: string[] = JSON.parse(codesJson);
    const hashed = await deps.auth.hashRecoveryCodes(codes);

    await updateAuthenticatedUser(user, {
      totp_enabled: true,
      recovery_codes_hashed: hashed,
    });

    return new Response(null, {
      status: 302,
      headers: { location: "/admin/account" },
    });
  });

  // ---- TOTP: disable --------------------------------------------------------

  app.post("/admin/account/totp/disable", async (event) => {
    const tenantRedirect = rejectTenantMutation(event);
    if (tenantRedirect) return tenantRedirect;
    const user = event.context.user!;
    const body = await readBody<{ password?: string }>(event);
    const password = body?.password ?? "";

    const valid = await deps.auth.verifyPassword(password, user.password_hash);
    if (!valid) {
      return htmlPage(AccountPage({
        user: user.username,
        totpEnabled: true,
        error: "Password incorrect.",
      }));
    }

    await updateAuthenticatedUser(user, {
      totp_enabled: false,
      totp_secret_encrypted: null,
      recovery_codes_hashed: [],
    });

    return new Response(null, {
      status: 302,
      headers: { location: "/admin/account" },
    });
  });
}
