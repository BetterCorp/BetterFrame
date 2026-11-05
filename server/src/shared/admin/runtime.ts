import { setTimeout as delay } from "node:timers/promises";
import type { Observable } from "@bsb/base";
import type { DbConfig } from "../db/config.js";
import { initDb } from "../db/init.js";
import type { Repository } from "../db/repository.js";
import { purgeTenantKioskLogs } from "../kiosk-log-retention.js";
import { initSecrets, type SecretsApi } from "../secrets.js";
import { createAuth, type AuthApi } from "../auth.js";
import { initNoderedBridge, type NoderedBridge, type NoderedTenantConfig } from "../nodered-bridge.js";
import { initFirmware } from "../firmware.js";
import { initOsUpdates } from "../os-updates.js";
import type { AdminConfig, AdminDeps } from "../../plugins/service-admin-http/index.js";

/** One lifecycle owner for resources shared by the legacy and BP HTTP adapters. */
export class AdminRuntime {
  deps!: AdminDeps;
  private dbClose?: () => Promise<void>;
  private logPurgeTimer?: ReturnType<typeof setInterval>;
  private logPurgeRunning = false;
  private purgeTimer?: ReturnType<typeof setInterval>;
  private cameraHealthChecker?: { stop: () => void };
  private artifactCleanup?: { stop: () => void };
  private _deps?: AdminDeps;
  private _repo?: Repository;
  private noderedReconcilePromise: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();
  constructor(private readonly config: AdminConfig) {}

  async init(obs: Observable): Promise<void> {
    try {
      const dataDir = this.config.dataDir;
      const noderedUrl = this.config.noderedUrl;
      const selfUrl = this.config.selfUrl;
      const cookieName = this.config.cookieName;
      const totpIssuer = this.config.totpIssuer;

      const dbResult = await initDb(this.config.db as DbConfig, {
        info: (m) => obs.log.info(m as any, {}),
        warn: (m) => obs.log.warn(m as any, {}),
      });
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
      repo.setCameraCredentialCodec(secrets);

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
        {
          dataDir,
          signingKeyPem:
            this.config.firmwareSigningKey ||
            (this.config.firmwareSigningKeyBase64
              ? Buffer.from(this.config.firmwareSigningKeyBase64, "base64").toString("utf8")
              : undefined),
        },
        { info: (m) => obs.log.info(m as any, {}), warn: (m) => obs.log.warn(m as any, {}) },
      );
      const osUpdates = initOsUpdates({ dataDir });

      const deps: AdminDeps = {
        repo,
        sandboxMode: this.config.sandboxMode,
        auth,
        secrets,
        cookieName,
        nodered,
        firmware,
        osUpdates,
        dataDir,
        clientFirmwarePublicKey:
          this.config.clientFirmwarePublicKey ||
          (this.config.clientFirmwarePublicKeyBase64
            ? Buffer.from(this.config.clientFirmwarePublicKeyBase64, "base64").toString("utf8")
            : undefined),
        firmwareImportApiKey: this.config.firmwareImportApiKey || undefined,
        otaImportApiKey: this.config.otaImportApiKey || undefined,
        enableDemoTenant: this.config.enableDemoTenant,
        scheduleNoderedReconcile: () => {
          if (this.config.sandboxMode) return;
          void this.scheduleNoderedReconcile(repo, secrets, auth, nodered, selfUrl, obs);
        },
      };

      this.deps = deps;
      if (!this.config.sandboxMode) {
        const { startCameraHealthChecker } = await import("../../shared/camera-health.js");
        this.cameraHealthChecker = startCameraHealthChecker(
          repo,
          {},
          {
            info: (m) => obs.log.info(m as any, {}),
            warn: (m) => obs.log.warn(m as any, {}),
          },
        );

        const { startArtifactCleanup } = await import("../../shared/artifact-cleanup.js");
        this.artifactCleanup = startArtifactCleanup(repo, {
          info: (m) => obs.log.info(m as any, {}),
          warn: (m) => obs.log.warn(m as any, {}),
        });
      }
      deps.scheduleNoderedReconcile();

      this._repo = repo;
      this._deps = deps;
      if (!this.config.sandboxMode) void this.runPurge(obs).catch(() => obs.log.warn("log cleanup failed"));
      if (!this.config.sandboxMode) void this.runLogPurge(obs);
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  private async runPurge(obs: Observable): Promise<void> {
    if (!this._repo) return;
    const r = this._repo;
    const el = await r.purgeEventLog(30, 100_000);
    const al = await r.purgeAuditLog(90);
    if (el + al > 0) {
      obs.log.info("purge: {el} event_log, {al} audit_log", { el, al });
    }
  }

  private async runLogPurge(obs: Observable): Promise<void> {
    if (!this._repo || this.logPurgeRunning) return;
    this.logPurgeRunning = true;
    try {
      await purgeTenantKioskLogs(this._repo, this.config.kioskLogRetentionHours, (message) =>
        obs.log.warn(message as any, {}),
      );
    } catch {
      obs.log.warn("kiosk log cleanup failed");
    } finally {
      this.logPurgeRunning = false;
    }
  }

  async run(obs: Observable): Promise<void> {
    if (this.config.sandboxMode) return;
    this.logPurgeTimer = setInterval(
      () => {
        void this.runLogPurge(obs);
      },
      5 * 60 * 1000,
    );
    this.purgeTimer = setInterval(
      () => {
        void this.runPurge(obs).catch(() => obs.log.warn("log cleanup failed"));
      },
      6 * 60 * 60 * 1000,
    );
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
    this.noderedReconcilePromise = this.noderedReconcilePromise
      .then(async () => {
        await this.provisionNoderedBridge(repo, secrets, auth, nodered, selfUrl, obs);
      })
      .catch((err) => {
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
      try {
        await delay(delaysMs[attempt], undefined, { signal: this.abort.signal });
      } catch {
        return;
      }
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
    const current = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
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
    this.abort.abort();
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    if (this.logPurgeTimer) clearInterval(this.logPurgeTimer);
    this.cameraHealthChecker?.stop();
    this.artifactCleanup?.stop();
    await this.noderedReconcilePromise;
    await this.dbClose?.();
    this.dbClose = undefined;
  }
}

let runtime: AdminRuntime | undefined;
export function publishAdminRuntime(value: AdminRuntime): void {
  if (runtime && runtime !== value) throw new Error("Frame runtime already initialized");
  runtime = value;
}
export function getAdminRuntime(): AdminRuntime {
  if (!runtime) throw new Error("Frame runtime is not ready");
  return runtime;
}
export function unpublishAdminRuntime(value: AdminRuntime): void {
  if (runtime === value) runtime = undefined;
}
