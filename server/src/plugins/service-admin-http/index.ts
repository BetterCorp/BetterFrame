/**
 * service-admin-http - h3 listener for admin UI and admin API.
 *
 * Port 18080 behind Angie proxy. Initializes secrets + auth as
 * shared modules (not BSB plugins).
 */
import * as av from "anyvali";
import type { Infer } from "anyvali";
import { AdminRuntime, publishAdminRuntime, unpublishAdminRuntime } from "../../shared/admin/runtime.js";
import {
  BSBService,
  type BSBServiceConstructor,
  createConfigSchema,
  createEventSchemas,
  type Observable,
} from "@bsb/base";
import { H3, getRequestHeader, serve } from "h3";
import type { Server } from "srvx";

import type { Repository } from "../../shared/db/repository.js";
import { type SecretsApi } from "../../shared/secrets.js";
import { type AuthApi } from "../../shared/auth.js";
import {
  type NoderedBridge,
} from "../../shared/nodered-bridge.js";
import { type FirmwareApi } from "../../shared/firmware.js";
import { type OsUpdateApi } from "../../shared/os-updates.js";
import { serverVersion } from "../../shared/version.js";

import { registerMiddleware } from "./middleware.js";
import { registerSetupRoutes } from "./routes-setup.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerLogRoutes } from "./routes-logs.js";
import { registerAdminRoutes } from "./routes-admin.js";
import { registerAccountRoutes } from "./routes-account.js";
import { registerFirmwareRoutes } from "./routes-firmware.js";
import { registerOsUpdateRoutes } from "./routes-os-updates.js";
import { registerStaticRoutes } from "./routes-static.js";
import { registerCloudRoutes } from "./routes-cloud.js";
import { registerTenantRoutes } from "./routes-tenants.js";
import { registerAbleSignRoutes } from "./routes-ablesign.js";

export const ConfigSchema = av.object(
  {
    db: av.object(
      {
        url: av.string().default(""),
        host: av.string().default("postgres"),
        port: av.int().min(1).max(65535).default(5432),
        database: av.string().default("betterframe"),
        user: av.string().default("betterframe"),
        password: av.string().default("betterframe"),
        poolMax: av.int().min(1).max(1000).default(10),
      },
      { unknownKeys: "strip" },
    ),
    host: av.string().default("127.0.0.1"),
    port: av.int().min(1).max(65535).default(18080),
    enableDemoTenant: av.bool().default(false),
    sandboxMode: av.bool().default(false),
    dataDir: av.string().minLength(1).default("/var/lib/betterframe"),
    systemdCredsName: av.string().default("betterframe-secret"),
    kioskLogRetentionHours: av.int().min(1).max(8760).default(24),
    sessionIdleSeconds: av.int().min(60).default(43200),
    sessionMaxSeconds: av.int().min(3600).default(2592000),
    loginLockoutThreshold: av.int().min(1).default(8),
    loginLockoutSeconds: av.int().min(1).default(900),
    argon2Memory: av.int().min(8).default(65536),
    argon2TimeCost: av.int().min(1).default(3),
    argon2Parallelism: av.int().min(1).default(2),
    totpIssuer: av.string().minLength(1).default("BetterFrame"),
    cookieName: av.string().minLength(1).default("betterframe_session"),
    noderedUrl: av.string().minLength(1).default("http://127.0.0.1:1880"),
    selfUrl: av.string().minLength(1).default("http://127.0.0.1:18080"),
    systemdCredsDir: av.string().default(""),
    firmwareSigningKey: av.string().default(""),
    firmwareSigningKeyBase64: av.string().default(""),
    clientFirmwarePublicKey: av.string().default(""),
    clientFirmwarePublicKeyBase64: av.string().default(""),
    firmwareImportApiKey: av.string().default(""),
    otaImportApiKey: av.string().default(""),
  },
  { unknownKeys: "strip" },
);

export type AdminConfig = Infer<typeof ConfigSchema>;

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

