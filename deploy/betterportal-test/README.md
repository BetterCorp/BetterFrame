# Parallel BetterPortal test deployment

Use an isolated clone of the Frame database and a separate copy of the installation
`secret.key`. Never mount production storage as the Frame test server's writable data
volume. The test server should have only its BP port published through its generated
Easypanel hostname.

Required environment:

```text
BF_BP_ENABLED=true
BF_BP_HOST=0.0.0.0
BF_BP_CONTROL_PLANE_URL=https://config.eu.betterportal.net
BF_BP_INSTALLATION_ID=https://config.eu.betterportal.net
BF_SANDBOX_MODE=true
BF_ADMIN_HOST=127.0.0.1
BF_FLEET_API_ENABLED=false
BF_COORDINATOR_ENABLED=false
BF_NODERED_URL=http://127.0.0.1:9
BF_PG_HOST=<isolated test database service>
BF_PG_DB=<isolated test database>
BF_PG_USER=<test database user>
BF_PG_PASSWORD=<test database credential>
```

Copying the database does not authorize access to any existing tenant. BP still owns
users, tenants, and permission assignments. When linking existing data, configure
`service-betterportal-frame.config.existingTenantBindings` with the exact BP tenant
UUID and existing Frame tenant UUID (or provide the equivalent JSON array in `BF_BP_EXISTING_TENANT_BINDINGS`). This is an operator mapping, not a Frame tenant
creation API. Without a mapping, first authorized use provisions a fresh local scope.
Do not infer a mapping from matching display names or slugs.

The bootstrap service identity is `cloud.betterportal.frame`. Its default port is
18083. Health: `/.well-known/bp/health`. Discovery: `/.well-known/bp/manifest` and
`/.well-known/bp/schema.json`. The owner links it through BP, which sends the signed
setup token and control-plane URL to `POST /.well-known/bp/install`. Configure the
trusted CP URL before linking. Keep the generated bootstrap and config snapshot
files under the persistent `/var/lib/betterframe/bp` directory.

Mount the desired GET pages and their operation dependencies in the BP test app;
assign explicit permissions through BP. Installation itself grants no access.
Use a nonprivileged BP test account as well as an administrator when checking forms.
The legacy listener remains available only inside the test container for comparison.

Sandbox mode skips camera health checks, artifact/log cleanup, AbleSign background
sync and Node-RED reconciliation. The test configuration disables the fleet API and
coordinator listeners. BP device power and external cloud operations reject live
side effects in this mode. This allows local data/permission tests against a clone;
physical device and external vendor tests require a separate controlled fixture.

Do not cut over until the feature parity matrix, BP browser integration, Node-RED
bridge, remote debug grants, account recovery and rollback gates are complete.

## Database clone and persistence

With Easypanel's native PostgreSQL service, explicitly set
`PGDATA=/var/lib/postgresql/data/pgdata` for PostgreSQL 18. Its default data directory
is outside the native service's `/var/lib/postgresql/data` bind mount. Verify
`SHOW data_directory` and a service restart before restoring the snapshot.

Restore a completed, uniquely named dump into the isolated empty database. Hold a
single worker lock, use `pg_restore --single-transaction --exit-on-error --no-owner
--no-acl`, and retain the archive until restoration succeeds. A large event history
can take time to restore; do not restart the worker because the frontend is waiting.
Only create `/var/lib/betterframe/.bp-clone-complete` after database restoration and
installation-key copy/ownership have both completed. `BF_EXPECT_CLONE=true` makes
the test image wait for that marker before starting any Frame migrations.

The source database and source key are read only during copying. Remove source
credentials and mounts from the utility once the clone is complete. Keep test data
and the matching key in persistent storage. Never attach the test server to the
production database or production writable volumes.

The owner performs the BP installation/link after discovery and health checks pass.
No BP tenant, user, membership or permission is created by this deployment. Record
the BP tenant UUID and intended existing Frame tenant UUID before mapping cloned
data; linking the service alone does not bind existing tenant data.

## easy1 parallel test handoff, 2026-11-05

- Service: `betterframe/bp-test`.
- URL: https://frame-bp-test-b6084fe2.n3y1ei.easypanel.host
- Identity: `cloud.betterportal.frame`; renderer: `bootstrap5`.
- Trusted control plane: https://config.eu.betterportal.net
- Isolated PostgreSQL: `betterframe/bp-test-db`; full cloned snapshot (about 35 GB,
  including event history), with its matching installation key.
- Deployed application source: `257523f10354781057d684f9c13a3f73928e60a0`.
- BetterCorp BP tenant: `019ff668-98b8-7834-97df-868a46048327`, explicitly bound
  to existing Frame tenant `45d4483c-d9fc-40b0-8c15-6f2b1a2ace31`.
- Existing BetterCorp resources were adopted once by BP issuer
  `https://default-auth.eu.betterportal.net`, subject
  `01a0e0af-1ef5-7527-9ca1-9fc5b69a926a`, using migration ID
  `bettercorp-current-resources-2026-11-05`.

Read-only verification found all 141 existing records assigned: 46 cameras,
5 camera devices, 11 kiosks, 14 displays, 52 entities, 10 layouts, 2 labels and
1 AbleSign account. The remaining owned resource tables were empty.

The public manifest advertises tenant setting `userIsolationEnabled`, default
`false`. Enable it through BP tenant service configuration for per-user ownership;
leave it off for shared internal use. It applies across apps. Administrator access
still requires BP route grants, and Node-RED is administrator-only in either mode.
`BF_BP_EXISTING_RESOURCE_OWNERS` configures explicit one-time adoption; it does not
replace the BP setting or continuously claim newly unowned resources.

Frame's persistent bind points directly at the verified backing directory:
`/etc/easypanel/projects/betterframe/bp-test-clone/volumes/data`.
Do not bind another service to `/var/lib/docker/volumes/.../_data`: Easypanel's
local volume driver mounts the backing directory there while named-volume users
run. Stopping the last named-volume user unmounts it, and replacement bind tasks
can see an empty directory. Matching installation/bootstrap fingerprints and a
restart with both helpers stopped verify the direct backing-directory mount.

Retain the stopped `bp-test-clone` service definition and its backing data until
storage is deliberately moved. It no longer needs to run for Frame to see its
files. The inspection utility is stopped and its database credentials cleared.
No production source mounts or credentials remain on these utilities.

Sandbox mode remains enabled, the legacy listener binds loopback, and fleet/API
coordinator listeners are disabled. No production service, BP auth configuration,
role grant or production tenant setting was changed. The separate BP permission
sync fix remains unpublished and undeployed.

The service retains its BP link. Verify the linked BP shell and forms with both
administrator and restricted accounts; local Chromium checks cover Frame views
but do not replace the owner's authenticated BP session. Broader workflow parity
and production cutover remain gated by `docs/betterportal-implementation.md`.
