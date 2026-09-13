import { createHash } from "node:crypto";
import { type H3, getCookie, getRequestHeader } from "h3";
import type { Repository } from "./db/repository.js";
import type { AuthApi } from "./auth.js";
import type { SecretsApi } from "./secrets.js";
import { isAndroidViewer, androidViewerRouteAllowed, viewerAssignment } from "./android-viewer.js";
import { requestOriginIsValid } from "./csrf.js";

function displayOriginIsValid(event: Parameters<typeof requestOriginIsValid>[0]): boolean {
  if (!requestOriginIsValid(event)) return false;
  const origin = event.req.headers.get("origin");
  if (!origin) return true; // native requests have no Origin header
  const url = new URL(event.req.url);
  const host = event.req.headers.get("x-forwarded-host") ?? event.req.headers.get("host") ?? url.host;
  const protocol = event.req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? url.protocol.replace(":", "");
  return origin === `${protocol}://${host}`;
}

const COOKIE = "betterframe_display_session";
const CONTEXT = "android-display-session-v1";
const LIFETIME = 3600;
const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex");

export function registerViewerDeviceAuth(app: H3, repo: Repository, auth: AuthApi, secrets: SecretsApi): void {
  app.use(async (event, next) => {
    const path = new URL(event.req.url).pathname;
    if (!path.startsWith("/api/kiosk/")) return next();
    const bearer = getRequestHeader(event, "authorization")?.match(/^Bearer (.+)$/)?.[1];
    const rawKeyCookie = getCookie(event, "betterframe_kiosk_key");
    const displayCookie = getCookie(event, COOKIE);
    if (path === "/api/kiosk/_check" && !bearer && displayCookie) {
      if (!displayOriginIsValid(event)) return new Response(null, { status: 403 });
      try {
        const claims = JSON.parse(secrets.decryptString(displayCookie, CONTEXT));
        if (claims.expires <= Date.now() || !Number.isFinite(claims.expires)) return new Response(null, { status: 401 });
        const tenant = await repo.getTenantBySlug(claims.tenant);
        if (!tenant?.is_active) return new Response(null, { status: 401 });
        return repo.adapter.withSearchPath(tenant.schema_name, async () => {
          const kiosk = await repo.getKioskById(claims.kiosk);
          if (!kiosk?.enabled || !isAndroidViewer(kiosk) || fingerprint(kiosk.key_hash) !== claims.key) return new Response(null, { status: 401 });
          const uri = getRequestHeader(event, "x-original-uri") ?? "";
          // Proxy must overwrite this header with the original browser URI.
          if (!uri.startsWith("/dash/") || uri.startsWith("//")) return new Response(null, { status: 403 });
          const requested = new URL(uri, "https://display.invalid").pathname.replace(/\/$/, "");
          const { dashboardPaths } = await viewerAssignment(repo, kiosk);
          // Shared assets are part of the dashboard application, but pages
          // outside the current assignment do not acquire a display session.
          // FlowFuse Socket.IO can expose unassigned rooms. Fail closed until
          // the provider enforces display scope on every channel subscription.
          if (requested.startsWith("/dash/socket.io")) return new Response(null, { status: 403 });
          const pageAllowed = [...dashboardPaths].some((p) => requested === p || requested.startsWith(`${p}/`));
          const assetAllowed = dashboardPaths.size > 0 && /^\/dash\/assets\//.test(requested);
          if (!pageAllowed && !assetAllowed) return new Response(null, { status: 403 });
          (event.context as any).verifiedKiosk = { id: kiosk.id, tenant_id: tenant.id, tenant_slug: tenant.slug, tenant_name: tenant.name, schema_name: tenant.schema_name };
          (event.context as any).displaySession = true;
          return next();
        });
      } catch { return new Response(null, { status: 401 }); }
    }
    const key = bearer ?? rawKeyCookie;
    const verified = key ? await auth.verifyKioskKey(key) : null;
    if (!verified) return new Response(null, { status: 401 });
    return repo.adapter.withSearchPath(verified.schema_name, async () => {
      const kiosk = await repo.getKioskById(verified.id);
      if (!kiosk?.enabled) return new Response(null, { status: 401 });
      if (isAndroidViewer(kiosk)) {
        // Browser cookies never authorize the native device API. Dashboard
        // sessions cannot fetch bundles, credentials, or invoke device actions.
        if (!bearer || !androidViewerRouteAllowed(path, event.req.method) || path === "/api/kiosk/_check") return new Response(null, { status: 403 });
        if (!displayOriginIsValid(event)) return new Response(null, { status: 403 });
      }
      (event.context as any).verifiedKiosk = verified;
      (event.context as any).kioskProfile = kiosk;
      return next();
    });
  });

  app.post("/api/kiosk/display-session", async (event) => {
    const kiosk = (event.context as any).kioskProfile;
    const verified = (event.context as any).verifiedKiosk;
    if (!isAndroidViewer(kiosk)) return new Response(null, { status: 403 });
    const claims = { kiosk: kiosk.id, tenant: verified.tenant_slug, key: fingerprint(kiosk.key_hash), expires: Date.now() + LIFETIME * 1000 };
    const token = secrets.encryptString(JSON.stringify(claims), CONTEXT);
    const secure = (getRequestHeader(event, "x-forwarded-proto")?.split(",")[0]?.trim() ?? new URL(event.req.url).protocol.replace(":", "")) === "https";
    return new Response(JSON.stringify({ expires_in: LIFETIME }), {
      headers: {
        "content-type": "application/json", "cache-control": "no-store",
        "set-cookie": `${COOKIE}=${token}; Path=/dash/; Max-Age=${LIFETIME}; ${secure ? "Secure; " : ""}HttpOnly; SameSite=Strict`,
      },
    });
  });
}
