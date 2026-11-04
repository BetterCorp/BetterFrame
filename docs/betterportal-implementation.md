# BetterPortal implementation and parallel testing

Implementation in progress, 2026-11-04, based on Frame master `7405d20` and released
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

## Verified locally

The server build, generated BP contract, and complete server suite run against a
disposable PostgreSQL 18 database. Integration tests use signed JWTs and real HTTP
requests to prove denied users do not provision tenants, method permissions are
required, wrong tenant/app/issuer/audience and expired tokens are denied, concurrent
first use initializes once, setup failure rolls back, tenant queries remain isolated,
cell parent substitution and overlap are denied, audit failure rolls back mutations,
and API responses omit camera credentials. Runtime tests cover sandbox startup and
partial-failure cleanup. The actual BSB process was also started with both legacy
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
