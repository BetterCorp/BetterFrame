/**
 * service-api-http — h3 listener for kiosk-facing REST API.
 *
 * Port 18081 behind Angie proxy. Handles pairing, bundle delivery,
 * heartbeat, and event forwarding.
 */
import * as av from "@anyvali/js";
import {
  BSBService,
  type BSBServiceConstructor,
  createConfigSchema,
  createEventSchemas,
  type Observable,
} from "@bsb/base";
import { H3, serve, readBody, getRequestHeader, createError } from "h3";
import type { Server } from "srvx";

import { getRepo } from "../../shared/plugin-registry.js";
import { initSecrets } from "../../shared/secrets.js";
import { createAuth } from "../../shared/auth.js";
import { initiatePairing, claimPairing } from "../../shared/pairing.js";
import { generateBundle } from "../../shared/bundle.js";
import { initNoderedBridge, type NoderedBridge } from "../../shared/nodered-bridge.js";
import { initFirmware, type FirmwareApi } from "../../shared/firmware.js";
import { createHash } from "node:crypto";
import type { Repository } from "../service-store/repository.js";
import type { AuthApi } from "../../shared/auth.js";
import type { SecretsApi } from "../../shared/secrets.js";
import type { FirmwareChannel } from "../../shared/types.js";

// ---- Config -----------------------------------------------------------------

