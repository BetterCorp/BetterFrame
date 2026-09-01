/**
 * service-admin-http - h3 listener for admin UI and admin API.
 *
 * Port 18080 behind Angie proxy. Initializes secrets + auth as
 * shared modules (not BSB plugins).
 */
import * as av from "@anyvali/js";
import {
  BSBService,
  type BSBServiceConstructor,
  createConfigSchema,
  createEventSchemas,
  type Observable,
} from "@bsb/base";
import { H3, getRequestHeader, serve } from "h3";
import type { Server } from "srvx";

import type { DbConfig } from "../../shared/db/config.js";
import { initDb } from "../../shared/db/init.js";
import type { Repository } from "../../shared/db/repository.js";
import { initSecrets, type SecretsApi } from "../../shared/secrets.js";
import { createAuth, type AuthApi } from "../../shared/auth.js";
import {
  initNoderedBridge,
  type NoderedBridge,
  type NoderedTenantConfig,
} from "../../shared/nodered-bridge.js";
import { initFirmware, type FirmwareApi } from "../../shared/firmware.js";
import { initOsUpdates, type OsUpdateApi } from "../../shared/os-updates.js";
import { serverVersion } from "../../shared/version.js";

import { registerMiddleware } from "./middleware.js";
import { registerSetupRoutes } from "./routes-setup.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerAdminRoutes } from "./routes-admin.js";
import { registerAccountRoutes } from "./routes-account.js";
import { registerFirmwareRoutes } from "./routes-firmware.js";
import { registerOsUpdateRoutes } from "./routes-os-updates.js";
import { registerStaticRoutes } from "./routes-static.js";
import { registerCloudRoutes } from "./routes-cloud.js";
import { registerTenantRoutes } from "./routes-tenants.js";
import { registerAbleSignRoutes } from "./routes-ablesign.js";

