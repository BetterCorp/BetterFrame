/**
 * initDb — initialize the database from config (shared module).
 *
 * Replaces the init logic that was in service-store/index.ts.
 * Each service plugin calls this independently with its own config.
 */
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import { MIGRATIONS } from "./migrations.js";
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
  const driver = config.driver;
  const notify = notifyFn ?? (() => {});

  if (driver === "postgres") {
    let pgUrl = config.url ?? "";
    if (!pgUrl) {
      const u = encodeURIComponent(config.user);
      const p = encodeURIComponent(config.password);
      pgUrl = `postgres://${u}:${p}@${config.host}:${config.port}/${config.database}`;
    }
    log.info(`connecting to postgres at ${pgUrl.replace(/:[^:@]+@/, ":***@")}`);

    const { PgAdapter } = await import("./pg-adapter.js");
    const adapter = new PgAdapter(pgUrl, config.poolMax);

    // Ensure schema_migrations exists (bootstrap).
    await adapter.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      schema_name TEXT NOT NULL, version INTEGER NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (schema_name, version)
    )`);

    // 1. Run PUBLIC_MIGRATIONS first (tenants + global_admins tables).
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

    // 2. Run TENANT_MIGRATIONS in the public schema (default tenant).
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

    // 3. Ensure default tenant exists.
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

  // SQLite path (default).
  const path = config.sqlitePath;
  log.info(`opening sqlite at ${path}`);

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    log.warn(`mkdir failed for ${dirname(path)}: ${(err as Error).message}`);
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 10000");

  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const currentVersion = row.user_version;
  const targetVersion = MIGRATIONS.length;

  if (currentVersion < targetVersion) {
    log.info(`running migrations from ${currentVersion} to ${targetVersion}`);
    for (let i = currentVersion; i < targetVersion; i++) {
      const entry = MIGRATIONS[i];
      if (typeof entry === "string") {
        db.exec(entry);
      } else if (typeof entry === "function") {
        entry(db);
      }
    }
    db.exec(`PRAGMA user_version = ${targetVersion}`);
  } else {
    log.info(`schema up to date (version ${currentVersion})`);
  }

  const { SqliteAdapter } = await import("./sqlite-adapter.js");
  const adapter = SqliteAdapter.fromExisting(db);

  const repo = new Repository(adapter, async (table, op, id) => {
    notify(table, op, id);
  });

  return { repo, close: () => adapter.close() };
}

/**
 * Create a new tenant schema and run all TENANT_MIGRATIONS inside it.
 * Called when a new tenant is created from the admin UI.
 *
 * @param adapter - the DB adapter (must be PG)
 * @param slug - tenant slug (used to derive schema name: `tenant_<slug>`)
 * @param log - logging callbacks
 */
export async function createTenantSchema(
  adapter: DbAdapter,
  slug: string,
  log: DbLog,
): Promise<void> {
  if (adapter.dialect() !== "postgres") {
    // SQLite is single-tenant — no schema creation needed.
    return;
  }
  // Validate slug to prevent SQL injection.
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    throw new Error(`invalid tenant slug: ${slug}`);
  }
  const schemaName = `tenant_${slug}`;
  log.info(`creating tenant schema: ${schemaName}`);

  // Create the schema.
  await adapter.exec(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);

  // Set search_path to the new schema for running tenant migrations.
  await adapter.setSearchPath(schemaName);

  try {
    // Run all TENANT_MIGRATIONS inside the new schema.
    const { TENANT_MIGRATIONS } = await import("./migrations-pg.js");

    // Ensure schema_migrations tracking for this schema.
    // Use the public schema_migrations table (always in public).
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
    // Always reset search_path back to public.
    await adapter.setSearchPath("public");
  }
}
