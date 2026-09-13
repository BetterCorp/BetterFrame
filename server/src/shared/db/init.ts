/**
 * initDb — initialize the PostgreSQL database from config.
 *
 * Runs PUBLIC_MIGRATIONS (global tables) then TENANT_MIGRATIONS
 * (per-tenant schema). Creates default tenant if missing.
 */
import { Repository } from "./repository.js";
import type { DbAdapter } from "./db-adapter.js";
import type { DbConfig } from "./config.js";
import { tenantSchemaName } from "./tenant-schema.js";
import { quotedSchema } from "./platform-admin.js";
import { mirrorPlatformAdmins } from "./platform-admin.js";

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

  try {
    await adapter.transaction(async () => {
      // One transaction-scoped lock is shared by startup and tenant creation.
      await adapter.get("SELECT pg_advisory_xact_lock(734192081)");
      await adapter.exec(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
        schema_name TEXT NOT NULL, version INTEGER NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (schema_name, version)
      )`);
      const { PUBLIC_MIGRATIONS, TENANT_MIGRATIONS } = await import("./migrations-pg.js");
      await applyMigrations(adapter, "public_global", PUBLIC_MIGRATIONS, log);
      await applyMigrations(adapter, "public", TENANT_MIGRATIONS, log);
      await adapter.run(`INSERT INTO public.tenants (name, slug, schema_name, is_active)
        VALUES ('Default', 'default', 'public', true) ON CONFLICT (slug) DO NOTHING`);
      const tenants = await adapter.all<{ slug: string; schema_name: string }>(
        "SELECT slug, schema_name FROM public.tenants WHERE slug <> 'default' ORDER BY created_at",
      );
      for (const tenant of tenants) {
        let schemaName = tenant.schema_name;
        // Repair registrations made by older builds with invalid/overlong names.
        if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schemaName)) {
          const repaired = tenantSchemaName(tenant.slug);
          const exists = await adapter.get("SELECT 1 FROM pg_namespace WHERE nspname = ?", [schemaName]);
          if (exists) {
            const oldQuoted = `"${schemaName.replaceAll('"', '""')}"`;
            await adapter.exec(`ALTER SCHEMA ${oldQuoted} RENAME TO ${quotedSchema(repaired)}`);
            await adapter.run("UPDATE public.schema_migrations SET schema_name = ? WHERE schema_name = ?", [repaired, schemaName]);
          }
          await adapter.run("UPDATE public.tenants SET schema_name = ? WHERE slug = ?", [repaired, tenant.slug]);
          schemaName = repaired;
        }
        await createTenantSchema(adapter, tenant.slug, log, schemaName);
      }
    });
  } catch (error) {
    await adapter.close();
    throw error;
  }

  const repo = new Repository(adapter, async (table, op, id) => {
    notify(table, op, id);
  });

  return { repo, close: () => adapter.close() };
}

/**
 * Create a new tenant schema and run all TENANT_MIGRATIONS inside it.
 */
async function applyMigrations(adapter: DbAdapter, name: string, migrations: readonly string[], log: DbLog): Promise<void> {
  const version = await adapter.get<{ version: number }>(
    "SELECT COALESCE(MAX(version), 0) AS version FROM public.schema_migrations WHERE schema_name = ?", [name],
  );
  for (let i = version?.version ?? 0; i < migrations.length; i++) {
    await adapter.transaction(async () => {
      await adapter.exec(migrations[i]!);
      await adapter.run("INSERT INTO public.schema_migrations (schema_name, version) VALUES (?, ?)", [name, i + 1]);
    });
  }
  log.info(`schema ${name} at migration ${migrations.length}`);
}

export async function createTenantSchema(
  adapter: DbAdapter, slug: string, log: DbLog, existingSchemaName?: string,
): Promise<void> {
  const schemaName = existingSchemaName ?? tenantSchemaName(slug);
  const quoted = quotedSchema(schemaName);
  await adapter.transaction(async () => {
    await adapter.get("SELECT pg_advisory_xact_lock(734192081)");
    await adapter.exec(`CREATE SCHEMA IF NOT EXISTS ${quoted}`);
    await adapter.withSearchPath(schemaName, async () => {
      const { TENANT_MIGRATIONS } = await import("./migrations-pg.js");
      await applyMigrations(adapter, schemaName, TENANT_MIGRATIONS, log);
      await mirrorPlatformAdmins(adapter, [schemaName]);
    });
  });
}
