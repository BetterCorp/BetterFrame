/**
 * initDb — initialize the PostgreSQL database from config.
 *
 * Runs PUBLIC_MIGRATIONS (global tables) then TENANT_MIGRATIONS
 * (per-tenant schema). Creates default tenant if missing.
 */
import { Repository } from "./repository.js";
import type { DbAdapter } from "./db-adapter.js";
import type { DbConfig } from "./config.js";

interface DbLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export async function initDb(
  config: DbConfig,
  log: DbLog,
  notifyFn?: (table: string, op: string, id?: string | number) => void,
): Promise<{ repo: Repository; close: () => Promise<void> }> {
  const notify = notifyFn ?? (() => {});

  let pgUrl = config.url ?? "";
  if (!pgUrl) {
    const u = encodeURIComponent(config.user);
    const p = encodeURIComponent(config.password);
    pgUrl = `postgres://${u}:${p}@${config.host}:${config.port}/${config.database}`;
  }
  log.info(`connecting to postgres at ${pgUrl.replace(/:[^:@]+@/, ":***@")}`);

  const { PgAdapter } = await import("./pg-adapter.js");
  const adapter = new PgAdapter(pgUrl, config.poolMax);

  await adapter.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    schema_name TEXT NOT NULL, version INTEGER NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (schema_name, version)
  )`);

  const { PUBLIC_MIGRATIONS, TENANT_MIGRATIONS } = await import("./migrations-pg.js");
  const pubVersionRow = await adapter.get<{ version: number }>(
    `SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE schema_name = 'public_global'`,
  ).catch(() => undefined);
  const pubCurrentVersion = pubVersionRow?.version ?? 0;
  if (pubCurrentVersion < PUBLIC_MIGRATIONS.length) {
    log.info(`running PUBLIC migrations from ${pubCurrentVersion} to ${PUBLIC_MIGRATIONS.length}`);
    for (let i = pubCurrentVersion; i < PUBLIC_MIGRATIONS.length; i++) {
      try {
        await adapter.exec(PUBLIC_MIGRATIONS[i]!);
      } catch (err) {
        log.warn(`PUBLIC migration ${i} failed: ${(err as Error).message}`);
        log.warn(`SQL: ${PUBLIC_MIGRATIONS[i]!.slice(0, 200)}`);
        throw err;
      }
      await adapter.run(
        `INSERT INTO schema_migrations (schema_name, version) VALUES ('public_global', ?)`,
        [i + 1],
      );
    }
  } else {
    log.info(`PUBLIC schema up to date (version ${pubCurrentVersion})`);
  }

  const versionRow = await adapter.get<{ version: number }>(
    `SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE schema_name = 'public'`,
  ).catch(() => undefined);
  const currentVersion = versionRow?.version ?? 0;
  if (currentVersion < TENANT_MIGRATIONS.length) {
    log.info(`running PG tenant migrations from ${currentVersion} to ${TENANT_MIGRATIONS.length}`);
    for (let i = currentVersion; i < TENANT_MIGRATIONS.length; i++) {
      try {
        await adapter.exec(TENANT_MIGRATIONS[i]!);
      } catch (err) {
        log.warn(`PG migration ${i} failed: ${(err as Error).message}`);
        log.warn(`SQL: ${TENANT_MIGRATIONS[i]!.slice(0, 200)}`);
        throw err;
      }
      await adapter.run(
        `INSERT INTO schema_migrations (schema_name, version) VALUES ('public', ?)`,
        [i + 1],
      );
    }
  } else {
    log.info(`PG schema up to date (version ${currentVersion})`);
  }

  const defaultTenant = await adapter.get(
    `SELECT id FROM public.tenants WHERE slug = 'default'`,
  );
  if (!defaultTenant) {
    log.info("creating default tenant");
    await adapter.run(
      `INSERT INTO public.tenants (name, slug, schema_name, is_active)
       VALUES ('Default', 'default', 'public', true)`,
    );
  }

  const repo = new Repository(adapter, async (table, op, id) => {
    notify(table, op, id);
  });

  return { repo, close: () => adapter.close() };
}

/**
 * Create a new tenant schema and run all TENANT_MIGRATIONS inside it.
 */
export async function createTenantSchema(
  adapter: DbAdapter,
  slug: string,
  log: DbLog,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    throw new Error(`invalid tenant slug: ${slug}`);
  }
  const schemaName = `tenant_${slug}`;
  log.info(`creating tenant schema: ${schemaName}`);

  await adapter.exec(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  await adapter.setSearchPath(schemaName);

  try {
    const { TENANT_MIGRATIONS } = await import("./migrations-pg.js");

    const versionRow = await adapter.get<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0) AS version FROM public.schema_migrations WHERE schema_name = ?`,
      [schemaName],
    );
    const currentVersion = versionRow?.version ?? 0;

    if (currentVersion < TENANT_MIGRATIONS.length) {
      log.info(`running tenant migrations for ${schemaName} from ${currentVersion} to ${TENANT_MIGRATIONS.length}`);
      for (let i = currentVersion; i < TENANT_MIGRATIONS.length; i++) {
        try {
          await adapter.exec(TENANT_MIGRATIONS[i]!);
        } catch (err) {
          log.warn(`tenant migration ${i} failed for ${schemaName}: ${(err as Error).message}`);
          throw err;
        }
        await adapter.run(
          `INSERT INTO public.schema_migrations (schema_name, version) VALUES (?, ?)`,
          [schemaName, i + 1],
        );
      }
    }
  } finally {
    await adapter.setSearchPath("public");
  }
}
