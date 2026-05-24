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
    let pgUrl = config.pgUrl ?? "";
    if (!pgUrl) {
      const u = encodeURIComponent(config.pgUser);
      const p = encodeURIComponent(config.pgPassword);
      pgUrl = `postgres://${u}:${p}@${config.pgHost}:${config.pgPort}/${config.pgDatabase}`;
    }
    log.info(`connecting to postgres at ${pgUrl.replace(/:[^:@]+@/, ":***@")}`);

    const { PgAdapter } = await import("./pg-adapter.js");
    const adapter = new PgAdapter(pgUrl, config.pgPoolMax);

    // Run PG migrations. Track version in schema_migrations table.
    const { TENANT_MIGRATIONS } = await import("./migrations-pg.js");
    const versionRow = await adapter.get<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE schema_name = 'public'`,
    ).catch(() => undefined);
    const currentVersion = versionRow?.version ?? 0;
    if (currentVersion < TENANT_MIGRATIONS.length) {
      log.info(`running PG migrations from ${currentVersion} to ${TENANT_MIGRATIONS.length}`);
      // Ensure schema_migrations exists (bootstrap).
      await adapter.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        schema_name TEXT NOT NULL, version INTEGER NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (schema_name, version)
      )`);
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
