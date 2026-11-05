# BetterPortal implementation and parallel testing

Implementation in progress, 2026-11-05, based on Frame master `7405d20` and released
BP framework/plugin-bsb `11.0.3`. The legacy admin adapter remains available while
native BP operations and renderers are tested. This is not yet a cutover-ready migration.

## Implemented

- One shared admin runtime for database/secrets, artifact maintenance, camera health,
  log retention, AbleSign background sync and Node-RED reconciliation. The BP HTTP
  adapter consumes that runtime without initializing another copy. Initialization
  failure closes resources; shutdown cancels queued reconciliation waits.
- Opt-in BP service `cloud.betterportal.frame` on port 18083, with generated registry,
  typed request/response schemas, Bootstrap5 content renderers and service contract.
  BP verifies users and per-operation grants. Frame supplies no parallel human login,
  user directory, tenant creation UI or permission assignment store.
- Verified BP tenant first-use resource initialization with a database lock and unique
  installation/tenant binding; atomic rollback on setup failure; shared local scope
  for multiple BP apps in a tenant. Inactive/suspended/archived scopes deny access.
  Existing data supports explicit operator mappings without name/email adoption.
- Overview and native resource lists/details; core cameras/devices, entities, layouts,
  labels CRUD; kiosk/ioBOX/display metadata; layout cells and display assignments;
  device power delivery; kiosk pairing; label assignment operations; cloud account
  creation/sync/removal; audit/events/diagnostic reads; log filters/detail/pagination;
  tenant update schedules and new-display defaults.
- BP identity attribution in domain audit records. Credential-bearing models are
  projected into explicit response schemas. New BP camera credentials are encrypted
  at rest, with compatible readers in admin/API/coordinator repositories.
- A sandbox mode and deployment flags for testing a cloned database without starting
  fleet listeners or background integrations. [Test setup](../deploy/betterportal-test/README.md).

Some operations have API coverage while their full editing UI still needs expansion.
Generated routes and action mounts do not by themselves demonstrate workflow parity.

## Tenant resource access

BP advertises `frame.tenant.access` with the protected tenant setting
`userIsolationEnabled` (boolean, default `false`). Frame reads the tenant service
configuration without an app override, so all apps in the tenant share one policy.

- Off: resources are shared within the tenant, subject to each BP route grant.
- On: ordinary users also need ownership, identified by verified `(iss, sub)`.
  The signed role ID `admin` can access all resources in the same tenant and still
  needs the operation's BP grant. Ownership never bypasses tenant validation.
- Node-RED entities, dashboard access and integration management require `admin`
  in either mode. Domain change notifications do not grant editor access.

Ownership is recorded even while isolation is off. Displays inherit their kiosk's
owner; device/cloud cameras inherit their source's owner; camera entities inherit
camera ownership; cells inherit their layout. When isolation is on, references must
have the same effective owner. Lists, log/event pagination and audit reads are
scoped at the database boundary. Unregistered repository capabilities fail closed.
Tenant settings are administrator-only while user isolation is enabled.

Existing rows are adopted only through an explicit operator migration. Set
`BF_BP_EXISTING_RESOURCE_OWNERS` to a JSON array of
`{bpTenantId,migrationId,issuer,subject}` after configuring the exact tenant binding.
An advisory lock and migration marker make adoption atomic and one-time. Conflicting
existing ownership aborts adoption; later unowned rows are not silently reassigned
on restart. There is no public owner reassignment or tenant creation endpoint.

## Existing Bootstrap 5 views

The current page set uses common tables, grouped navigation, responsive form widths,
readable log timestamps and separate device power controls. Settings use named days
and grouped sections; cloud account actions stay in their table rows; layout-cell
fields wrap on mobile. Content creation offers only accessible camera names and
keeps Node-RED choices administrator-only. Routes, permissions and BP shell ownership
are preserved; this visual pass does not establish full legacy workflow parity.

Mobbin references reviewed for the implementation: [Twingate device table](https://mobbin.com/screens/c4e244f2-98bc-4041-b9d2-8adeff7741f7),
[Tailscale grouped settings](https://mobbin.com/screens/8559486f-e190-4aaa-a495-3c0733d7f5a3),
[Better Stack settings](https://mobbin.com/screens/b8185ef6-65d3-43df-8c4b-2e35b8fcf230),
and [1Password activity log](https://mobbin.com/screens/4df9de3d-fe83-46ba-b832-33c3ffbc48df).
The references inform structure; Frame retains Bootstrap 5 and the BP shell.

## Verified locally

The server build, generated BP contract, and complete server suite run against a
disposable PostgreSQL 18 database. Integration tests use signed JWTs and real HTTP
requests to prove denied users do not provision tenants, method permissions are
required, wrong tenant/app/issuer/audience and expired tokens are denied, concurrent
first use initializes once, setup failure rolls back, tenant queries remain isolated,
cell parent substitution and overlap are denied, audit failure rolls back mutations,
and API responses omit camera credentials. Runtime tests cover sandbox startup and
partial-failure cleanup. The full suite has 162 passing tests with no PostgreSQL skips. Ownership tests
cover shared/isolated modes, cross-user CRUD and references, issuer collisions,
admin grants, inherited fleet resources and one-time adoption. A disposable browser
harness checks all 27 GET pages at desktop/mobile widths and in dark mode, plus
native kiosk save and both settings form submissions. It does not replace checking
the real BP shell with the owner's authenticated session.

The actual BSB process was also started with both legacy
and BP listeners and both health endpoints returned 200.

Run from the repository root:

```sh
npm ci
BF_TEST_PG_URL=postgres://<test-admin>:<test-password>@127.0.0.1:5432/postgres npm test
npm run build
npm -w server run bp:check
python3 scripts/inventory-admin-routes.py --check
```

The database account must be able to create/drop disposable databases. Tests never
migrate the database named by `BF_TEST_PG_URL` itself. Without it PostgreSQL cases
skip, which does not satisfy the migration gate. `pretest` regenerates BP route
runtime files so tests also work on a fresh checkout before the first build.

## Remaining before full parity and cutover

- Owner links the parallel service in BP; mount pages/dependencies, assign grants,
  and configure explicit mappings to cloned existing tenant data. Verify real browser
  shell/login/logout, cross-origin behavior, navigation and forms after that link.
- Complete ONVIF discovery/actions and media transport; richer layout/display/device
  editing; ioBOX provisioning/mappings; firmware and OS upload/rollout/policy workflows;
  AbleSign screens/content/playlists/groups; managed-device configuration and remaining
  operational tools. Preserve capability checks, signatures and machine caller contracts.
- Implement and prove the BP-authorized Node-RED editor session bridge and short-lived
  coordinator debug/terminal grants, including elevation, revocation and expiry.
- Exercise existing-install mapping, retained fleet and CI contracts, provider account
  recovery, backup/restore, test-device command delivery and rollback with the linked app.
- Resolve every legacy route inventory disposition with test evidence before retiring
  human login or redirecting production entry points. Production cutover is deferred.

Rollback during parallel testing uses the retained legacy frontend in this compatible
server image. An older binary cannot decode newly encrypted `bf-camera:` credentials;
do not roll back those writes to an older image lacking the compatibility reader.
Retain the matching installation key and use a compatible server image for rollback.
