/**
 * service-admin-http — h3 listener for the admin UI and admin API.
 *
 * Serves jsx-htmx rendered pages at /admin/* and JSON endpoints at
 * /api/admin/*. Port 18080 behind the Angie proxy.
 */
import * as av from "@anyvali/js";
import {
  BSBService,
  type BSBServiceConstructor,
  createConfigSchema,
  createEventSchemas,
  type Observable,
} from "@bsb/base";
import { H3, serve } from "h3";
import type { Server } from "srvx";

import type { Plugin as StorePlugin } from "../service-store/index.js";
import type { Plugin as AuthPlugin } from "../service-auth/index.js";
import type { Plugin as SecretsPlugin } from "../service-secrets/index.js";

import { registerMiddleware } from "./middleware.js";
import { registerSetupRoutes } from "./routes-setup.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerAdminRoutes } from "./routes-admin.js";
import { registerAccountRoutes } from "./routes-account.js";
import { registerStaticRoutes } from "./routes-static.js";

// ---- Config -----------------------------------------------------------------

const ConfigSchema = av.object(
  {
    host: av.string().default("127.0.0.1"),
    port: av.int().min(1).max(65535).default(18080),
  },
  { unknownKeys: "strip" },
);

export const Config = createConfigSchema(
  {
    name: "service-admin-http",
    description: "h3 HTTP server for admin UI and admin API endpoints.",
    tags: ["service", "http", "admin"],
  },
  ConfigSchema,
);

export const EventSchemas = createEventSchemas({
  emitEvents: {},
  onEvents: {},
  emitReturnableEvents: {},
  onReturnableEvents: {},
  emitBroadcast: {},
  onBroadcast: {},
});

// ---- Deps interface shared with route modules -------------------------------

export interface AdminDeps {
  store: StorePlugin;
  auth: AuthPlugin;
  secrets: SecretsPlugin;
  cookieName: string;
}

// ---- Plugin -----------------------------------------------------------------

export class Plugin extends BSBService<InstanceType<typeof Config>, typeof EventSchemas> {
  static override Config = Config;
  static override EventSchemas = EventSchemas;

  initBeforePlugins?: string[];
  initAfterPlugins?: string[] = ["service-store", "service-secrets", "service-auth"];
  runBeforePlugins?: string[];
  runAfterPlugins?: string[];

  private _store?: StorePlugin;
  private _auth?: AuthPlugin;
  private _secrets?: SecretsPlugin;
  private server?: Server;

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super(cfg);
  }

  // TODO(handoff): replace with BSB plugin clients
  setSiblings(store: StorePlugin, auth: AuthPlugin, secrets: SecretsPlugin): void {
    this._store = store;
    this._auth = auth;
    this._secrets = secrets;
  }

  get store(): StorePlugin {
    if (!this._store) throw new Error("service-admin-http: siblings not wired");
    return this._store;
  }

  get auth(): AuthPlugin {
    if (!this._auth) throw new Error("service-admin-http: siblings not wired");
    return this._auth;
  }

  get secrets(): SecretsPlugin {
    if (!this._secrets) throw new Error("service-admin-http: siblings not wired");
    return this._secrets;
  }

  async init(obs: Observable): Promise<void> {
    const app = new H3();
    const deps: AdminDeps = {
      store: this.store,
      auth: this.auth,
      secrets: this.secrets,
      cookieName: this.auth.config.cookieName,
    };

    // Order matters: middleware first, then routes
    registerMiddleware(app, deps);
    registerStaticRoutes(app);
    registerSetupRoutes(app, deps);
    registerAuthRoutes(app, deps);
    registerAdminRoutes(app, deps);
    registerAccountRoutes(app, deps);

    // Health/readiness/version (no auth)
    app.get("/healthz", () => ({ status: "ok" }));
    app.get("/readyz", () => {
      try {
        deps.store.repo.isSetupComplete(); // touches DB
        return { status: "ready" };
      } catch {
        return { status: "not_ready" };
      }
    });
    app.get("/version", () => ({
      name: "betterframe",
      version: "0.1.0",
      now: new Date().toISOString(),
    }));

    // Root redirect
    app.get("/", () => {
      if (!deps.store.repo.isSetupComplete()) {
        return new Response(null, { status: 302, headers: { location: "/setup" } });
      }
      return new Response(null, { status: 302, headers: { location: "/admin/" } });
    });

    this.server = serve(app, {
      port: this.config.port,
      hostname: this.config.host,
    });

    obs.log.info("admin-http listening on {host}:{port}", {
      host: this.config.host,
      port: this.config.port,
    });
  }

  async run(_obs: Observable): Promise<void> {}

  async dispose(): Promise<void> {
    if (this.server) {
      await this.server.close();
    }
  }
}
