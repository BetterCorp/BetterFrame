/**
 * Tenant management routes — CRUD for tenants + tenant switching.
 * PG-only feature. On SQLite these routes return 404.
 */
import { type H3, readBody, getRouterParam, getCookie } from "h3";
import { htmlPage, redirectWithCookie } from "./html-response.js";
import type { AdminDeps } from "./index.js";
import { createTenantSchema } from "../../shared/db/init.js";
import {
  TenantsPage,
  TenantEditPage,
} from "../../web-templates/admin-pages.js";

export function registerTenantRoutes(app: H3, deps: AdminDeps): void {
  // Guard: multi-tenant is PG only.
  const isPg = () => deps.repo.adapter.dialect() === "postgres";

  // ---- List all tenants -----------------------------------------------------

  app.get("/admin/tenants", async (event) => {
    if (!isPg()) return new Response("multi-tenant requires postgres", { status: 404 });
    const user = event.context.user!;
    const tenants = await deps.repo.listTenants();
    const currentTenant = event.context.tenant ?? null;
    return htmlPage(TenantsPage({
      user: user.username,
      tenants,
      currentTenantSlug: currentTenant?.slug ?? "default",
    }));
  });

  // ---- Create tenant --------------------------------------------------------

  app.post("/admin/tenants", async (event) => {
    if (!isPg()) return new Response("multi-tenant requires postgres", { status: 404 });
    const body = await readBody<Record<string, string>>(event);
    const name = (body?.["name"] ?? "").trim();
    const slug = (body?.["slug"] ?? "").trim().toLowerCase();
    const maxKiosks = body?.["max_kiosks"] ? parseInt(body["max_kiosks"], 10) : null;
    const maxCameras = body?.["max_cameras"] ? parseInt(body["max_cameras"], 10) : null;
    const maxUsers = body?.["max_users"] ? parseInt(body["max_users"], 10) : null;

    if (!name || !slug || !/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
      const tenants = await deps.repo.listTenants();
      return htmlPage(TenantsPage({
        user: event.context.user!.username,
        tenants,
        currentTenantSlug: event.context.tenant?.slug ?? "default",
        error: "Name required. Slug must start with letter/digit and contain only lowercase, digits, hyphens, underscores.",
      }));
    }

    // Check for duplicate slug.
    const existing = await deps.repo.getTenantBySlug(slug);
    if (existing) {
      const tenants = await deps.repo.listTenants();
      return htmlPage(TenantsPage({
        user: event.context.user!.username,
        tenants,
        currentTenantSlug: event.context.tenant?.slug ?? "default",
        error: `Tenant with slug "${slug}" already exists.`,
      }));
    }

    // Create tenant record.
    await deps.repo.createTenant({
      name,
      slug,
      max_kiosks: maxKiosks,
      max_cameras: maxCameras,
      max_users: maxUsers,
    });

    // Create PG schema and run tenant migrations.
    await createTenantSchema(
      deps.repo.adapter,
      slug,
      {
        info: (m) => { /* swallow */ },
        warn: (m) => { /* swallow */ },
      },
    );

    return new Response(null, { status: 302, headers: { location: "/admin/tenants" } });
  });

  // ---- Edit tenant page -----------------------------------------------------

  app.get("/admin/tenants/:id", async (event) => {
    if (!isPg()) return new Response("multi-tenant requires postgres", { status: 404 });
    const id = getRouterParam(event, "id") ?? "";
    const tenant = await deps.repo.getTenantById(id);
    if (!tenant) return new Response(null, { status: 302, headers: { location: "/admin/tenants" } });
    return htmlPage(TenantEditPage({
      user: event.context.user!.username,
      tenant,
    }));
  });

  // ---- Update tenant --------------------------------------------------------

  app.post("/admin/tenants/:id", async (event) => {
    if (!isPg()) return new Response("multi-tenant requires postgres", { status: 404 });
    const id = getRouterParam(event, "id") ?? "";
    const body = await readBody<Record<string, string>>(event);
    const name = (body?.["name"] ?? "").trim();
    const isActive = body?.["is_active"] === "on" || body?.["is_active"] === "true";
    const maxKiosks = body?.["max_kiosks"] ? parseInt(body["max_kiosks"], 10) : null;
    const maxCameras = body?.["max_cameras"] ? parseInt(body["max_cameras"], 10) : null;
    const maxUsers = body?.["max_users"] ? parseInt(body["max_users"], 10) : null;

    if (!name) {
      const tenant = await deps.repo.getTenantById(id);
      if (!tenant) return new Response(null, { status: 302, headers: { location: "/admin/tenants" } });
      return htmlPage(TenantEditPage({
        user: event.context.user!.username,
        tenant,
        error: "Name is required.",
      }));
    }

    await deps.repo.updateTenant(id, {
      name,
      is_active: isActive,
      max_kiosks: maxKiosks,
      max_cameras: maxCameras,
      max_users: maxUsers,
    });
    return new Response(null, { status: 302, headers: { location: "/admin/tenants" } });
  });

  // ---- Delete tenant --------------------------------------------------------

  app.post("/admin/tenants/:id/delete", async (event) => {
    if (!isPg()) return new Response("multi-tenant requires postgres", { status: 404 });
    const id = getRouterParam(event, "id") ?? "";
    const tenant = await deps.repo.getTenantById(id);
    if (!tenant) return new Response(null, { status: 302, headers: { location: "/admin/tenants" } });
    // Prevent deleting the default tenant.
    if (tenant.slug === "default") {
      return new Response(null, { status: 302, headers: { location: "/admin/tenants" } });
    }
    await deps.repo.deleteTenant(id);
    // Note: does NOT drop the PG schema. That's intentional for data safety.
    return new Response(null, { status: 302, headers: { location: "/admin/tenants" } });
  });

  // ---- Switch active tenant -------------------------------------------------

  app.post("/admin/tenants/switch", async (event) => {
    if (!isPg()) return new Response("multi-tenant requires postgres", { status: 404 });
    const body = await readBody<Record<string, string>>(event);
    const slug = (body?.["tenant_slug"] ?? "default").trim().toLowerCase();

    // Validate the tenant exists and is active.
    const tenant = await deps.repo.getTenantBySlug(slug);
    const targetSlug = tenant?.is_active ? tenant.slug : "default";

    // Set the bf_tenant cookie. MaxAge = 1 year (long-lived, session-like).
    return redirectWithCookie(
      "/admin/",
      { name: "bf_tenant", value: targetSlug, maxAge: 365 * 24 * 60 * 60 },
    );
  });
}
