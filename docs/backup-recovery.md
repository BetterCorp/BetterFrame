# PostgreSQL backup and recovery

The retired browser `.bfbak` workflow copied a SQLite database file. It does not
back up PostgreSQL. Its download/restore routes now return 409 before reading
uploads or changing keys. Keep old archives for historical recovery, but never
restore their keys over a current deployment.

Install `age` on the deployment host. Run as root (to preserve container file
ownership) from the directory and Compose project
used for the deployment (set `COMPOSE_FILE=docker-compose.coolify.yml` when
appropriate):

```sh
bash deploy/scripts/backup-stack.sh /secure/backups/betterframe.tar.age
```

The command briefly stops server and Node-RED, obtains a PostgreSQL custom-format
dump, copies the server data/key volume and all Node-RED manager/tenant data,
restarts previously running services, and encrypts the archive with age. The
passphrase is entered into age's terminal prompt. Store it separately. Free
space must accommodate both the unencrypted staging copy and encrypted output;
the private staging directory is removed on exit. For multiple server replicas,
stop every writer and use an equivalent coordinated snapshot procedure.

Deployment configuration and externally supplied secrets (including private
signing keys provided through environment/Vault) must be retained separately in
the deployment secret manager. Do not export them into logs or Git. This backup
requires the normal file-backed `secret.key`; deployments using an external
system credential need a coordinated backup of that same credential.

## Restore into a fresh deployment

1. Create a new isolated Compose project with empty volumes and matching
   PostgreSQL major version. Do not attach production volumes. Retain the
   original deployment until validation succeeds.
2. Decrypt to a private staging file first, so authentication finishes before
   archive extraction. Extract only into a newly created empty directory:

   ```sh
   umask 077
   mkdir recovery
   age --decrypt -o recovery/stack.tar /secure/backups/betterframe.tar.age
   tar -tf recovery/stack.tar
   mkdir recovery/files
   sudo tar --numeric-owner --same-owner -xpf recovery/stack.tar -C recovery/files
   ```

3. Start only PostgreSQL in the new project. Restore the dump with
   `pg_restore --exit-on-error --single-transaction --no-owner` against the
   empty database, using its configured database user. For the supplied Compose:

   ```sh
   docker compose up -d postgres
   docker compose exec -T postgres sh -c 'exec pg_restore --exit-on-error --single-transaction --no-owner --username="$POSTGRES_USER" --dbname="${POSTGRES_DB:-$POSTGRES_USER}"' < recovery/files/postgres.dump
   ```

4. Create the server and Node-RED containers without starting them. Copy
   `server-data/.` to the server's `/var/lib/betterframe/`, and `nodered-data/.`
   to Node-RED's `/data/` on those new containers using `docker cp -a`. Preserve original numeric
   ownership and permissions, particularly each Node-RED tenant UID/GID and
   the manager's root-only state file. Restore matching deployment secrets.
5. Start the new services. Verify tenant/user counts, camera and layout data,
   key decryption, Node-RED flows, and a test device's existing credentials.
   Confirm that a fresh backup can be restored again. Only then switch traffic.
6. Remove decrypted staging files after the validation and retention decisions.

## PostgreSQL 18 volume correction

Both Compose files now mount `pgdata` at `/var/lib/postgresql`, matching the
official image's `/var/lib/postgresql/18/docker` data directory. Existing users
of `compose.yaml` must back up and inspect the actual running database's mounts
before recreation: the old named `/var/lib/postgresql/data` mount may not hold
the live cluster. Do not assume an empty named volume means there is no data.
Restore into a fresh correctly mounted project using the procedure above.