const ConfigSchema = av.object(
  {
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
  initAfterPlugins?: string[] = ["service-store"];
  runBeforePlugins?: string[];
  runAfterPlugins?: string[];

  private server?: Server;

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super(cfg);
  }

  async init(obs: Observable): Promise<void> {
    const repo = getRepo();
    const secrets = initSecrets(
      { dataDir: this.config.dataDir },
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
    const codeTtl = this.config.codeTtlSeconds;
    const nodered = initNoderedBridge(
      { baseUrl: this.config.noderedUrl },
      { info: (m) => obs.log.info(m as any, {}), warn: (m) => obs.log.warn(m as any, {}) },
    );
    const firmware = initFirmware(
      { dataDir: this.config.dataDir },
      { info: (m) => obs.log.info(m as any, {}), warn: (m) => obs.log.warn(m as any, {}) },
    );

    const app = new H3();

    app.get("/api/kiosk/_check", async (event) => {
      const token = extractBearerToken(event);
      if (!token) return new Response(null, { status: 401 });
      const kiosk = await auth.verifyKioskKey(token);
      if (!kiosk) return new Response(null, { status: 401 });
      return new Response(null, {
        status: 200,
        headers: { "x-betterframe-kiosk-id": String(kiosk.id) },
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

    registerPairingRoutes(app, repo, auth, secrets, codeTtl);
    registerKioskRoutes(app, repo, auth, secrets, nodered, firmware);

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
  }
}

// ---- Helpers ----------------------------------------------------------------

function extractBearerToken(event: any): string | null {
  const hdr = getRequestHeader(event, "authorization");
  if (!hdr?.startsWith("Bearer ")) return null;
  return hdr.slice(7);
}

function getClusterKey(repo: Repository, secrets: SecretsApi): string | undefined {
  const enc = repo.getSetupExtra("cluster_key_encrypted") as string | undefined;
  if (!enc) return undefined;
  return secrets.decryptString(enc, "cluster");
}

// ---- Pairing routes ---------------------------------------------------------

function registerPairingRoutes(
  app: H3,
  repo: Repository,
  auth: AuthApi,
  secrets: SecretsApi,
  codeTtl: number,
): void {
  // Kiosk initiates pairing — no auth required
  app.post("/api/pair/initiate", async (event) => {
    const body = await readBody<{
      proposed_name?: string;
      hardware_model?: string;
      capabilities?: string[];
    }>(event);

    const result = initiatePairing(repo, {
      proposedName: body?.proposed_name ?? null,
      hardwareModel: body?.hardware_model ?? null,
      capabilities: body?.capabilities ?? [],
      codeTtlSeconds: codeTtl,
    });

    return { code: result.code, expires_at: result.expiresAt };
  });

  // Kiosk polls for claim result — no auth required
  app.post("/api/pair/claim", async (event) => {
    const body = await readBody<{ code?: string }>(event);
    const code = (body?.code ?? "").trim().toUpperCase();
    if (!code) throw createError({ statusCode: 400, statusMessage: "code required" });

    const result = claimPairing(repo, code);
    if (result.status === "pending") {
      return new Response(JSON.stringify({ status: "pending" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }

    return {
      status: "claimed",
      kiosk_id: result.kioskId,
      kiosk_name: result.kioskName,
      kiosk_key: result.kioskKey,
      cluster_key: result.clusterKey,
      bundle_url: result.bundleUrl,
    };
  });
}

// ---- Kiosk routes (require Bearer kiosk key) --------------------------------

function registerKioskRoutes(
  app: H3,
  repo: Repository,
  auth: AuthApi,
  secrets: SecretsApi,
  nodered: NoderedBridge,
  firmware: FirmwareApi,
): void {
  // Bundle delivery
  app.get("/api/kiosk/bundle", async (event) => {
    const token = extractBearerToken(event);
    if (!token) throw createError({ statusCode: 401, statusMessage: "Bearer token required" });

    const kiosk = await auth.verifyKioskKey(token);
    if (!kiosk) throw createError({ statusCode: 401, statusMessage: "Invalid kiosk key" });

    const clusterKey = getClusterKey(repo, secrets);
    const bundle = generateBundle(repo, secrets, kiosk.id, clusterKey);
    if (!bundle) throw createError({ statusCode: 404, statusMessage: "Kiosk not found" });

    return bundle;
  });

  // Heartbeat
  app.post("/api/kiosk/heartbeat", async (event) => {
    const token = extractBearerToken(event);
    if (!token) throw createError({ statusCode: 401, statusMessage: "Bearer token required" });

    const kiosk = await auth.verifyKioskKey(token);
    if (!kiosk) throw createError({ statusCode: 401, statusMessage: "Invalid kiosk key" });

    const body = await readBody<{
      bundle_version?: string;
      kiosk_app_version?: string;
      os_version?: string;
      displays?: Array<{ index?: number; name: string; width_px: number; height_px: number }>;
      cpu_temp_c?: number | null;
      fan_rpm?: number | null;
      fan_pwm?: number | null;
      local_key?: string | null;
      local_port?: number | null;
    }>(event);

    // Capture the kiosk's LAN-side IP from the heartbeat connection so admin
    // can render a copy-paste URL even when the kiosk has no DNS name.
    const remoteIp = getRequestHeader(event, "x-real-ip")
      ?? getRequestHeader(event, "x-forwarded-for")?.split(",")[0]?.trim()
      ?? null;

    repo.touchKiosk(kiosk.id, {
      bundle_version: body?.bundle_version ?? null,
      kiosk_app_version: body?.kiosk_app_version ?? null,
      os_version: body?.os_version ?? null,
      cpu_temp_c: body?.cpu_temp_c ?? null,
      fan_rpm: body?.fan_rpm ?? null,
      fan_pwm: body?.fan_pwm ?? null,
      local_key: body?.local_key ?? null,
      local_port: body?.local_port ?? null,
      local_last_ip: remoteIp,
    });

    // Sync displays reported by the kiosk
    if (Array.isArray(body?.displays)) {
      const existing = repo.listDisplaysForKiosk(kiosk.id);
      const seenDisplayIds = new Set<number>();
      for (const [position, reported] of body.displays.entries()) {
        const reportedIndex = Number.isInteger(reported.index) && reported.index! >= 0
          ? reported.index!
          : position;
        const match = existing.find((d) => d.name.endsWith(reported.name))
          ?? existing.find((d) => d.index === reportedIndex);
        if (match) {
          seenDisplayIds.add(match.id);
          if (
            match.name !== reported.name
            || match.index !== reportedIndex
            || match.width_px !== reported.width_px
            || match.height_px !== reported.height_px
          ) {
            repo.updateDisplay(match.id, {
              name: reported.name,
              index: reportedIndex,
              width_px: reported.width_px,
              height_px: reported.height_px,
            } as any);
          }
        } else {
          // New display — create it
          const created = repo.createDisplayForKiosk(kiosk.id, {
            name: reported.name,
            index: reportedIndex,
            width_px: reported.width_px,
            height_px: reported.height_px,
          });
          seenDisplayIds.add(created.id);
        }
      }
      for (const display of existing) {
        if (seenDisplayIds.has(display.id) || !display.is_enabled) continue;
        if (!display.name.endsWith(" HDMI-0")) continue;
        if (repo.listLayoutsForDisplay(display.id).length > 0) continue;
        repo.updateDisplay(display.id, { is_enabled: false } as any);
      }
    }

    return { ok: true, now: new Date().toISOString() };
  });

  // Event forwarding
  app.post("/api/kiosk/event", async (event) => {
    const token = extractBearerToken(event);
    if (!token) throw createError({ statusCode: 401, statusMessage: "Bearer token required" });

    const kiosk = await auth.verifyKioskKey(token);
    if (!kiosk) throw createError({ statusCode: 401, statusMessage: "Invalid kiosk key" });

    const body = await readBody<{
      topic: string;
      source_type?: string;
      camera_id?: number;
      property_op?: string;
      payload?: Record<string, unknown>;
    }>(event);

    if (!body?.topic) throw createError({ statusCode: 400, statusMessage: "topic required" });

    const eventId = repo.insertEvent({
      source_kiosk_id: kiosk.id,
      source_camera_id: body.camera_id ?? null,
      source_type: (body.source_type as any) ?? "system",
      topic: body.topic,
      property_op: body.property_op ?? null,
      payload: body.payload ?? {},
      forwarded_to_nodered: false,
    });

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
    ]);
    if (flatTopics.has(body.topic)) {
      nodered.forward(body.topic, {
        kiosk_id: kiosk.id,
        ...(body.payload ?? {}),
      });
    } else {
      nodered.forward(body.topic, {
        event_id: eventId,
        kiosk_id: kiosk.id,
        camera_id: body.camera_id ?? null,
        source_type: body.source_type ?? "system",
        property_op: body.property_op ?? null,
        payload: body.payload ?? {},
        timestamp: new Date().toISOString(),
      });
    }

    return { ok: true, event_id: eventId };
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
   * `arch` is supplied by the kiosk because the server has no other way to
   * know which build target the kiosk was built against.
   */
  app.get("/api/kiosk/firmware/check", async (event) => {
    const token = extractBearerToken(event);
    if (!token) throw createError({ statusCode: 401, statusMessage: "Bearer token required" });
    const verified = await auth.verifyKioskKey(token);
    if (!verified) throw createError({ statusCode: 401, statusMessage: "Invalid kiosk key" });
    const kiosk = repo.getKioskById(verified.id);
    if (!kiosk) throw createError({ statusCode: 404, statusMessage: "kiosk not found" });

    const url = new URL(event.req.url);
    const arch = url.searchParams.get("arch")?.trim();
    if (!arch) {
      throw createError({ statusCode: 400, statusMessage: "arch query param required" });
    }
    const currentVersion = url.searchParams.get("current")?.trim() ?? kiosk.kiosk_app_version ?? "";

    let release = null;
    // Explicit per-kiosk pin wins over all rollout / channel selection.
    if (kiosk.firmware_target_version) {
      release = repo.getFirmwareReleaseByVersionArch(kiosk.firmware_target_version, arch);
      if (release?.yanked_at) release = null;
    }
    // Active rollouts: most-recent matching, with bucket eligibility.
    if (!release) {
      const rollouts = repo.listActiveRolloutsForKiosk(kiosk.id);
      for (const rollout of rollouts) {
        if (!isKioskInRolloutBucket(kiosk.id, rollout.id, rollout.percentage)) continue;
        const r = repo.getFirmwareRelease(rollout.release_id);
        if (!r || r.yanked_at) continue;
        if (r.arch !== arch) continue;
        release = r;
        break;
      }
    }
    // Channel-latest fallback.
    if (!release) {
      const channel = (kiosk.firmware_channel ?? "stable") as FirmwareChannel;
      release = repo.getLatestFirmwareRelease(channel, arch);
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
        public_key_pem: firmware.publicKeyPem(),
      },
    };
  });

  /**
   * Stream the signed binary. Bearer kiosk-key auth — internal access only,
   * Angie will not pass this externally because /api/kiosk/* is in the
   * kiosk-key location block.
   */
  app.get("/api/kiosk/firmware/download/:id", async (event) => {
    const token = extractBearerToken(event);
    if (!token) throw createError({ statusCode: 401, statusMessage: "Bearer token required" });
    const kiosk = await auth.verifyKioskKey(token);
    if (!kiosk) throw createError({ statusCode: 401, statusMessage: "Invalid kiosk key" });

    const id = (event.context as any).params?.id as string | undefined
      ?? new URL(event.req.url).pathname.split("/").pop();
    if (!id) throw createError({ statusCode: 400, statusMessage: "release id required" });

    const release = repo.getFirmwareRelease(id);
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
    const token = extractBearerToken(event);
    if (!token) throw createError({ statusCode: 401, statusMessage: "Bearer token required" });
    const kiosk = await auth.verifyKioskKey(token);
    if (!kiosk) throw createError({ statusCode: 401, statusMessage: "Invalid kiosk key" });

    const body = await readBody<{ version: string; error?: string }>(event);
    if (!body?.version) {
      throw createError({ statusCode: 400, statusMessage: "version required" });
    }
    repo.recordKioskFirmwareAttempt(kiosk.id, body.version, body.error ?? null);
    return { ok: true };
  });
}

/**
 * Deterministic bucket assignment for gradual rollouts. Same (kioskId,
 * rolloutId) always lands in the same bucket, so a 50% rollout consistently
 * targets the same half of the fleet across re-checks. Switch from 50%→100%
 * gracefully adds the previously-excluded half rather than reshuffling.
 */
function isKioskInRolloutBucket(kioskId: number, rolloutId: string, percentage: number): boolean {
  if (percentage >= 100) return true;
  if (percentage <= 0) return false;
  const h = createHash("sha256")
    .update(`${rolloutId}:${String(kioskId)}`)
    .digest();
  const bucket = h.readUInt32BE(0) % 100;
  return bucket < percentage;
}
