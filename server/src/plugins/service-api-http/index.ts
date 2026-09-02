/**
 * service-api-http — h3 listener for kiosk-facing REST API.
 *
 * Port 18081 behind Angie proxy. Handles pairing, bundle delivery,
 * heartbeat, and event forwarding.
 */
import * as av from "anyvali";
import {
  BSBService,
  type BSBServiceConstructor,
  createConfigSchema,
  createEventSchemas,
  type Observable,
} from "@bsb/base";
import { H3, serve, readBody, getRequestHeader, getRouterParam, createError } from "h3";
import type { Server } from "srvx";

import type { DbConfig } from "../../shared/db/config.js";
import { initDb } from "../../shared/db/init.js";
import type { Repository } from "../../shared/db/repository.js";
import { CLUSTER_SECRET_CONTEXT, initSecrets } from "../../shared/secrets.js";
import { createAuth } from "../../shared/auth.js";
import { initiatePairing, claimPairing } from "../../shared/pairing.js";
import { BundleGenerationError, generateBundle } from "../../shared/bundle.js";
import { initNoderedBridge, type NoderedBridge } from "../../shared/nodered-bridge.js";
import { initFirmware, type FirmwareApi } from "../../shared/firmware.js";
import { initOsUpdates, type OsUpdateApi } from "../../shared/os-updates.js";
import { createRateLimiter } from "../../shared/rate-limit.js";
import { initMqttBridge, type MqttBridge } from "../../shared/mqtt-bridge.js";
import { getCoordinator } from "../../shared/coordinator-registry.js";
import { normalizeUpdateSchedule, updateScheduleAllowsNow } from "../../shared/update-schedule.js";
import { normalizeFirmwareTarget } from "../../shared/firmware-targets.js";
import { withDefaultTenant } from "../../shared/default-tenant.js";
import { onvifCallbackTokenMatches } from "../../shared/onvif-callback-token.js";
import { createHash, randomBytes } from "node:crypto";
import type { AuthApi } from "../../shared/auth.js";
import type { SecretsApi } from "../../shared/secrets.js";
import type { FirmwareChannel, OsUpdateRelease } from "../../shared/types.js";
import {
  PairInitiateBody, PairClaimBody, HeartbeatBody, EventBody,
  KioskLogsBody, FirmwareAppliedBody, OsAppliedBody, OsStatusBody,
  IoBoxAnnounceBody, IoBoxPairClaimBody, IoBoxHeartbeatBody, IoBoxEventBody,
  validateBody,
} from "../../shared/api-schemas.js";

// ---- Config -----------------------------------------------------------------

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
    port: av.int().min(1).max(65535).default(18081),
    codeTtlSeconds: av.int().min(60).max(3600).default(600),
    // Secrets + auth config (shared with admin-http for now)
    dataDir: av.string().minLength(1).default("/var/lib/betterframe"),
    argon2Memory: av.int().min(8).default(65536),
    argon2TimeCost: av.int().min(1).default(3),
    argon2Parallelism: av.int().min(1).default(2),
    cookieName: av.string().minLength(1).default("betterframe_session"),
    sessionIdleSeconds: av.int().min(60).default(43200),
    sessionMaxSeconds: av.int().min(3600).default(2592000),
    loginLockoutThreshold: av.int().min(1).default(8),
    loginLockoutSeconds: av.int().min(1).default(900),
    totpIssuer: av.string().minLength(1).default("BetterFrame"),
    noderedUrl: av.string().minLength(1).default("http://127.0.0.1:1880"),
    /** MQTT broker URL (e.g. mqtt://broker:1883). Empty = disabled. */
    mqttUrl: av.string().default(""),
    mqttUsername: av.string().default(""),
    mqttPassword: av.string().default(""),
    mqttTopicPrefix: av.string().default("betterframe"),
    firmwareSigningKey: av.string().default(""),
    firmwareSigningKeyBase64: av.string().default(""),
    clientFirmwarePublicKey: av.string().default(""),
    clientFirmwarePublicKeyBase64: av.string().default(""),
  },
  { unknownKeys: "strip" },
);

