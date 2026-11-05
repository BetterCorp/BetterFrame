# BetterPortal server frontend migration preparation

Verified 2026-09-28. Scope: BetterFrame's server-hosted administrator frontend.
The existing [migration plan](betterportal-admin-migration-plan.md) remains the target architecture. Implementation has started; see [current implementation and test handoff](betterportal-implementation.md).

## Ownership decision — 2026-11-04

BP owns tenant creation and selection, users, authentication, membership, roles, and permissions. Frame declares operation requirements and enforces BP authorization; it does not provide tenant/user/permission creation or maintain a parallel human access store.

For each authorized request, use the verified BP tenant ID to ensure local Frame resources: reuse an existing ready scope, or initialize missing local schema/defaults/integrations exactly once. Multiple authorized BP apps in the same tenant share that local scope. Existing Frame data needs an explicit migration mapping. Provisioning must be idempotent under concurrent requests, retry partial failures safely, and never recreate revoked or archived tenants. Raw tenant headers do not authorize setup. The full flow is in the migration plan's BP ownership section.

The source/dependency pins below were inspected in September; this November ownership decision does not revalidate those versions.

## Current baseline

- Refreshed `plan/betterportal-admin-migration` by fast-forward to fetched BetterFrame `origin/master`, `794138a`.
- Local BetterPortal source: `176032c`, package version `10.6.24`. This is a local source baseline, not verification of deployed or published packages.
- Current BP hello-view example requires framework/plugin-bsb `10.6.24`, BSB `^9.7.3`, AnyVali `^1.1.6`, JSX-HTMX `4.0.100`. Frame still declares BSB `^9.6.87`, AnyVali `^1.1.0`, JSX-HTMX `^2.0.2`. Dependency upgrade and legacy JSX rendering verification must precede integration.
- Canonical application identity remains `cloud.betterportal.frame`.

## Repeatable route audit

Run from the worktree root:

```sh
python3 scripts/inventory-admin-routes.py
python3 scripts/inventory-admin-routes.py --check
```

The CSV now contains 217 registrations, retaining the previously reviewed dispositions and refreshing source lines. Four added routes cover diagnostic log pages/detail and display defaults. Newly discovered routes get `NEEDS_REVIEW`; refresh does not automatically approve their retirement. Review the CSV diff, including removed routes, before committing.

This is a source inventory, not a TypeScript parser or proof of runtime reachability. It covers `app.METHOD` calls in the admin HTTP plugin, expands the two explicitly recognized loops, and fails on unknown dynamic registrations or duplicates. It excludes middleware, other plugins, proxy rewrites, WebSocket upgrades, and external callers; those remain separate manual audits. Commented examples could require manual review.

## Changes since the initial plan

| Area | Required migration treatment |
| --- | --- |
| Kiosk diagnostics | Port `/admin/logs`, `/admin/kiosks/:id/diagnostics`, and JSON `/admin/logs/:id`; preserve tenant search path, filters, `no-store`, missing/expired 404, and navigation cleanup. |
| Background lifecycle | Include the new kiosk log retention timer and in-flight purge guard in shared runtime ownership alongside camera health, artifact cleanup, audit/event purge, AbleSign sync and Node-RED reconciliation. |
| Backup/restore | Current legacy archive POSTs intentionally return 409 because SQLite archives cannot preserve PostgreSQL. Do not port them as working backup operations. Document PostgreSQL plus key/material recovery and prove it independently. |
| Display defaults | Include `/admin/settings/display-defaults` in settings mutation parity, permission checks and propagation validation. |
| Windows updates | Preserve platform-specific update selection and package handling when porting firmware controls; validate alongside Linux and Android. |
| Node-RED dashboards | Preserve the current tenant-isolated dashboard proxy and display-scoped access. An editor session bridge must not broaden dashboard access. |

## First implementation slice

1. Make a dependency-only change using the matching BP packages and example build hooks. Keep the existing static-copy build step. Run clean installation, build, tests and a legacy-page browser smoke before proceeding.
2. Extract runtime ownership from `service-admin-http/index.ts` so database/secrets, coordinator access and maintenance work have one owner. Prove startup, partial failure cleanup and shutdown before adding another listener.
3. Add an opt-in BP service in the existing process with a single overview read. Use generated route contracts, explicit per-operation authorization, and a small redacted response schema; do not expose repository records directly.
4. Verify BP identity, tenant/app and operation permissions before local lookup. Reuse the tenant resource scope or automatically provision it under a cross-process lock; use explicit migration mappings for existing data. Deny revoked/archived or unverified tenants. Record BP principal attribution without a second Frame user/permission system.
5. Render overview content inside the BP shell. Prove HTML and JSON, denied access, concurrent tenant isolation, legacy coexistence and continued fleet health during BP outage before migrating another page.

Before step 3 can be exercised end-to-end, record the destination BP app/provider, shell renderer, allowed origins, existing-data mapping, BP account transition procedure, tenant lifecycle propagation and service installation state. These inputs remain unverified; Bootstrap1/bootstrap5 is still only a proposal. No production credentials belong in this repository.

## Preparation validation

The inventory refresh and check run locally. Review matched the four additional registrations against current source and confirmed the two loop expansions. This preparation does not change server runtime or dependencies, and is not evidence of BP login, deployment, codegen, database migration or browser parity. Those are implementation gates above.
