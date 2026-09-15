import { createHash } from "node:crypto";
import { type H3, getCookie, getRequestHeader } from "h3";
import type { Repository } from "./db/repository.js";
import type { AuthApi } from "./auth.js";
import type { SecretsApi } from "./secrets.js";
import { isAndroidViewer, androidViewerRouteAllowed, viewerAssignment } from "./android-viewer.js";
import type { NoderedBridge, NoderedDashboard } from "./nodered-bridge.js";
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

export function displayDashboardRequestAllowed(uri: string, assignedPaths: ReadonlySet<string>, pages: NoderedDashboard[]): boolean {
  const rawPath = uri.split(/[?#]/, 1)[0] ?? "";
  if (!rawPath.startsWith("/") || rawPath.startsWith("//") || /[\\%\x00-\x20]/.test(rawPath)) return false;
  const requested = new URL(uri, "https://display.invalid").pathname.replace(/\/$/, "");
  if (rawPath.replace(/\/$/, "") !== requested) return false;
  // The shared Socket.IO setup exposes all pages in a UI base. Display sessions
  // remain denied until the provider can authorize individual subscriptions.
  if (requested.split("/").includes("socket.io")) return false;
  if (assignedPaths.has(requested)) return true;
  const assignedPages = pages.filter((page) => assignedPaths.has(`/dash/${page.id}`));
  return assignedPages.some((page) => requested === page.path
    || requested.startsWith(`${page.basePath}/assets/`)
    || ["favicon.ico", "apple-touch-icon.png"].some((file) => requested === `${page.basePath}/${file}`));
}

export function registerViewerDeviceAuth(app: H3, repo: Repository, auth: AuthApi, secrets: SecretsApi, nodered?: NoderedBridge): void {
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
          // Resolve actual FlowFuse paths from this tenant's live page catalog.
          // The browser cookie itself cannot select a different tenant or page.
          const { dashboardPaths } = await viewerAssignment(repo, kiosk);
          const pages = nodered ? await nodered.listDashboards(tenant.id) : [];
          if (!displayDashboardRequestAllowed(uri, dashboardPaths, pages)) return new Response(null, { status: 403 });
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
        "set-cookie": `${COOKIE}=${token}; Path=/; Max-Age=${LIFETIME}; ${secure ? "Secure; " : ""}HttpOnly; SameSite=Strict`,
      },
    });
  });
}