export interface AdminDeps {
  bpTenant?: import("../../shared/types.js").Tenant;
  sandboxMode?: boolean;
  enableDemoTenant?: boolean;
  repo: Repository;
  auth: AuthApi;
  secrets: SecretsApi;
  cookieName: string;
  nodered: NoderedBridge;
  firmware: FirmwareApi;
  osUpdates: OsUpdateApi;
  dataDir: string;
  clientFirmwarePublicKey?: string;
  firmwareImportApiKey?: string;
  otaImportApiKey?: string;
  scheduleNoderedReconcile: () => void;
}

export class Plugin extends BSBService<InstanceType<typeof Config>, typeof EventSchemas> {
  static override Config = Config;
  static override EventSchemas = EventSchemas;

  initBeforePlugins?: string[];
  initAfterPlugins?: string[];
  runBeforePlugins?: string[];
  runAfterPlugins?: string[];

  private server?: Server;
  private runtime?: AdminRuntime;

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super(cfg);
  }

  async init(obs: Observable): Promise<void> {
    const runtime = this.runtime = new AdminRuntime(this.config);
    await runtime.init(obs);
    publishAdminRuntime(runtime);
    const deps = runtime.deps;
    try {
    const self = this;
    const app = new H3({
      onRequest: (event) => {
        const method = event.req.method ?? "GET";
        const path = event.req.url ?? "/";
        const reqObs = self.createTrace(`${method} ${path}`, {
          "http.method": method,
          "http.url": path,
        });
        reqObs.log.info("{method} {path}", { method, path });
        event.context.obs = reqObs;
        (event.context as any)._startMs = Date.now();
      },
      onError: (error, event) => {
        const reqObs = event.context.obs;
        const path = event.req.url ?? "unknown";
        const attributes = {
          "http.method": event.req.method ?? "unknown",
          "http.path": path,
          "http.status_code": Number((error as any).statusCode ?? (error as any).status ?? 500),
        };
        if (!reqObs) {
          obs.error(error, attributes);
          return;
        }
        reqObs.error(error, attributes);
      },
      onResponse: (response, event) => {
        const reqObs = event.context.obs;
        if (!reqObs) return;
        const ms = Date.now() - ((event.context as any)._startMs ?? Date.now());
        const status = response.status ?? 200;
        const path = event.req.url ?? "unknown";
        reqObs.log.info("{status} {path} {ms}ms", { status, path, ms });
        reqObs.end();
      },
    });

    registerMiddleware(app, deps);
    registerStaticRoutes(app, this.pluginCwd);
    registerSetupRoutes(app, deps);
    registerAuthRoutes(app, deps);
    registerAdminRoutes(app, deps);
    registerLogRoutes(app, deps);
    registerAccountRoutes(app, deps);
    registerFirmwareRoutes(app, deps);
    registerOsUpdateRoutes(app, deps);
    registerCloudRoutes(app, deps);
    registerTenantRoutes(app, deps);
    registerAbleSignRoutes(app, deps);

    app.get("/api/admin/_check", async (event) => {
      if (!event.context.user || !event.context.tenant) return new Response(null, { status: 401 });
      if (event.context.user.role !== "admin") return new Response(null, { status: 403 });
      return new Response(null, {
        status: 200,
        headers: {
          "x-betterframe-user": event.context.user.username,
          "x-betterframe-tenant": event.context.tenant.id,
          "x-betterframe-tenant-slug": event.context.tenant.slug,
          "x-betterframe-role": event.context.user.role,
        },
      });
    });

    app.get("/healthz", () => ({ status: "ok" }));
    app.get("/readyz", async () => {
      try {
        await deps.repo.isSetupComplete();
        return { status: "ready" };
      } catch {
        return { status: "not_ready" };
      }
    });
    app.get("/version", () => ({
      name: "betterframe",
      version: serverVersion(),
      now: new Date().toISOString(),
    }));
    app.get("/", async () => {
      if (!(await deps.repo.isSetupComplete())) {
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

    } catch (error) {
      unpublishAdminRuntime(runtime);
      await runtime.dispose();
      throw error;
    }
  }

  async run(obs: Observable): Promise<void> {
    await this.runtime?.run(obs);
  }

  async dispose(): Promise<void> {
    if (this.server) await this.server.close();
    if (this.runtime) {
      unpublishAdminRuntime(this.runtime);
      await this.runtime.dispose();
    }
  }
}
