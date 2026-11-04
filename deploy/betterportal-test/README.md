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