export const Config = createConfigSchema(
  {
    name: "service-api-http",
    description: "h3 HTTP server for kiosk-facing REST API.",
    tags: ["service", "http", "api", "kiosk"],
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

// ---- Plugin -----------------------------------------------------------------

export class Plugin extends BSBService<InstanceType<typeof Config>, typeof EventSchemas> {
  static override Config = Config;
  static override EventSchemas = EventSchemas;

  initBeforePlugins?: string[];
  initAfterPlugins?: string[];
  runBeforePlugins?: string[];
  runAfterPlugins?: string[];

  private server?: Server;
  private dbClose?: () => Promise<void>;

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super(cfg);
  }

  async init(obs: Observable): Promise<void> {
    const dataDir = this.config.dataDir;
    const noderedUrl = this.config.noderedUrl;
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
      { dataDir },
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
    const codeTtl = this.config.codeTtlSeconds;
    const nodered = initNoderedBridge(
      { baseUrl: noderedUrl },
      { info: (m) => obs.log.info(m as any, {}), warn: (m) => obs.log.warn(m as any, {}) },
    );
    const firmware = initFirmware(
      {
        dataDir,
        signingKeyPem: this.config.firmwareSigningKey || (this.config.firmwareSigningKeyBase64
          ? Buffer.from(this.config.firmwareSigningKeyBase64, "base64").toString("utf8")
          : undefined),
      },
      { info: (m) => obs.log.info(m as any, {}), warn: (m) => obs.log.warn(m as any, {}) },
    );
    const osUpdates = initOsUpdates({ dataDir });
    const mqtt = initMqttBridge(
      {
        url: this.config.mqttUrl,
        username: this.config.mqttUsername || undefined,
        password: this.config.mqttPassword || undefined,
        topicPrefix: this.config.mqttTopicPrefix,
      },
      {
        info: (m) => obs.log.info(m as any, {}),
        warn: (m) => obs.log.warn(m as any, {}),
      },
    );

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

    // Keep the verified device schema active for the complete H3 middleware
    // and route chain. Setting AsyncLocalStorage inside an auth helper alone
    // does not cross back over the caller's await continuation.
    app.use(async (event, next) => {
      const path = new URL(event.req.url).pathname;
      if (path.startsWith("/api/kiosk/")) {
        const token = extractBearerToken(event);
        const kiosk = token ? await auth.verifyKioskKey(token) : null;
        if (!kiosk) return new Response(null, { status: 401 });
        (event.context as any).verifiedKiosk = kiosk;
        return repo.adapter.withSearchPath(kiosk.schema_name, next);
      }
      if (path.startsWith("/api/iobox/") &&
          path !== "/api/iobox/announce" && path !== "/api/iobox/pair/claim") {
        const token = extractBearerToken(event);
        const box = token ? await auth.verifyIoBoxKey(token) : null;
        if (!box) return new Response(null, { status: 401 });
        (event.context as any).verifiedIoBox = box;
        return repo.adapter.withSearchPath(box.schema_name, next);
      }
      return repo.adapter.withSearchPath("public", next);
    });

    app.get("/api/kiosk/_check", async (event) => {
      const kiosk = (event.context as any).verifiedKiosk;
      const token = authorizationBearerToken(event);
      const forwardedProto = getRequestHeader(event, "x-forwarded-proto")?.split(",", 1)[0]?.trim();
      const secure = forwardedProto
        ? forwardedProto.toLowerCase() === "https"
        : new URL(event.req.url).protocol === "https:";
      return new Response(null, {
        status: 200,
        headers: {
          "x-betterframe-kiosk-id": String(kiosk.id),
          "x-betterframe-tenant": kiosk.tenant_id,
          "x-betterframe-tenant-slug": kiosk.tenant_slug,
          ...(token ? { "set-cookie": kioskSessionCookie(token, secure) } : {}),
        },
      });
    });

    app.get("/api/key/_check", async (event) => {
      const token = extractBearerToken(event);
      if (!token) return new Response(null, { status: 401 });
      const key = await auth.verifyApiKey(token, getRequestHeader(event, "x-real-ip") ?? null);
      if (!key) return new Response(null, { status: 401 });
      return new Response(null, {
        status: 200,
        headers: {
          "x-betterframe-api-key": key.key_prefix,
          "x-betterframe-scopes": key.scopes.join(","),
        },
      });
    });

    const clientFirmwarePublicKey = this.config.clientFirmwarePublicKey || (this.config.clientFirmwarePublicKeyBase64
      ? Buffer.from(this.config.clientFirmwarePublicKeyBase64, "base64").toString("utf8")
      : "");
    registerPairingRoutes(app, repo, auth, secrets, codeTtl, firmware, osUpdates, clientFirmwarePublicKey);
    registerKioskRoutes(app, repo, auth, secrets, nodered, firmware, osUpdates, mqtt, clientFirmwarePublicKey);
    registerIoBoxRoutes(app, repo, auth, nodered, mqtt, firmware);

    this.server = serve(app, {
      port: this.config.port,
      hostname: this.config.host,
    });

    obs.log.info("api-http listening on {host}:{port}", {
      host: this.config.host,
      port: this.config.port,
    });
  }

  async run(_obs: Observable): Promise<void> {}

  async dispose(): Promise<void> {
    if (this.server) {
      await this.server.close();
    }
    await this.dbClose?.();
  }
}

// ---- Helpers ----------------------------------------------------------------

function extractBearerToken(event: any): string | null {
  const bearer = authorizationBearerToken(event);
  if (bearer) return bearer;
  // Fallback: check betterframe_kiosk_key cookie (WebView sub-resource
  // requests don't carry the Authorization header — only cookies persist).
  const cookieHeader = getRequestHeader(event, "cookie") ?? "";
  for (const pair of cookieHeader.split(";")) {
    const [k, ...rest] = pair.trim().split("=");
    if (k?.trim() === "betterframe_kiosk_key") {
      const val = rest.join("=").trim();
      if (val) return val;
    }
  }
  return null;
}

function authorizationBearerToken(event: any): string | null {
  const header = getRequestHeader(event, "authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

export function kioskSessionCookie(token: string, secure: boolean): string {
  return `betterframe_kiosk_key=${token}; Path=/; ${secure ? "Secure; " : ""}HttpOnly; SameSite=Strict`;
}

async function requireKiosk(
  event: any,
  _repo: Repository,
  _auth: AuthApi,
): Promise<{
  id: string;
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string | null;
  schema_name: string;
}> {
  const kiosk = event.context.verifiedKiosk;
  if (!kiosk) throw createError({ statusCode: 401, statusMessage: "Invalid kiosk key" });
  return kiosk;
}

async function requireIoBox(
  event: any,
  _repo: Repository,
  _auth: AuthApi,
): Promise<{
  id: string;
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string | null;
  schema_name: string;
}> {
  const box = event.context.verifiedIoBox;
  if (!box) throw createError({ statusCode: 401, statusMessage: "Invalid ioBOX key" });
  return box;
}

async function getClusterKey(repo: Repository, secrets: SecretsApi): Promise<string | undefined> {
  const enc = await repo.getSetupExtra("cluster_key_encrypted") as string | undefined;
  if (!enc) return undefined;
  try {
    return secrets.decryptString(enc, CLUSTER_SECRET_CONTEXT);
  } catch {
    return undefined;
  }
}

async function serveOsUpdateBundle(
  event: any,
  release: OsUpdateRelease,
  osUpdates: OsUpdateApi,
): Promise<Response> {
  const bundle = await osUpdates.streamBundle(release.artifact_path);
  const totalSize = bundle.size;
  const rangeHeader = getRequestHeader(event, "range");
  if (rangeHeader) {
    const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
    if (match) {
      const start = Number(match[1]);
      const requestedEnd = match[2] ? Number(match[2]) : totalSize - 1;
      const end = Math.min(requestedEnd, totalSize - 1);
      if (Number.isSafeInteger(start) && Number.isSafeInteger(requestedEnd) && start < totalSize && start <= end) {
        const rangeBundle = await osUpdates.streamBundle(release.artifact_path, start, end);
        return new Response(rangeBundle.body, {
          status: 206,
          headers: {
            "content-type": "application/vnd.rauc",
            "content-length": String(end - start + 1),
            "content-range": `bytes ${start}-${end}/${totalSize}`,
            "accept-ranges": "bytes",
            "x-bf-sha256": release.sha256,
            "x-bf-version": release.version,
          },
        });
      }
    }
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${totalSize}` } });
  }

  return new Response(bundle.body, {
    headers: {
      "content-type": "application/vnd.rauc",
      "content-length": String(totalSize),
      "accept-ranges": "bytes",
      "x-bf-sha256": release.sha256,
      "x-bf-version": release.version,
      "x-bf-compatibility": release.compatibility,
    },
  });
}

// ---- Pairing routes ---------------------------------------------------------

function registerPairingRoutes(
  app: H3,
  repo: Repository,
  auth: AuthApi,
  secrets: SecretsApi,
  codeTtl: number,
  firmware: FirmwareApi,
  osUpdates: OsUpdateApi,
  clientFirmwarePublicKey: string,
): void {
  // Constructed in-function so the BSB schema extractor (which evaluates the
  // module statically) doesn't see a top-level createRateLimiter call.
  const pairingGuard = createRateLimiter({ windowMs: 60_000, max: 20 });
  const claimGuard = createRateLimiter({ windowMs: 60_000, max: 60 });
  // Kiosk initiates pairing — no auth required
  app.post("/api/pair/initiate", async (event) => {
    const ip = getRequestHeader(event, "x-real-ip")
      ?? getRequestHeader(event, "x-forwarded-for")?.split(",")[0]?.trim()
      ?? "anon";
    if (!pairingGuard.take(`pair:${ip}`)) {
      throw createError({ statusCode: 429, statusMessage: "rate limited" });
    }

    const body = validateBody(PairInitiateBody, await readBody(event));

    const result = await initiatePairing(repo, {
      proposedName: body.proposed_name || null,
      hardwareModel: body.hardware_model || null,
      firmwareTarget: normalizeFirmwareTarget(body.firmware_target) || null,
      capabilities: body.capabilities,
      managedImage: body.managed_image,
      codeTtlSeconds: codeTtl,
    });

    return { code: result.code, expires_at: result.expiresAt };
  });

  // Kiosk polls for claim result — no auth required
  app.post("/api/pair/claim", async (event) => {
    const ip = getRequestHeader(event, "x-real-ip")
      ?? getRequestHeader(event, "x-forwarded-for")?.split(",")[0]?.trim()
      ?? "anon";
    if (!claimGuard.take(`claim:${ip}`)) {
      throw createError({ statusCode: 429, statusMessage: "rate limited" });
    }

    const body = validateBody(PairClaimBody, await readBody(event));
    const code = body.code.trim().toUpperCase();

    const reqObs = event.context.obs!;
    const result = await claimPairing(repo, code, secrets, reqObs);
    if (result.status === "pending") {
      return new Response(JSON.stringify({ status: "pending" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }

    reqObs.log.info("pair/claim success for code {code} kiosk {kioskId}", {
      code,
      kioskId: String(result.kioskId),
    });
    return {
      status: "claimed",
      kiosk_id: result.kioskId,
      kiosk_name: result.kioskName,
      kiosk_key: result.kioskKey,
      cluster_key: result.clusterKey,
      encrypt_key: result.encryptKey,
      bundle_url: result.bundleUrl,
    };
  });

  // Public firmware check — no auth. Used by kiosks on first boot before
  // pairing to self-update to latest stable binary. Always stable channel.
  app.get("/api/firmware/public/check", async (event) => {
    const url = new URL(event.req.url);
    const target = normalizeFirmwareTarget(
      url.searchParams.get("target")?.trim() || url.searchParams.get("arch")?.trim(),
    );
    if (!target) throw createError({ statusCode: 400, statusMessage: "target required" });
    const current = url.searchParams.get("current")?.trim() ?? "";

    const release = await withDefaultTenant(repo, null, () => repo.getLatestFirmwareRelease("stable", target));
    if (!release || release.version === current) {
      return { up_to_date: true };
    }

    return {
      up_to_date: false,
      update: {
        release_id: release.id,
        version: release.version,
        sha256: release.sha256,
        signature: release.signature,
        size_bytes: release.size_bytes,
        download_url: `/api/firmware/public/download/${release.id}`,
        // Older clients require this field; current clients ignore it and use their embedded key.
        public_key_pem: clientFirmwarePublicKey,
      },
    };
  });

  // Public firmware download — no auth. Rate-limited to prevent abuse.
  const publicDlGuard = createRateLimiter({ windowMs: 60_000, max: 5 });
  app.get("/api/firmware/public/download/:id", async (event) => {
    const ip = getRequestHeader(event, "x-real-ip")
      ?? getRequestHeader(event, "x-forwarded-for")?.split(",")[0]?.trim()
      ?? "anon";
    if (!publicDlGuard.take(`fwdl:${ip}`)) {
      throw createError({ statusCode: 429, statusMessage: "rate limited" });
    }

    const id = getRouterParam(event, "id") ?? "";
    const release = await withDefaultTenant(repo, null, () => repo.getFirmwareRelease(id));
    if (!release || release.yanked_at) {
      throw createError({ statusCode: 404, statusMessage: "release not found" });
    }

    const buf = await firmware.readBlob(release.artifact_path, release.sha256);
    return new Response(buf, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(buf.length),
        "x-bf-sha256": release.sha256,
        "x-bf-signature": release.signature,
      },
    });
  });

  // Public stable-channel OS bootstrap. RAUC verifies the bundle signature
  // against the keyring baked into the image before installing it.
  app.get("/api/os/public/check", async (event) => {
    const url = new URL(event.req.url);
    const compatibility = url.searchParams.get("compatibility")?.trim();
    if (!compatibility) throw createError({ statusCode: 400, statusMessage: "compatibility required" });
    const current = url.searchParams.get("current")?.trim() ?? "";
    const release = await withDefaultTenant(repo, null, () =>
      repo.getLatestOsUpdateRelease("stable", compatibility)
    );
    if (!release || release.version === current) return { up_to_date: true };
    return {
      up_to_date: false,
      update: {
        release_id: release.id,
        version: release.version,
        channel: release.channel,
        compatibility: release.compatibility,
        sha256: release.sha256,
        size_bytes: release.size_bytes,
        bundle_format: release.bundle_format,
        download_url: `/api/os/public/download/${release.id}`,
      },
    };
  });

  const publicOsDlGuard = createRateLimiter({ windowMs: 60_000, max: 20 });
  app.get("/api/os/public/download/:id", async (event) => {
    const ip = getRequestHeader(event, "x-real-ip")
      ?? getRequestHeader(event, "x-forwarded-for")?.split(",")[0]?.trim()
      ?? "anon";
    if (!publicOsDlGuard.take(`osdl:${ip}`)) {
      throw createError({ statusCode: 429, statusMessage: "rate limited" });
    }
    const id = getRouterParam(event, "id") ?? "";
    const release = await withDefaultTenant(repo, null, () => repo.getOsUpdateRelease(id));
    if (!release || release.yanked_at) {
      throw createError({ statusCode: 404, statusMessage: "release not found" });
    }
    return serveOsUpdateBundle(event, release, osUpdates);
  });
}

// ---- ioBOX routes -----------------------------------------------------------

function safeRouteMode(raw: string): "unknown" | "direct" | "proxy" | "server" | "offline" {
  return raw === "direct" || raw === "proxy" || raw === "server" || raw === "offline" ? raw : "unknown";
}

const ioBoxEventDedupCache = new Map<string, number>();

function remoteIp(event: any): string | null {
  return getRequestHeader(event, "x-real-ip")
    ?? getRequestHeader(event, "x-forwarded-for")?.split(",")[0]?.trim()
    ?? null;
}

function kioskDisplayName(kioskName: string, displayName: string): string {
  return `${kioskName}: ${displayBaseName(displayName)}`;
}

function displayBaseName(displayName: string): string {
  const idx = displayName.indexOf(": ");
  return idx >= 0 ? displayName.slice(idx + 2) : displayName;
}

export function findReportedDisplayMatch<T extends { id: string; name: string; index: number }>(
  existing: T[],
  seenDisplayIds: ReadonlySet<string>,
  reportedName: string,
  reportedIndex: number,
): T | undefined {
  return existing.find((display) =>
    !seenDisplayIds.has(display.id) && displayBaseName(display.name) === reportedName
  ) ?? existing.find((display) =>
    !seenDisplayIds.has(display.id) && display.index === reportedIndex
  );
}

async function resolveTenantForIoBoxClaim(repo: Repository, event: any): Promise<{ id: string | null; slug: string; schema_name: string }> {
  const requested = getRequestHeader(event, "x-betterframe-tenant")?.trim() || "default";
  const tenants = await repo.listTenants();
  if (tenants.length === 0) return { id: null, slug: "default", schema_name: "public" };
  const tenant = tenants.find((t) => t.slug === requested && t.is_active)
    ?? tenants.find((t) => t.slug === "default" && t.is_active)
    ?? tenants.find((t) => t.is_active);
  if (!tenant) throw createError({ statusCode: 400, statusMessage: "No active tenant" });
  return { id: tenant.id, slug: tenant.slug, schema_name: tenant.schema_name };
}

function registerIoBoxRoutes(
  app: H3,
  repo: Repository,
  auth: AuthApi,
  nodered: NoderedBridge,
  mqtt: MqttBridge,
  firmware: FirmwareApi,
): void {
  app.post("/api/iobox/announce", async (event) => {
    const body = validateBody(IoBoxAnnounceBody, await readBody(event));
    const serial = body.serial.trim();
    const registered = await repo.getIoBoxSerial(serial);
    if (!registered) return { status: "unknown_serial" };
    await repo.touchIoBoxSerial(serial);
    const model = await repo.getIoBoxModel(registered.model_id);
    return {
      status: registered.paired_iobox_id ? "registered_paired" : "registered_unpaired",
      serial: registered.serial,
      paired_iobox_id: registered.paired_iobox_id,
      model,
      server_time: new Date().toISOString(),
    };
  });

  app.post("/api/iobox/pair/claim", async (event) => {
    const body = validateBody(IoBoxPairClaimBody, await readBody(event));
    const serial = body.serial.trim();
    const registered = await repo.getIoBoxSerial(serial);
    if (!registered) throw createError({ statusCode: 404, statusMessage: "unknown serial" });
    if (registered.paired_iobox_id) throw createError({ statusCode: 409, statusMessage: "serial already paired" });
    const model = await repo.getIoBoxModel(registered.model_id);
    if (!model) throw createError({ statusCode: 400, statusMessage: "serial model missing" });

    const tenant = await resolveTenantForIoBoxClaim(repo, event);
    await repo.adapter.setSearchPath(tenant.schema_name);
    const plaintext = `bfio-${randomBytes(24).toString("base64url")}`;
    const box = await repo.createIoBox({
      serial,
      model_id: model.id,
      name: body.name?.trim() || `${model.name} ${serial}`,
      key_hash: await auth.hashPassword(plaintext),
      key_prefix: plaintext.slice(0, 8),
      assigned_display_id: body.assigned_display_id ?? null,
    });
    await repo.markIoBoxSerialPaired(serial, tenant.id, box.id);
    return {
      status: "claimed",
      tenant_slug: tenant.slug,
      iobox_id: box.id,
      iobox_key: plaintext,
      config_url: "/api/iobox/config",
      heartbeat_url: "/api/iobox/heartbeat",
    };
  });

  app.post("/api/iobox/heartbeat", async (event) => {
    const verified = await requireIoBox(event, repo, auth);
    const body = validateBody(IoBoxHeartbeatBody, await readBody(event));
    await repo.touchIoBox(verified.id, {
      firmware_version: body.firmware_version || null,
      config_applied_version: body.config_applied_version ?? null,
      config_error: body.config_error ?? null,
      route_mode: safeRouteMode(body.route_mode),
      local_last_ip: remoteIp(event),
      network_json: body.network && typeof body.network === "object" ? body.network as Record<string, unknown> : {},
    });
    return { ok: true, now: new Date().toISOString() };
  });

  app.get("/api/iobox/config", async (event) => {
    const verified = await requireIoBox(event, repo, auth);
    const box = await repo.getIoBoxById(verified.id);
    if (!box) throw createError({ statusCode: 404, statusMessage: "ioBOX not found" });
    const model = await repo.getIoBoxModel(box.model_id);
    let assignedDisplay = null;
    let localTarget = null;
    let mappings: unknown[] = [];
    if (box.assigned_display_id) {
      const display = await repo.getDisplayById(box.assigned_display_id);
      assignedDisplay = display;
      mappings = await repo.listIoBoxMappingsForDisplay(box.assigned_display_id);
      if (display?.kiosk_id) {
        const kiosk = await repo.getKioskById(display.kiosk_id);
        if (kiosk?.local_key) {
          const ifaces = kiosk.network_interfaces_json
            ? JSON.parse(kiosk.network_interfaces_json) as Array<{ ips?: string[] }>
            : [];
          const candidates = [
            ...(kiosk.local_last_ip ? [{ ip: kiosk.local_last_ip, port: kiosk.local_port ?? 18090 }] : []),
            ...ifaces.flatMap((iface) => (iface.ips ?? []).map((ip) => ({ ip: ip.split("/")[0], port: kiosk.local_port ?? 18090 }))),
          ].filter((c, idx, arr) => c.ip && arr.findIndex((x) => x.ip === c.ip && x.port === c.port) === idx);
          localTarget = {
            display_id: display.id,
            kiosk_id: kiosk.id,
            local_key: kiosk.local_key,
            candidates,
          };
        }
      }
    }
    return {
      iobox: {
        id: box.id,
        serial: box.serial,
        name: box.name,
        config_version: box.config_version,
        config: box.config_json,
      },
      model,
      assigned_display: assignedDisplay,
      local_target: localTarget,
      mappings,
    };
  });

  app.post("/api/iobox/event", async (event) => {
    const verified = await requireIoBox(event, repo, auth);
    const body = validateBody(IoBoxEventBody, await readBody(event));
    const box = await repo.getIoBoxById(verified.id);
    if (!box) throw createError({ statusCode: 404, statusMessage: "ioBOX not found" });
    if (body.event_id) {
      const dedupKey = `${box.id}:${body.event_id}`;
      const now = Date.now();
      const lastSeen = ioBoxEventDedupCache.get(dedupKey);
      if (lastSeen && now - lastSeen < 60_000) {
        return { ok: true, event_id: null, deduplicated: true };
      }
      ioBoxEventDedupCache.set(dedupKey, now);
      if (ioBoxEventDedupCache.size > 10_000) {
        const cutoff = now - 120_000;
        for (const [key, ts] of ioBoxEventDedupCache) {
          if (ts < cutoff) ioBoxEventDedupCache.delete(key);
        }
      }
    }
    const displayId = body.display_id ?? box.assigned_display_id ?? null;
    const payload = {
      ...(body.payload && typeof body.payload === "object" ? body.payload as Record<string, unknown> : {}),
      event_id: body.event_id ?? null,
      iobox_id: box.id,
      serial: box.serial,
      display_id: displayId,
      kind: body.kind,
      action: body.action ?? null,
      code: body.code ?? null,
      value: body.value ?? null,
      route: body.route ?? box.route_mode,
    };
    const eventId = await repo.insertEvent({
      source_kiosk_id: null,
      source_camera_id: null,
      source_iobox_id: box.id,
      ingress_path: "/api/iobox/event",
      source_type: "io",
      topic: body.topic,
      property_op: body.action ?? null,
      payload,
      forwarded_to_nodered: false,
    });
    const tenantInfo = { tenant_slug: verified.tenant_slug, tenant_name: verified.tenant_name };
    const out = {
      event_id: eventId,
      iobox_id: box.id,
      display_id: displayId,
      source_type: "io",
      topic: body.topic,
      kind: body.kind,
      action: body.action ?? null,
      code: body.code ?? null,
      payload,
      timestamp: new Date().toISOString(),
      source: "iobox",
    };
    let proxyResult: unknown = null;
    if ((body.route ?? box.route_mode) === "proxy" && displayId) {
      proxyResult = await proxyIoBoxEventToKiosk(repo, box.id, displayId, {
        topic: body.topic,
        kind: body.kind,
        action: body.action ?? null,
        code: body.code ?? null,
        value: body.value ?? null,
        payload,
      }).catch((err) => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }

    const markForwarded = () => { repo.markEventForwarded(eventId); };
    nodered.forward(body.topic, out, tenantInfo, markForwarded);
    nodered.forward("io.event", out, tenantInfo);
    mqtt.publishEvent(box.id, body.topic, out);
    return { ok: true, event_id: eventId, proxy: proxyResult };
  });

  app.get("/api/iobox/firmware/check", async (event) => {
    const verified = await requireIoBox(event, repo, auth);
    const box = await repo.getIoBoxById(verified.id);
    if (!box) throw createError({ statusCode: 404, statusMessage: "ioBOX not found" });
    const url = new URL(event.req.url);
    const current = url.searchParams.get("current") ?? box.firmware_version ?? "";
    const arch = url.searchParams.get("arch") ?? "esp32s3";
    let release = null;
    if (box.firmware_target_version) {
      release = await repo.getIoBoxFirmwareReleaseByVersionArchModel(box.firmware_target_version, arch, box.model_id);
      release ??= await repo.getIoBoxFirmwareReleaseByVersionArchModel(box.firmware_target_version, arch, null);
      if (release?.yanked_at) release = null;
    }
    release ??= await repo.getLatestIoBoxFirmwareRelease(box.firmware_channel ?? "stable", arch, box.model_id);
    if (!release || release.version === current) return { up_to_date: true };
    return {
      up_to_date: false,
      version: release.version,
      channel: release.channel,
      firmware_arch: release.firmware_arch,
      model_id: release.model_id,
      size_bytes: release.size_bytes,
      sha256: release.sha256,
      signature: release.signature,
      release_notes: release.release_notes,
      download_url: `/api/iobox/firmware/download/${release.id}`,
      public_key_pem: firmware.publicKeyPem(),
    };
  });

  app.get("/api/iobox/firmware/download/:id", async (event) => {
    await requireIoBox(event, repo, auth);
    const id = getRouterParam(event, "id") ?? new URL(event.req.url).pathname.split("/").pop();
    if (!id) throw createError({ statusCode: 400, statusMessage: "missing release id" });
    const release = await repo.getIoBoxFirmwareRelease(id);
    if (!release || release.yanked_at) throw createError({ statusCode: 404, statusMessage: "firmware release not found" });
    const buf = await firmware.readBlob(release.artifact_path, release.sha256);
    return new Response(buf, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(buf.length),
        "x-firmware-version": release.version,
        "x-firmware-sha256": release.sha256,
      },
    });
  });

  app.post("/api/iobox/firmware/applied", async (event) => {
    const verified = await requireIoBox(event, repo, auth);
    const body = validateBody(FirmwareAppliedBody, await readBody(event));
    await repo.updateIoBox(verified.id, {
      ...(body.error ? {} : { firmware_version: body.version }),
      firmware_last_attempt_at: new Date().toISOString(),
      firmware_last_attempt_version: body.version,
      firmware_last_error: body.error ?? null,
    } as any);
    return { ok: true };
  });
}

function mappingMatches(mapping: { source_kind: string; match_json: Record<string, unknown> }, event: Record<string, unknown>): boolean {
  if (mapping.source_kind !== String(event["kind"] ?? "")) return false;
  for (const [key, expected] of Object.entries(mapping.match_json ?? {})) {
    if (JSON.stringify(event[key]) !== JSON.stringify(expected)) return false;
  }
  return true;
}

async function proxyIoBoxEventToKiosk(
  repo: Repository,
  ioBoxId: string,
  displayId: string,
  event: Record<string, unknown>,
): Promise<unknown> {
  const display = await repo.getDisplayById(displayId);
  if (!display?.kiosk_id) {
    return { ok: false, error: "assigned display has no kiosk" };
  }
  const mappings = (await repo.listIoBoxMappingsForDisplay(displayId))
    .filter((m) => (m.iobox_id == null || m.iobox_id === ioBoxId) && mappingMatches(m, event));
  if (mappings.length === 0) {
    return { ok: true, matched: false };
  }

  const results = [];
  for (const mapping of mappings) {
    const response = await getCoordinator().requestKiosk(display.kiosk_id, {
      type: "iobox-control",
      iobox_id: ioBoxId,
      display_id: displayId,
      action: mapping.action,
      target_kind: mapping.target_kind,
      params: mapping.params_json,
      event,
    }, 8000);
    results.push(response);
  }
  return { ok: true, matched: true, results };
}

// ---- Kiosk routes (require Bearer kiosk key) --------------------------------

// Event deduplication cache: key → last-seen timestamp (ms).
const eventDedupCache = new Map<string, number>();

function registerKioskRoutes(
  app: H3,
  repo: Repository,
  auth: AuthApi,
  secrets: SecretsApi,
  nodered: NoderedBridge,
  firmware: FirmwareApi,
  osUpdates: OsUpdateApi,
  mqtt: MqttBridge,
  clientFirmwarePublicKey: string,
): void {
  const onvifCallbackGuard = createRateLimiter({ windowMs: 60_000, max: 300 });
  // Bundle delivery
  app.get("/api/kiosk/bundle", async (event) => {
    const kiosk = await requireKiosk(event, repo, auth);

    event.context.obs?.log.info("bundle fetch for kiosk {id}", { id: String(kiosk.id) });
    const clusterKey = await getClusterKey(repo, secrets);
    const bundle = await generateBundle(repo, secrets, kiosk.id, clusterKey, event.context.obs)
      .catch((error: unknown) => {
        if (!(error instanceof BundleGenerationError)) throw error;
        return new Response(JSON.stringify({
          error: "bundle_generation_failed",
          phase: error.phase,
          code: error.code,
          trace_id: event.context.obs?.traceId ?? null,
        }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      });
    if (bundle instanceof Response) return bundle;
    if (!bundle) throw createError({ statusCode: 404, statusMessage: "Kiosk not found" });
    bundle.tenant_slug = kiosk.tenant_slug;

    // Stable bundle ETag: the payload contains randomized encrypted fields,
    // so hashing raw JSON would change on every request with no config change.
    const json = JSON.stringify(bundle);
    const etag = `"${bundle.version}"`;
    const ifNoneMatch = getRequestHeader(event, "if-none-match");
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304 });
    }

    return new Response(json, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "etag": etag,
        "x-bf-bundle-version": bundle.version,
      },
    });
  });

  // Heartbeat
  app.post("/api/kiosk/heartbeat", async (event) => {
    const kiosk = await requireKiosk(event, repo, auth);
    event.context.obs?.log.info("heartbeat from kiosk {id}", { id: String(kiosk.id) });

    const rawBody = await readBody(event);
    const body = (() => {
      try {
        return validateBody(HeartbeatBody, rawBody);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        event.context.obs?.error(error, {
          "heartbeat.phase": "validation",
          "kiosk.id": String(kiosk.id),
        });
        throw cause;
      }
    })();

    // Capture the kiosk's LAN-side IP from the heartbeat connection so admin
    // can render a copy-paste URL even when the kiosk has no DNS name.
    const remoteIp = getRequestHeader(event, "x-real-ip")
      ?? getRequestHeader(event, "x-forwarded-for")?.split(",")[0]?.trim()
      ?? null;

    await repo.touchKiosk(kiosk.id, {
      bundle_version: body.bundle_version ?? null,
      kiosk_app_version: body.kiosk_app_version ?? null,
      firmware_target: normalizeFirmwareTarget(body.firmware_target) || null,
      os_version: body.os_version ?? null,
      os_update_compatibility: body.os_update_compatibility?.trim() || null,
      cpu_temp_c: body.cpu_temp_c ?? null,
      cpu_load_percent: body.cpu_load_percent ?? null,
      gpu_load_percent: body.gpu_load_percent ?? null,
      fan_rpm: body.fan_rpm ?? null,
      fan_pwm: body.fan_pwm ?? null,
      memory_total_mb: body.memory_total_mb ?? null,
      memory_used_mb: body.memory_used_mb ?? null,
      disk_total_mb: body.disk_total_mb ?? null,
      disk_free_mb: body.disk_free_mb ?? null,
      disk_used_percent: body.disk_used_percent ?? null,
      local_key: body.local_key ?? null,
      local_port: body.local_port ?? null,
      local_last_ip: remoteIp,
      reported_hostname: body.reported_hostname ?? null,
      network_interfaces_json: Array.isArray(body.network_interfaces)
        ? JSON.stringify(body.network_interfaces)
        : null,
      logging_json: body.logging && typeof body.logging === "object"
        ? JSON.stringify(body.logging)
        : null,
      partitions_json: Array.isArray(body.partitions)
        ? JSON.stringify(body.partitions)
        : null,
      renderer_telemetry_json: JSON.stringify({
        gpu_load_percent: body.gpu_load_percent ?? null,
        pipelines: body.pipeline_stats,
      }),
    });

    // Managed-config echo: kiosk reports the version it has successfully
    // applied. Persist for the admin UI to render. Error string clears on a
    // successful apply (kiosk omits it). verifyKioskKey returns just {id};
    // re-read the full row to check the managed_image flag.
    const kioskFull = await repo.getKioskById(kiosk.id);
    const acceptsManagedConfig = Boolean(kioskFull?.managed_image)
      || (Array.isArray(kioskFull?.capabilities) && kioskFull.capabilities.includes("windows"));
    if (acceptsManagedConfig && typeof body.managed_config_applied_version === "number") {
      const patch: Record<string, unknown> = {
        managed_config_applied_version: body.managed_config_applied_version,
        managed_config_applied_at: new Date().toISOString(),
      };
      if (body.managed_config_error !== undefined) {
        patch["managed_config_error"] = body.managed_config_error ?? null;
      }
      await repo.updateKiosk(kiosk.id, patch as any);
    } else if (acceptsManagedConfig && body.managed_config_error !== undefined) {
      await repo.updateKiosk(kiosk.id, {
        managed_config_error: body.managed_config_error ?? null,
      } as any);
    }

    // Mirror to MQTT bridge (no-op when BF_MQTT_URL unset).
    mqtt.publishTelemetry(kiosk.id, {
      kiosk_app_version: body.kiosk_app_version,
      firmware_target: body.firmware_target,
      bundle_version: body.bundle_version,
      cpu_temp_c: body.cpu_temp_c,
      cpu_load_percent: body.cpu_load_percent,
      gpu_load_percent: body.gpu_load_percent,
      pipeline_stats: body.pipeline_stats,
      fan_rpm: body.fan_rpm,
      fan_pwm: body.fan_pwm,
      memory_total_mb: body.memory_total_mb,
      memory_used_mb: body.memory_used_mb,
      disk_total_mb: body.disk_total_mb,
      disk_free_mb: body.disk_free_mb,
      disk_used_percent: body.disk_used_percent,
      ip: remoteIp,
      reported_hostname: body.reported_hostname,
      network_interfaces: body.network_interfaces,
    });

    // Sync ONVIF subscription statuses reported by the kiosk.
    // This is the mechanism that keeps camera_event_subscriptions fresh
    // across kiosk reboots — the kiosk reports its current subscription
    // state and the server upserts it.
    if (body.onvif_subscriptions && typeof body.onvif_subscriptions === "object") {
      try {
        await repo.syncKioskSubscriptions(kiosk.id, body.onvif_subscriptions as any);
      } catch (err: any) {
        event.context.obs?.log.warn("subscription sync failed: {msg}", { msg: err.message ?? "unknown" });
      }
    }

    // Sync displays reported by the kiosk
    if (Array.isArray(body.displays)) {
      const displaySpan = event.context.obs?.startSpan("heartbeat-display-sync", {
        "kiosk.id": String(kiosk.id),
        "display.reported_count": body.displays.length,
      });
      let currentDisplay = "";
      let currentIndex = -1;
      let createdCount = 0;
      let updatedCount = 0;
      let removedCount = 0;
      try {
      const existing = await repo.listDisplaysForKiosk(kiosk.id);
      const seenDisplayIds = new Set<string>();
      for (const [position, reported] of body.displays.entries()) {
        const reportedIndex = Number.isInteger(reported.index) && reported.index! >= 0
          ? reported.index!
          : position;
        currentDisplay = reported.name;
        currentIndex = reportedIndex;
        const displayName = kioskDisplayName(kioskFull?.name ?? String(kiosk.id), reported.name);
        const match = findReportedDisplayMatch(existing, seenDisplayIds, reported.name, reportedIndex);
        if (match) {
          seenDisplayIds.add(match.id);
          const powerState = reported.power_state === "awake" || reported.power_state === "standby"
            ? reported.power_state
            : reported.power_state === "unknown"
              ? "unknown"
              : null;
          if (
            match.name !== displayName
            || match.index !== reportedIndex
            || match.width_px !== reported.width_px
            || match.height_px !== reported.height_px
            || !match.is_enabled
            || (powerState != null && match.actual_power_state !== powerState)
          ) {
            await repo.updateDisplay(match.id, {
              name: displayName,
              index: reportedIndex,
              width_px: reported.width_px,
              height_px: reported.height_px,
              is_enabled: true,
              ...(powerState != null ? {
                actual_power_state: powerState,
                actual_power_state_at: new Date().toISOString(),
              } : {}),
            } as any);
            updatedCount += 1;
            displaySpan?.log.info("updated display {id} {name} at index {index}", {
              id: match.id,
              name: reported.name,
              index: reportedIndex,
            });
          }
        } else {
          // New display — create it
          const created = await repo.createDisplayForKiosk(kiosk.id, {
            name: displayName,
            index: reportedIndex,
            width_px: reported.width_px,
            height_px: reported.height_px,
          });
          const powerState = reported.power_state === "awake" || reported.power_state === "standby"
            ? reported.power_state
            : reported.power_state === "unknown"
              ? "unknown"
              : null;
          if (powerState != null) {
            await repo.updateDisplay(created.id, {
              actual_power_state: powerState,
              actual_power_state_at: new Date().toISOString(),
            } as any);
          }
          seenDisplayIds.add(created.id);
          createdCount += 1;
          displaySpan?.log.info("created display {id} {name} at index {index}", {
            id: created.id,
            name: reported.name,
            index: reportedIndex,
          });
        }
      }
      for (const display of existing) {
        if (seenDisplayIds.has(display.id)) continue;
        if (await repo.deleteDisplayIfUnused(display.id)) {
          removedCount += 1;
          displaySpan?.log.info("removed stale display {id} {name}", {
            id: display.id,
            name: display.name,
          });
        }
      }
      displaySpan?.end({
        status: "ok",
        "display.existing_count": existing.length,
        "display.created_count": createdCount,
        "display.updated_count": updatedCount,
        "display.removed_count": removedCount,
      });
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        displaySpan?.error(error, {
          "display.name": currentDisplay,
          "display.index": currentIndex,
        });
        displaySpan?.end({ status: "error" });
        throw cause;
      }
    }

    // Re-read kiosk so we see the freshly-persisted applied_version above when
    // computing whether the server still has a newer config to deliver.
    const fresh = await repo.getKioskById(kiosk.id);
    const updateSchedule = normalizeUpdateSchedule(await repo.getSetupExtra("update_schedule"));
    let pendingConfig: { version: number; config: unknown } | undefined;
    const isWindowsClient = Array.isArray(fresh?.capabilities) && fresh.capabilities.includes("windows");
    if (
      (fresh?.managed_image || isWindowsClient)
      && fresh.managed_config_version > fresh.managed_config_applied_version
      && fresh.managed_config_json
    ) {
      try {
        pendingConfig = {
          version: fresh.managed_config_version,
          config: JSON.parse(fresh.managed_config_json),
        };
      } catch {
        // Corrupt JSON — leave pendingConfig undefined; admin UI will show
        // the error. Don't break heartbeat.
      }
    }

    return {
      ok: true,
      now: new Date().toISOString(),
      firmware_channel: fresh?.firmware_channel ?? "stable",
      firmware_target_version: fresh?.firmware_target_version ?? null,
      os_update_channel: fresh?.os_update_channel ?? "stable",
      os_update_target_version: fresh?.os_update_target_version ?? null,
      auto_updates_allowed: updateScheduleAllowsNow(updateSchedule),
      audio_default_volume_percent: fresh?.audio_default_volume_percent ?? 50,
      ...(pendingConfig ? { pending_config: pendingConfig } : {}),
    };
  });

  // Event forwarding
  app.post("/api/kiosk/event", async (event) => {
    const kiosk = await requireKiosk(event, repo, auth);

    const raw = await readBody(event);
    let body: ReturnType<typeof EventBody["parse"]>;
    try {
      body = validateBody(EventBody, raw);
    } catch (err: any) {
      event.context.obs?.log.warn("event validation failed: {msg} body={raw}", {
        msg: err.message ?? "unknown",
        raw: JSON.stringify(raw).slice(0, 500),
      });
      throw err;
    }
    const payload = (body.payload ?? {}) as Record<string, unknown>;
    event.context.obs?.log.info("event from kiosk {id} topic {topic}", { id: String(kiosk.id), topic: body.topic });

    const dedupKey = `${kiosk.id}:${body.camera_id ?? 0}:${body.topic}:${JSON.stringify(payload["source"] ?? "")}`;
    const now = Date.now();
    if (eventDedupCache.has(dedupKey)) {
      const lastSeen = eventDedupCache.get(dedupKey)!;
      if (now - lastSeen < 2000) {
        return { ok: true, event_id: null, deduplicated: true };
      }
    }
    eventDedupCache.set(dedupKey, now);
    // Trim cache periodically (prevent unbounded growth).
    if (eventDedupCache.size > 10_000) {
      const cutoff = now - 5000;
      for (const [k, v] of eventDedupCache) {
        if (v < cutoff) eventDedupCache.delete(k);
      }
    }

    let eventId: string;
    try {
      eventId = await repo.insertEvent({
        source_kiosk_id: kiosk.id,
        source_camera_id: body.camera_id ?? null,
        ingress_path: "/api/kiosk/event",
        source_type: (body.source_type as any) ?? "system",
        topic: body.topic,
        property_op: body.property_op ?? null,
        payload,
        forwarded_to_nodered: false,
      });
    } catch (err: any) {
      if (err?.code === "23503") {
        eventId = await repo.insertEvent({
          source_kiosk_id: kiosk.id,
          source_camera_id: null,
          ingress_path: "/api/kiosk/event",
          source_type: (body.source_type as any) ?? "system",
          topic: body.topic,
          property_op: body.property_op ?? null,
          payload,
          forwarded_to_nodered: false,
        });
      } else {
        throw err;
      }
    }

    // Side-effect: persist active layout per display so the admin UI can
    // surface "currently showing X" without having to query event_log.
    if (body.topic === "layout.changed") {
      const displayId = String(payload["display_id"] ?? "");
      const layoutId = String(payload["layout_id"] ?? "");
      if (displayId && layoutId) {
        try {
          await repo.updateDisplay(displayId, { active_layout_id: layoutId } as any);
        } catch {
          // Display might not exist; layout.changed is best-effort telemetry.
        }
      }
    }

    // Mark event subscription as active (turns orange → green in admin UI)
    if (body.camera_id != null && body.topic) {
      repo.markEventReceived(body.camera_id, body.topic).catch(() => {});
    }

    // Best-effort forward to Node-RED. Topics that have a dedicated trigger
    // node (bf-trigger-layout-changed etc.) expect a FLAT payload matching
    // what the admin-side emit produces — splat body.payload up to the top
    // level and add kiosk_id. Generic camera events keep the wrapped shape
    // the bf-kiosk-camera-event trigger consumes.
    const flatTopics = new Set([
      "layout.changed",
      "kiosk.changed",
      "kiosk.status",
      "display.power.changed",
      "camera.changed",
      "web-change",
    ]);
    const markForwarded = () => { repo.markEventForwarded(eventId); };
    const tenantInfo = { tenant_slug: kiosk.tenant_slug, tenant_name: kiosk.tenant_name, tenant_id: kiosk.tenant_id };
    if (flatTopics.has(body.topic)) {
      const out = { kiosk_id: kiosk.id, ...(body.payload ?? {}), source: "kiosk" };
      nodered.forward(body.topic, out, tenantInfo, markForwarded);
      mqtt.publishEvent(kiosk.id, body.topic, out);
    } else {
      const out = {
        event_id: eventId,
        kiosk_id: kiosk.id,
        camera_id: body.camera_id ?? null,
        source_type: body.source_type ?? "system",
        property_op: body.property_op ?? null,
        topic: body.topic,
        payload: body.payload ?? {},
        timestamp: new Date().toISOString(),
        source: "kiosk",
      };
      nodered.forward(body.topic, out, tenantInfo, markForwarded);
      mqtt.publishEvent(kiosk.id, body.topic, out);

      nodered.forward("camera.event", out, tenantInfo);
      if (body.source_type === "onvif") {
        nodered.forward("onvif.event", out, tenantInfo);
        nodered.forward("onvif.motion", out, tenantInfo);
        nodered.forward("onvif.anpr", out, tenantInfo);
      } else if (body.source_type === "io") {
        nodered.forward("io.event", out, tenantInfo);
      }
    }

    return { ok: true, event_id: eventId };
  });

  // ---- ONVIF push callback (camera → server directly) ----------------------
  // Cameras that can't reach a kiosk push SOAP Notify envelopes here.
  // No auth — cameras can't send Bearer tokens. Path contains camera UUID.
  app.post("/oce/:tenantSlug/:cameraId/:callbackToken", async (event) => {
    const tenantSlug = getRouterParam(event, "tenantSlug") ?? "default";
    const cameraId = getRouterParam(event, "cameraId") ?? "";
    const callbackToken = getRouterParam(event, "callbackToken") ?? "";
    const ip = remoteIp(event) ?? "unknown";
    if (!onvifCallbackGuard.take(`oce:${ip}`)) {
      throw createError({ statusCode: 429, statusMessage: "rate limited" });
    }
    const tenant = await repo.getTenantBySlug(tenantSlug);
    if (!tenant?.is_active) throw createError({ statusCode: 404, statusMessage: "not found" });
    await repo.adapter.setSearchPath(tenant.schema_name);
    const cam = await repo.getCameraById(cameraId);
    if (!cam || !onvifCallbackTokenMatches(callbackToken, cam.event_callback_token_hash)) {
      throw createError({ statusCode: 404, statusMessage: "not found" });
    }
    const rawBody = await readBody<string>(event);
    const xml = typeof rawBody === "string" ? rawBody : String(rawBody ?? "");
    if (!xml || !cameraId) {
      return { ok: true, count: 0 };
    }

    // Find which kiosk manages this camera's events (for attribution).
    const subs = await repo.listEventSubscriptions(cameraId);
    const activeSub = subs.find((s: any) => s.status === "active");
    const kioskId = activeSub?.subscribed_by_kiosk_id ?? null;

    // Parse ONVIF Notify SOAP envelope — extract NotificationMessage blocks.
    const events = parseOnvifNotify(xml);
    if (events.length === 0) {
      return { ok: true, count: 0 };
    }

    event.context.obs?.log.info("onvif-callback: {n} events for camera {cam}", { n: events.length, cam: cameraId });

    for (const evt of events) {
      try {
        const eventId = await repo.insertEvent({
          source_kiosk_id: kioskId,
          source_camera_id: cameraId,
          ingress_path: "/oce/:tenantSlug/:cameraId/:callbackToken",
          source_type: "onvif",
          topic: evt.topic,
          property_op: evt.propertyOp ?? null,
          payload: evt.payload,
          forwarded_to_nodered: false,
        });

        if (evt.topic) {
          repo.markEventReceived(cameraId, evt.topic).catch(() => {});
        }

        const out = {
          event_id: eventId,
          kiosk_id: kioskId,
          camera_id: cameraId,
          source_type: "onvif",
          property_op: evt.propertyOp ?? null,
          topic: evt.topic,
          payload: evt.payload,
          timestamp: new Date().toISOString(),
          source: "camera-push",
        };
        const tenantInfo = { tenant_slug: tenantSlug, tenant_name: null as string | null };
        nodered.forward(evt.topic, out, tenantInfo);
        mqtt.publishEvent(kioskId ?? "server", evt.topic, out);
        nodered.forward("camera.event", out, tenantInfo);
        nodered.forward("onvif.event", out, tenantInfo);
        nodered.forward("onvif.motion", out, tenantInfo);
        nodered.forward("onvif.anpr", out, tenantInfo);
      } catch (err: any) {
        event.context.obs?.log.warn("onvif-callback: event insert failed: {msg}", { msg: err.message ?? "unknown" });
      }
    }

    return { ok: true, count: events.length };
  });

  // ---- Kiosk log ingestion (batch) -----------------------------------------
  app.post("/api/kiosk/logs", async (event) => {
    const kiosk = await requireKiosk(event, repo, auth);

    const body = validateBody(KioskLogsBody, await readBody(event));
    if (body.entries.length === 0) {
      throw createError({ statusCode: 400, statusMessage: "entries array required" });
    }

    const validLevels = new Set(["debug", "info", "warn", "error"]);
    const entries = body.entries
      .filter((e: any) => e.message.length > 0)
      .map((e: any) => ({
        level: (validLevels.has(e.level) ? e.level : "info") as "debug" | "info" | "warn" | "error",
        message: String(e.message),
        context: (e.context ?? {}) as Record<string, unknown>,
        logged_at: e.logged_at as string | undefined,
      }));

    const count = await repo.insertKioskLogs(kiosk.id, entries);
    return { ok: true, count };
  });

  // ---- Firmware: kiosk checks for + downloads its assigned release -------

  /**
   * Kiosk polls this on heartbeat (or after a `firmware_check` WS push).
   * Decision tree:
   *   1. If kiosk.firmware_target_version is set → look up that version on the
   *      kiosk's arch; offer if it exists and isn't yanked.
   *   2. Otherwise pick latest non-yanked release on the kiosk's channel + arch.
   *   3. If chosen.version === current_version (reported via heartbeat) →
   *      "up_to_date".
   *
   * `target` is supplied by the kiosk because the server has no other way to
   * know which build target the kiosk was built against.
   */
  app.get("/api/kiosk/firmware/check", async (event) => {
    const verified = await requireKiosk(event, repo, auth);
    event.context.obs?.log.info("firmware check for kiosk {id}", { id: String(verified.id) });
    const kiosk = await repo.getKioskById(verified.id);
    if (!kiosk) throw createError({ statusCode: 404, statusMessage: "kiosk not found" });

    const url = new URL(event.req.url);
    const target = normalizeFirmwareTarget(
      url.searchParams.get("target")?.trim() || url.searchParams.get("arch")?.trim(),
    );
    if (!target) {
      throw createError({ statusCode: 400, statusMessage: "target query param required" });
    }
    if (kiosk.firmware_target !== target) {
      await repo.updateKiosk(kiosk.id, { firmware_target: target } as any);
    }
    const currentVersion = url.searchParams.get("current")?.trim() ?? kiosk.kiosk_app_version ?? "";

    let release = null;
    // Explicit per-kiosk pin wins over all rollout / channel selection.
    if (kiosk.firmware_target_version) {
      release = await withDefaultTenant(repo, verified.schema_name, () =>
        repo.getFirmwareReleaseByVersionArch(kiosk.firmware_target_version!, target)
      );
      if (release?.yanked_at) release = null;
    }
    // Active rollouts: most-recent matching, with bucket eligibility.
    if (!release) {
      const rollouts = await withDefaultTenant(repo, verified.schema_name, () => repo.listActiveRolloutsForKiosk(kiosk.id));
      for (const rollout of rollouts) {
        if (!isKioskInRolloutBucket(kiosk.id, rollout.id, rollout.percentage)) continue;
        const r = await withDefaultTenant(repo, verified.schema_name, () => repo.getFirmwareRelease(rollout.release_id));
        if (!r || r.yanked_at) continue;
        if (normalizeFirmwareTarget(r.arch) !== target) continue;
        release = r;
        break;
      }
    }
    // Channel-latest fallback.
    if (!release) {
      const channel = (kiosk.firmware_channel ?? "stable") as FirmwareChannel;
      release = await withDefaultTenant(repo, verified.schema_name, () => repo.getLatestFirmwareRelease(channel, target));
    }

    if (!release || release.version === currentVersion) {
      return { up_to_date: true };
    }

    return {
      up_to_date: false,
      update: {
        release_id: release.id,
        version: release.version,
        channel: release.channel,
        sha256: release.sha256,
        signature: release.signature,
        size_bytes: release.size_bytes,
        download_url: `/api/kiosk/firmware/download/${release.id}`,
        // Older clients require this field; current clients ignore it and use their embedded key.
        public_key_pem: clientFirmwarePublicKey,
      },
    };
  });

  /**
   * Stream the signed binary. Bearer kiosk-key auth — internal access only,
   * Angie will not pass this externally because /api/kiosk/* is in the
   * kiosk-key location block.
   */
  app.get("/api/kiosk/firmware/download/:id", async (event) => {
    const kiosk = await requireKiosk(event, repo, auth);

    const id = (event.context as any).params?.id as string | undefined
      ?? new URL(event.req.url).pathname.split("/").pop();
    if (!id) throw createError({ statusCode: 400, statusMessage: "release id required" });

    const release = await withDefaultTenant(repo, kiosk.schema_name, () => repo.getFirmwareRelease(id));
    if (!release || release.yanked_at) {
      throw createError({ statusCode: 404, statusMessage: "release not found" });
    }

    const buf = await firmware.readBlob(release.artifact_path, release.sha256);
    return new Response(buf, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(buf.length),
        "x-bf-sha256": release.sha256,
        "x-bf-signature": release.signature,
        "x-bf-version": release.version,
      },
    });
  });

  /**
   * Kiosk reports the outcome of an update attempt. On success it should
   * also be sending its new kiosk_app_version on heartbeat. On failure
   * the error string is surfaced on the admin kiosk page.
   */
  app.post("/api/kiosk/firmware/applied", async (event) => {
    const kiosk = await requireKiosk(event, repo, auth);

    const body = validateBody(FirmwareAppliedBody, await readBody(event));
    await repo.recordKioskFirmwareAttempt(kiosk.id, body.version, body.error ?? null);
    await repo.insertEvent({
      source_kiosk_id: kiosk.id,
      source_camera_id: null,
      source_type: "system",
      topic: "kiosk.log",
      property_op: null,
      payload: {
        level: body.error ? "error" : "info",
        message: body.error ? "firmware update failed" : "firmware update applied",
        context: { version: body.version, error: body.error ?? null },
      },
      forwarded_to_nodered: false,
    });
    return { ok: true };
  });

  /**
   * Full OS OTA check. `compatibility` is the RAUC compatible string baked
   * into the image, e.g. betterframe-rpi5-aarch64. The kiosk-side installer
   * will hand the downloaded bundle to `rauc install`.
   */
  app.get("/api/kiosk/os/check", async (event) => {
    const verified = await requireKiosk(event, repo, auth);
    event.context.obs?.log.info("os update check for kiosk {id}", { id: String(verified.id) });
    const kiosk = await repo.getKioskById(verified.id);
    if (!kiosk) throw createError({ statusCode: 404, statusMessage: "kiosk not found" });

    const url = new URL(event.req.url);
    const compatibility = url.searchParams.get("compatibility")?.trim();
    if (!compatibility) {
      throw createError({ statusCode: 400, statusMessage: "compatibility query param required" });
    }
    if (kiosk.os_update_compatibility !== compatibility) {
      await repo.updateKiosk(kiosk.id, { os_update_compatibility: compatibility } as any);
    }
    const currentVersion = url.searchParams.get("current")?.trim() ?? kiosk.os_version ?? "";

    let release = null;
    if (kiosk.os_update_target_version) {
      release = await withDefaultTenant(repo, verified.schema_name, () =>
        repo.getOsUpdateReleaseByVersionCompatibility(kiosk.os_update_target_version!, compatibility)
      );
      if (release?.yanked_at) release = null;
    }
    if (!release) {
      const rollouts = await withDefaultTenant(repo, verified.schema_name, () => repo.listActiveOsUpdateRolloutsForKiosk(kiosk.id));
      for (const rollout of rollouts) {
        if (!isKioskInRolloutBucket(kiosk.id, rollout.id, rollout.percentage)) continue;
        const r = await withDefaultTenant(repo, verified.schema_name, () => repo.getOsUpdateRelease(rollout.release_id));
        if (!r || r.yanked_at) continue;
        if (r.compatibility !== compatibility) continue;
        release = r;
        break;
      }
    }
    if (!release) {
      const channel = (kiosk.os_update_channel ?? "stable") as FirmwareChannel;
      release = await withDefaultTenant(repo, verified.schema_name, () => repo.getLatestOsUpdateRelease(channel, compatibility));
    }

    if (!release || release.version === currentVersion) {
      return { up_to_date: true };
    }

    return {
      up_to_date: false,
      update: {
        release_id: release.id,
        version: release.version,
        channel: release.channel,
        compatibility: release.compatibility,
        sha256: release.sha256,
        size_bytes: release.size_bytes,
        bundle_format: release.bundle_format,
        download_url: `/api/kiosk/os/download/${release.id}`,
      },
    };
  });

  app.get("/api/kiosk/os/download/:id", async (event) => {
    const kiosk = await requireKiosk(event, repo, auth);

    const id = (event.context as any).params?.id as string | undefined
      ?? new URL(event.req.url).pathname.split("/").pop();
    if (!id) throw createError({ statusCode: 400, statusMessage: "release id required" });

    const release = await withDefaultTenant(repo, kiosk.schema_name, () => repo.getOsUpdateRelease(id));
    if (!release || release.yanked_at) {
      throw createError({ statusCode: 404, statusMessage: "release not found" });
    }
    return serveOsUpdateBundle(event, release, osUpdates);
  });

  app.post("/api/kiosk/os/applied", async (event) => {
    const kiosk = await requireKiosk(event, repo, auth);

    const body = validateBody(OsAppliedBody, await readBody(event));
    await repo.recordKioskOsUpdateAttempt(kiosk.id, body.version, body.error ?? null, body.error ? "failed" : "pending_reboot");
    await repo.insertEvent({
      source_kiosk_id: kiosk.id,
      source_camera_id: null,
      source_type: "system",
      topic: "kiosk.log",
      property_op: null,
      payload: {
        level: body.error ? "error" : "info",
        message: body.error ? "os update failed" : "os update applied",
        context: { version: body.version, error: body.error ?? null },
      },
      forwarded_to_nodered: false,
    });
    return { ok: true };
  });

  app.post("/api/kiosk/os/status", async (event) => {
    const kiosk = await requireKiosk(event, repo, auth);
    const body = validateBody(OsStatusBody, await readBody(event));
    await repo.recordKioskOsUpdateAttempt(kiosk.id, body.version, body.error ?? null, body.state);
    await repo.insertEvent({
      source_kiosk_id: kiosk.id,
      source_camera_id: null,
      source_type: "system",
      topic: "kiosk.os-update",
      property_op: body.state,
      payload: { version: body.version, state: body.state, error: body.error ?? null },
      forwarded_to_nodered: false,
    });
    return { ok: true };
  });

  app.get("/api/kiosk/cameras/:id/stream", async (event) => {
    await requireKiosk(event, repo, auth);

    const cameraId = (getRouterParam(event, "id") ?? "");
    const camera = await repo.getCameraById(cameraId);
    if (!camera || camera.type !== "cloud" || !camera.cloud_account_id || !camera.cloud_vendor_camera_id) {
      throw createError({ statusCode: 404, statusMessage: "Cloud camera not found" });
    }

    const account = await repo.getCloudAccount(camera.cloud_account_id);
    if (!account) throw createError({ statusCode: 404, statusMessage: "Cloud account not found" });

    const { getProvider: gp } = await import("../../shared/cloud-cameras/index.js");
    const provider = gp(account.vendor as any);
    if (!provider) throw createError({ statusCode: 500, statusMessage: "Unknown vendor" });

    let creds: Record<string, string>;
    try {
      creds = JSON.parse(secrets.decryptString(account.credentials_encrypted, "cloud-creds"));
    } catch {
      throw createError({ statusCode: 500, statusMessage: "Credential decrypt failed" });
    }

    const url = await provider.getStreamUrl(creds, camera.cloud_vendor_camera_id);
    if (!url) throw createError({ statusCode: 503, statusMessage: "Stream URL unavailable" });

    if (url !== camera.cloud_stream_url) {
      await repo.updateCamera(camera.id, { cloud_stream_url: url } as any);
    }

    return { url, stream_type: camera.cloud_stream_type ?? "hls" };
  });
}

/**
 * Deterministic bucket assignment for gradual rollouts. Same (kioskId,
 * rolloutId) always lands in the same bucket, so a 50% rollout consistently
 * targets the same half of the fleet across re-checks. Switch from 50%→100%
 * gracefully adds the previously-excluded half rather than reshuffling.
 */
function isKioskInRolloutBucket(kioskId: string, rolloutId: string, percentage: number): boolean {
  if (percentage >= 100) return true;
  if (percentage <= 0) return false;
  const h = createHash("sha256")
    .update(`${rolloutId}:${kioskId}`)
    .digest();
  const bucket = h.readUInt32BE(0) % 100;
  return bucket < percentage;
}

/**
 * Parse ONVIF SOAP Notify envelope into structured events.
 * Extracts topic, source key/value pairs, and data key/value pairs from
 * each NotificationMessage block.
 */
function parseOnvifNotify(xml: string): Array<{
  topic: string;
  propertyOp: string | null;
  payload: Record<string, unknown>;
}> {
  const results: Array<{ topic: string; propertyOp: string | null; payload: Record<string, unknown> }> = [];

  // Split on NotificationMessage boundaries
  const msgRegex = /<[^:]*:?NotificationMessage[^>]*>([\s\S]*?)<\/[^:]*:?NotificationMessage>/gi;
  let match: RegExpExecArray | null;
  while ((match = msgRegex.exec(xml)) !== null) {
    const block = match[1]!;

    // Extract topic
    const topicMatch = block.match(/<[^:]*:?Topic[^>]*>([\s\S]*?)<\/[^:]*:?Topic>/i);
    let topic = topicMatch?.[1]?.trim() ?? "";
    // ONVIF topics look like "tns1:RuleEngine/CellMotionDetector/Motion" — strip namespace prefix
    topic = topic.replace(/^[a-z0-9]+:/i, "");

    // Extract source items
    const source: Record<string, string> = {};
    const sourceBlock = block.match(/<[^:]*:?Source[^>]*>([\s\S]*?)<\/[^:]*:?Source>/i);
    if (sourceBlock) {
      const itemRegex = /<[^:]*:?SimpleItem[^>]*Name="([^"]*)"[^>]*Value="([^"]*)"/gi;
      let si: RegExpExecArray | null;
      while ((si = itemRegex.exec(sourceBlock[1]!)) !== null) {
        source[si[1]!] = si[2]!;
      }
    }

    // Extract data items
    const data: Record<string, string> = {};
    const dataBlock = block.match(/<[^:]*:?Data[^>]*>([\s\S]*?)<\/[^:]*:?Data>/i);
    if (dataBlock) {
      const itemRegex = /<[^:]*:?SimpleItem[^>]*Name="([^"]*)"[^>]*Value="([^"]*)"/gi;
      let di: RegExpExecArray | null;
      while ((di = itemRegex.exec(dataBlock[1]!)) !== null) {
        data[di[1]!] = di[2]!;
      }
    }

    // Property operation (Changed/Initialized/Deleted)
    const propMatch = block.match(/PropertyOperation="([^"]*)"/i);

    if (topic) {
      results.push({
        topic,
        propertyOp: propMatch?.[1] ?? null,
        payload: { source, data, raw_topic: topicMatch?.[1]?.trim() ?? topic },
      });
    }
  }

  return results;
}
