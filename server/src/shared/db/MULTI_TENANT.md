# Multi-Tenant Architecture

## Current Design

- **Single admin user** — global admin, full access to all tenants
- **No per-tenant logins** — one admin manages everything
- **Tenant = data isolation boundary** — each tenant gets its own PG schema
- **Admin switches tenants** via dropdown in topbar (session-stored)
- **User management deferred** — if/when we want per-tenant user logins, that's a separate feature

## How It Works

1. `PUBLIC_MIGRATIONS` create `tenants` + `global_admins` tables in `public` schema
2. Each tenant gets a PG schema: `tenant_<slug>` (e.g. `tenant_acme`)
3. `TENANT_MIGRATIONS` run inside each tenant schema (full table set per tenant)
4. Admin creates tenants from the admin UI
5. Middleware sets `search_path = tenant_<slug>` per request based on selected tenant
6. All repo queries automatically scope to the active tenant's schema

## What's NOT Happening

- No per-tenant admin users (single global admin for now)
- No tenant-specific auth (global session, tenant is just a context switch)
- No tenant billing/limits enforcement (max_kiosks/max_cameras columns exist but unenforced)
- No tenant API keys (all API keys are global)

## Future: Per-Tenant Users

When needed, add:
- Per-tenant `users` table (already in TENANT_MIGRATIONS)
- Login scoped to tenant (tenant slug in login URL or selection)
- Role-based access per tenant
- Separate from global admin
