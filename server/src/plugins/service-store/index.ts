/**
 * service-store — the only service that opens the sqlite database.
 *
 * Architecture choice (v0.1):
 *   For now, other services hold a typed reference to this plugin's
 *   `Repository` instance via constructor injection (BSB plugin clients).
 *   We expose the high-level data API as plain methods rather than wiring
 *   every CRUD operation as a typed BSB event.
 *
 *   Reason: 60+ tables × 4 operations × 2 (input + output) anyvali schemas
 *   would be ~2000 lines of declarative bus plumbing. The event bus pays off
 *   when calls cross processes; in v0.1 everything is single-process.
 *
 *   When we scale `service-coordinator-ws` to multiple instances (one per N
 *   kiosks), we'll graduate the hot-path operations (bundle lookup, label
 *   filter) to typed returnable events and keep the rest as direct calls.
 *
 *   To-then: emit a domain-event broadcast on every write so listeners
 *   (e.g. coordinator-ws notifying kiosks of bundle changes) can react.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import * as av from "@anyvali/js";
import {
  BSBService,
  type BSBServiceConstructor,
  createConfigSchema,
  createEventSchemas,
  createBroadcastEvent,
  type Observable,
} from "@bsb/base";

import { MIGRATIONS } from "./migrations.js";
import { Repository } from "./repository.js";
import { registerRepo } from "../../shared/plugin-registry.js";
import { envStr } from "../../shared/env-overrides.js";

// ---- Config -----------------------------------------------------------------

const ConfigSchema = av.object(
  {
    /** Backend selector. Override at runtime via BF_DB env. */
    driver: av.enum_(["sqlite", "postgres"] as const).default("sqlite"),
    /** sqlite-only: filesystem path to the .db file. */
    sqlitePath: av.string().minLength(1).default("/var/lib/betterframe/betterframe.db"),
    /** postgres-only: full libpq URL. Override via BF_PG_URL env. */
    pgUrl: av.string().default(""),
  },
  { unknownKeys: "strip" },
);

export const Config = createConfigSchema(
  {
    name: "service-store",
    description:
      "BetterFrame canonical SQLite store. The single writer in the system; " +
      "all other services read/write through this plugin.",
    tags: ["service", "store", "sqlite"],
  },
  ConfigSchema,
);

// ---- Event schemas ----------------------------------------------------------

const broadcastDomainChange = av.object(
  {
    table: av.string(),
    op: av.enum_(["create", "update", "delete"] as const),
    id: av.optional(av.union([av.string(), av.int()])),
  },
  { unknownKeys: "reject" },
);

export const EventSchemas = createEventSchemas({
  emitEvents: {},
  onEvents: {},
  emitReturnableEvents: {},
  onReturnableEvents: {},
  emitBroadcast: {
    "store.changed": createBroadcastEvent(broadcastDomainChange, "Domain row changed"),
  },
  onBroadcast: {},
});

// ---- Plugin -----------------------------------------------------------------

export class Plugin extends BSBService<InstanceType<typeof Config>, typeof EventSchemas> {
  static override Config = Config;
  static override EventSchemas = EventSchemas;

  initBeforePlugins?: string[];
  initAfterPlugins?: string[];
  runBeforePlugins?: string[];
  runAfterPlugins?: string[];

  private db?: DatabaseSync;
  private _repo?: Repository;
  private purgeTimer?: ReturnType<typeof setInterval>;

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super(cfg);
  }

  async init(obs: Observable): Promise<void> {
    const driver = envStr("BF_DB", this.config.driver) as "sqlite" | "postgres";
    if (driver === "postgres") {
      // Repository conversion to the async DbAdapter interface is in progress.
      // Until that lands, refuse to start under postgres rather than corrupt
      // data via half-converted code paths. See db-adapter.ts / pg-adapter.ts
      // for the foundation already in place.
      throw new Error(
        "BF_DB=postgres: foundation present (pg-adapter.ts) but Repository " +
          "is still on the sync sqlite path. Pending refactor — keep BF_DB " +
          "unset (defaults to sqlite) or set BF_DB=sqlite explicitly.",
      );
    }

    const path = envStr("BF_SQLITE_PATH", this.config.sqlitePath);
    obs.log.info("opening sqlite at {path}", { path });

    // Ensure parent dir exists (in dev BETTERFRAME_DATA_DIR may be in $HOME)
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (err) {
      obs.log.warn("mkdir failed for {dir}: {err}", {
        dir: dirname(path),
        err: (err as Error).message,
      });
    }

    this.db = new DatabaseSync(path);

    // SQLite pragmas for an embedded one-writer setup
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 10000");

    // Track schema version via SQLite's built-in user_version PRAGMA.
    // Each migration entry runs exactly once across all server boots.
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    const currentVersion = row.user_version;
    const targetVersion = MIGRATIONS.length;

    if (currentVersion < targetVersion) {
      obs.log.info("running migrations from {from} to {to}", {
        from: currentVersion,
        to: targetVersion,
      });
      for (let i = currentVersion; i < targetVersion; i++) {
        const entry = MIGRATIONS[i];
        if (typeof entry === "string") {
          this.db.exec(entry);
        } else if (typeof entry === "function") {
          entry(this.db);
        }
      }
      this.db.exec(`PRAGMA user_version = ${targetVersion}`);
    } else {
      obs.log.info("schema up to date (version {v})", { v: currentVersion });
    }

    this._repo = new Repository(this.db, async (table, op, id) => {
      // Best-effort broadcast — never let a failed event-bus call fail a write.
      try {
        await this.events.emitBroadcast("store.changed", obs, { table, op, id });
      } catch (err) {
        obs.log.warn("broadcast store.changed failed: {err}", {
          err: (err as Error).message,
        });
      }
    });

    registerRepo(this._repo);

    const purged = this._repo.purgeOldKioskLogs(2);
    if (purged > 0) {
      obs.log.info("purged {count} kiosk logs older than 2h", { count: purged });
    }

    obs.log.info("store ready");
  }

  async run(obs: Observable): Promise<void> {
    this.purgeTimer = setInterval(() => {
      if (!this._repo) return;
      const purged = this._repo.purgeOldKioskLogs(2);
      if (purged > 0) {
        obs.log.info("purged {count} kiosk logs older than 2h", { count: purged });
      }
    }, 10 * 60 * 1000);
  }

  async dispose(): Promise<void> {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.db?.close();
  }

  /**
   * Public accessor for sibling services. Throws before init() completes —
   * services that need the repo should declare their initAfterPlugins
   * dependency on `service-store`.
   */
  get repo(): Repository {
    if (!this._repo) {
      throw new Error("service-store: repository accessed before init()");
    }
    return this._repo;
  }
}