const ConfigSchema = av.object(
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
    dataDir: av.string().minLength(1).default("/var/lib/betterframe"),
    systemdCredsName: av.string().default("betterframe-secret"),
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
    firmwareImportApiKey: av.string().default(""),
    otaImportApiKey: av.string().default(""),
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

export interface AdminDeps {
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
  private dbClose?: () => Promise<void>;
  private purgeTimer?: ReturnType<typeof setInterval>;
  private cameraHealthChecker?: { stop: () => void };
  private artifactCleanup?: { stop: () => void };
  private _deps?: AdminDeps;
  private noderedReconcilePromise: Promise<void> = Promise.resolve();
  private _repo?: Repository;

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super(cfg);
  }

  async init(obs: Observable): Promise<void> {
    const dataDir = this.config.dataDir;
    const noderedUrl = this.config.noderedUrl;
    const selfUrl = this.config.selfUrl;
    const cookieName = this.config.cookieName;
    const totpIssuer = this.config.totpIssuer;

    const dbResult = await initDb(
      this.config.db as DbConfig,
      {
        info: (m) => obs.log.info(m as any, {}),
        warn: (m) => obs.log.warn(m as any, {}),
      },
    );
    const repo = dbResult.repo;
    this.dbClose = dbResult.close;

    const secrets = initSecrets(
      {
        dataDir,
        systemdCredsName: this.config.systemdCredsName,
        systemdCredsDir: this.config.systemdCredsDir || undefined,
      },
      { info: (m) => obs.log.info(m as any, {}), warn: (m) => obs.log.warn(m as any, {}) },
    );
    const auth = createAuth(repo, secrets, {
      sessionIdleSeconds: this.config.sessionIdleSeconds,
      sessionMaxSeconds: this.config.sessionMaxSeconds,
      loginLockoutThreshold: this.config.loginLockoutThreshold,
      loginLockoutSeconds: this.config.loginLockoutSeconds,
      argon2Memory: this.config.argon2Memory,
      argon2TimeCost: this.config.argon2TimeCost,
      argon2Parallelism: this.config.argon2Parallelism,
      totpIssuer,
      cookieName,
    });

    const nodered = initNoderedBridge(
      { baseUrl: noderedUrl },
      { info: (m) => obs.log.info(m as any, {}), warn: (m) => obs.log.warn(m as any, {}) },
    );

    const firmware = initFirmware(
      { dataDir, signingKeyPem: this.config.firmwareSigningKey || process.env["BF_FIRMWARE_SIGNING_KEY"] || undefined },
      { info: (m) => obs.log.info(m as any, {}), warn: (m) => obs.log.warn(m as any, {}) },
    );
    const osUpdates = initOsUpdates({ dataDir });

    const deps: AdminDeps = {
      repo,
      auth,
      secrets,
      cookieName,
      nodered,
      firmware,
      osUpdates,
      dataDir,
      clientFirmwarePublicKey: process.env["BF_CLIENT_FIRMWARE_PUBLIC_KEY"] || undefined,
      firmwareImportApiKey: this.config.firmwareImportApiKey || undefined,
      otaImportApiKey: this.config.otaImportApiKey || undefined,
      scheduleNoderedReconcile: () => {
        void this.scheduleNoderedReconcile(repo, secrets, auth, nodered, selfUrl, obs);
      },
    };

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
        const err = error.message ?? String(error);
        if (!reqObs) {
          obs.log.error("HTTP error {path}: {err} (no request trace)", { path, err });
          return;
        }
        reqObs.log.error("HTTP error {path}: {err}", { path, err });
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

    const { startCameraHealthChecker } = await import("../../shared/camera-health.js");
    this.cameraHealthChecker = startCameraHealthChecker(repo, {}, {
      info: (m) => obs.log.info(m as any, {}),
      warn: (m) => obs.log.warn(m as any, {}),
    });

    const { startArtifactCleanup } = await import("../../shared/artifact-cleanup.js");
    this.artifactCleanup = startArtifactCleanup(repo, {
      info: (m) => obs.log.info(m as any, {}),
      warn: (m) => obs.log.warn(m as any, {}),
    });

    deps.scheduleNoderedReconcile();

    this._repo = repo;
    this._deps = deps;
    void this.runPurge(obs);
  }

  private async runPurge(obs: Observable): Promise<void> {
    if (!this._repo) return;
    const r = this._repo;
    const kl = await r.purgeKioskLogs(14);
    const el = await r.purgeEventLog(30, 100_000);
    const al = await r.purgeAuditLog(90);
    if (kl + el + al > 0) {
      obs.log.info("purge: {kl} kiosk_logs, {el} event_log, {al} audit_log", { kl, el, al });
    }
  }

  async run(obs: Observable): Promise<void> {
    this.purgeTimer = setInterval(() => this.runPurge(obs), 6 * 60 * 60 * 1000);
    void this.syncAllAbleSignAccounts(obs);
  }

  private async syncAllAbleSignAccounts(obs: Observable): Promise<void> {
    if (!this._deps) return;
    const { syncAbleSignAccount } = await import("../../shared/ablesign-sync.js");
    const accounts = await this._deps.repo.listAbleSignAccounts();
    if (accounts.length === 0) return;
    obs.log.info("ablesign: background sync starting for {n} accounts", { n: accounts.length });
    for (const acct of accounts) {
      try {
        await syncAbleSignAccount(acct, this._deps.repo, this._deps.secrets);
      } catch (err) {
        obs.log.warn("ablesign: sync failed for account {name}: {err}", {
          name: acct.name,
          err: (err as Error).message,
        });
      }
    }
    obs.log.info("ablesign: background sync complete");
  }

  private async scheduleNoderedReconcile(
    repo: Repository,
    secrets: SecretsApi,
    auth: AuthApi,
    nodered: NoderedBridge,
    selfUrl: string,
    obs: Observable,
  ): Promise<void> {
    this.noderedReconcilePromise = this.noderedReconcilePromise.then(async () => {
      await this.provisionNoderedBridge(repo, secrets, auth, nodered, selfUrl, obs);
    }).catch((err) => {
      obs.log.warn("nodered: reconcile queue failed: {err}", { err: (err as Error).message });
    });
    await this.noderedReconcilePromise;
  }

  private async provisionNoderedBridge(
    repo: Repository,
    secrets: SecretsApi,
    auth: AuthApi,
    nodered: NoderedBridge,
    selfUrl: string,
    obs: Observable,
  ): Promise<void> {
    let tenantConfigs: NoderedTenantConfig[];
    try {
      tenantConfigs = await this.listNoderedTenantConfigs(repo, secrets, auth);
    } catch (err) {
      await repo.adapter.setSearchPath("public");
      obs.log.warn("nodered: build tenant configs failed: {err}", { err: (err as Error).message });
      return;
    }

    const delaysMs = [2000, 5000, 10000, 15000, 30000, 30000, 60000, 60000, 60000];
    for (let attempt = 0; attempt < delaysMs.length; attempt += 1) {
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
      obs.log.info("nodered: reconciling tenant configs ({count} tenants) attempt {n} -> {url}", {
        count: tenantConfigs.length,
        n: attempt + 1,
        url: selfUrl,
      });
      const result = await nodered.reconcileServerConfigs(selfUrl, tenantConfigs);
      if (result === "updated") {
        obs.log.info("nodered: tenant config reconcile updated flows at {url}", { url: selfUrl });
        return;
      }
      if (result === "noop") {
        obs.log.info("nodered: tenant config reconcile already up to date");
        return;
      }
    }
    obs.log.warn("nodered: tenant config reconcile gave up after retries");
  }

  private async listNoderedTenantConfigs(
    repo: Repository,
    secrets: SecretsApi,
    auth: AuthApi,
  ): Promise<NoderedTenantConfig[]> {
    const tenants = await repo.listTenants();
    const configs: NoderedTenantConfig[] = [];
    for (const tenant of tenants) {
      await repo.adapter.setSearchPath(tenant.schema_name);
      const apiKey = await this.getOrMintNoderedApiKey(repo, secrets, auth, tenant.slug);
      configs.push({
        tenant_id: tenant.id,
        tenant_slug: tenant.slug,
        tenant_name: tenant.name,
        api_key: apiKey,
        active: tenant.is_active,
      });
    }
    await repo.adapter.setSearchPath("public");
    return configs;
  }

  private async getOrMintNoderedApiKey(
    repo: Repository,
    secrets: SecretsApi,
    auth: AuthApi,
    tenantSlug: string,
  ): Promise<string> {
    const key = "nodered_api_keys";
    const stored = await repo.getSetupExtra(key);
    const current = stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
    const enc = typeof current[tenantSlug] === "string" ? current[tenantSlug] : "";
    if (enc.length > 0) {
      return secrets.decryptString(enc, "nodered_api_key");
    }
    const { plaintext } = await auth.createApiKey({
      name: "node-red-bridge",
      scopes: ["admin"],
      expiresAt: null,
    });
    current[tenantSlug] = secrets.encryptString(plaintext, "nodered_api_key");
    await repo.setSetupExtra(key, current);
    return plaintext;
  }

  async dispose(): Promise<void> {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.cameraHealthChecker?.stop();
    this.artifactCleanup?.stop();
    if (this.server) {
      await this.server.close();
    }
    await this.dbClose?.();
  }
}
