/**
 * service-admin-http — h3 listener for admin UI and admin API.
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
import { H3, serve } from "h3";
import type { Server } from "srvx";

import { getRepo } from "../../shared/plugin-registry.js";
import { initSecrets, type SecretsApi } from "../../shared/secrets.js";
import { createAuth, type AuthApi } from "../../shared/auth.js";
import { initNoderedBridge, type NoderedBridge } from "../../shared/nodered-bridge.js";
import { initFirmware, type FirmwareApi } from "../../shared/firmware.js";
import type { Repository } from "../service-store/repository.js";

import { registerMiddleware } from "./middleware.js";
import { registerSetupRoutes } from "./routes-setup.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerAdminRoutes } from "./routes-admin.js";
import { registerAccountRoutes } from "./routes-account.js";
import { registerFirmwareRoutes } from "./routes-firmware.js";
import { registerStaticRoutes } from "./routes-static.js";

// ---- Config -----------------------------------------------------------------

const ConfigSchema = av.object(
  {
    host: av.string().default("127.0.0.1"),
    port: av.int().min(1).max(65535).default(18080),
    // Secrets config (was service-secrets)
    dataDir: av.string().minLength(1).default("/var/lib/betterframe"),
    systemdCredsName: av.string().default("betterframe-secret"),
    // Auth config (was service-auth)
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
    // URL Node-RED uses to reach this server. Native: localhost. Docker: container name.
    selfUrl: av.string().minLength(1).default("http://127.0.0.1:18080"),
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
  repo: Repository;
  auth: AuthApi;
  secrets: SecretsApi;
  cookieName: string;
  nodered: NoderedBridge;
  firmware: FirmwareApi;
}

// ---- Plugin -----------------------------------------------------------------

export class Plugin extends BSBService<InstanceType<typeof Config>, typeof EventSchemas> {
  static override Config = Config;
  static override EventSchemas = EventSchemas;

  initBeforePlugins?: string[];
  initAfterPlugins?: string[] = ["service-store"];
  runBeforePlugins?: string[];
  runAfterPlugins?: string[];

  private server?: Server;

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super(cfg);
  }

  async init(obs: Observable): Promise<void> {
    // Init shared modules — no inter-plugin wiring needed
    const repo = getRepo();
    const secrets = initSecrets(
      { dataDir: this.config.dataDir, systemdCredsName: this.config.systemdCredsName },
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
      totpIssuer: this.config.totpIssuer,
      cookieName: this.config.cookieName,
    });

    const nodered = initNoderedBridge(
      { baseUrl: this.config.noderedUrl },
      { info: (m) => obs.log.info(m as any, {}), warn: (m) => obs.log.warn(m as any, {}) },
    );

    const firmware = initFirmware(
      { dataDir: this.config.dataDir },
      { info: (m) => obs.log.info(m as any, {}), warn: (m) => obs.log.warn(m as any, {}) },
    );

    const deps: AdminDeps = {
      repo,
      auth,
      secrets,
      cookieName: this.config.cookieName,
      nodered,
      firmware,
    };

    const app = new H3();

    registerMiddleware(app, deps);
    registerStaticRoutes(app);
    registerSetupRoutes(app, deps);
    registerAuthRoutes(app, deps);
    registerAdminRoutes(app, deps);
    registerAccountRoutes(app, deps);
    registerFirmwareRoutes(app, deps);

    // Auth-check endpoint for Angie auth_request subrequest.
    // Returns 200 if session cookie is valid + admin role, 401 otherwise.
    app.get("/api/admin/_check", (event) => {
      const authz = event.req.headers.get("authorization");
      if (authz?.startsWith("Bearer ")) {
        return deps.auth.verifyApiKey(authz.slice(7), event.req.headers.get("x-real-ip")).then((key) => {
          if (!key || !key.scopes.includes("admin")) return new Response(null, { status: 401 });
          return new Response(null, {
            status: 200,
            headers: { "x-betterframe-api-key": key.key_prefix },
          });
        });
      }

      const cookie = event.req.headers.get("cookie") ?? "";
      const match = cookie.match(new RegExp(`${deps.cookieName}=([^;]+)`));
      if (!match) return new Response(null, { status: 401 });
      const resolved = deps.auth.resolveSession(match[1]!);
      if (!resolved || resolved.session.totp_pending) {
        return new Response(null, { status: 401 });
      }
      if (resolved.user.role !== "admin") {
        return new Response(null, { status: 403 });
      }
      return new Response(null, {
        status: 200,
        headers: { "x-betterframe-user": resolved.user.username },
      });
    });

    app.get("/healthz", () => ({ status: "ok" }));
    app.get("/readyz", () => {
      try {
        deps.repo.isSetupComplete();
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
    app.get("/", () => {
      if (!deps.repo.isSetupComplete()) {
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

    // Auto-provision the Node-RED bf-server-config so the user doesn't have
    // to set server URL + API key manually. Best-effort with retries because
    // Node-RED may still be starting.
    void this.provisionNoderedBridge(repo, secrets, auth, nodered, obs);
  }

  async run(_obs: Observable): Promise<void> {}

  private async provisionNoderedBridge(
    repo: Repository,
    secrets: SecretsApi,
    auth: AuthApi,
    nodered: NoderedBridge,
    obs: Observable,
  ): Promise<void> {
    let plaintext: string;
    try {
      plaintext = await this.getOrMintNoderedApiKey(repo, secrets, auth);
    } catch (err) {
      obs.log.warn("nodered: mint key failed: {err}", { err: (err as Error).message });
      return;
    }

    // Retry with backoff — Node-RED may still be booting + initial flow load
    // can take 30-60s on the Pi. Total wait ~5 minutes worst case.
    const delaysMs = [2000, 5000, 10000, 15000, 30000, 30000, 60000, 60000, 60000];
    for (let attempt = 0; attempt < delaysMs.length; attempt += 1) {
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
      obs.log.info("nodered: provisioning attempt {n} → {url}", {
        n: attempt + 1,
        url: this.config.selfUrl,
      });
      const result = await nodered.ensureServerConfig(this.config.selfUrl, plaintext);
      if (result === "created") {
        obs.log.info("nodered: provisioned bf-server-config at {url}", {
          url: this.config.selfUrl,
        });
        return;
      }
      if (result === "exists") {
        obs.log.info("nodered: bf-server-config already present, skipping");
        return;
      }
    }
    obs.log.warn("nodered: provisioning bf-server-config gave up after retries");
  }

  private async getOrMintNoderedApiKey(
    repo: Repository,
    secrets: SecretsApi,
    auth: AuthApi,
  ): Promise<string> {
    const KEY = "nodered_api_key";
    const stored = repo.getSetupExtra(KEY);
    if (typeof stored === "string" && stored.length > 0) {
      return secrets.decryptString(stored, "nodered_api_key");
    }
    const { plaintext } = await auth.createApiKey({
      name: "node-red-bridge",
      scopes: ["admin"],
      expiresAt: null,
    });
    repo.setSetupExtra(KEY, secrets.encryptString(plaintext, "nodered_api_key"));
    return plaintext;
  }

  async dispose(): Promise<void> {
    if (this.server) {
      await this.server.close();
    }
  }
}
