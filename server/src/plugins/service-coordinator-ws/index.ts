import { kioskDebugEnabled } from "../../shared/kiosk-channels.js";
/**
 * service-coordinator-ws — WebSocket hub for live kiosk channel.
 *
 * Kiosks connect with ?token=<kiosk_key>. Server pushes:
 *   - reload-bundle: kiosk should re-fetch bundle
 *   - layout-switch: change active layout (future)
 *   - power: CEC commands (future)
 *   - ping: keepalive
 *
 * Kiosks send:
 *   - pong: keepalive reply
 *   - status: current state
 */
import * as av from "anyvali";
import {
  BSBService,
  type BSBServiceConstructor,
  createConfigSchema,
  createEventSchemas,
  type Observable,
} from "@bsb/base";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, type WebSocketServer } from "ws";

import type { DbConfig } from "../../shared/db/config.js";
import { initDb } from "../../shared/db/init.js";
import { initSecrets } from "../../shared/secrets.js";
import { createAuth } from "../../shared/auth.js";
import { setCoordinator } from "../../shared/coordinator-registry.js";
import { isAndroidViewer, supportsAndroidStandby, androidViewerCommandAllowed, viewerAssignment } from "../../shared/android-viewer.js";
import { readPowerSample, bindPowerSession, unbindPowerSession, ownsPowerSession, powerSampleAllowed, advancePowerSample, withPowerStateLock } from "../../shared/power-state-order.js";
import { dispatchPower, acceptPowerResult } from "../../shared/power-dispatch.js";
import { KioskConnections } from "../../shared/kiosk-connections.js";
import { createCoordinatorWebSocketServer } from "../../shared/coordinator-websocket.js";
import { initNoderedBridge, type NoderedBridge } from "../../shared/nodered-bridge.js";

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
    port: av.int().min(1).max(65535).default(18082),
    noderedUrl: av.string().minLength(1).default("http://127.0.0.1:1880"),
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
  },
  { unknownKeys: "strip" },
);

export const Config = createConfigSchema(
  {
    name: "service-coordinator-ws",
    description: "WebSocket server for real-time kiosk coordination.",
    tags: ["service", "ws", "kiosk", "coordinator"],
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

// ---- Connected kiosks -------------------------------------------------------

const connectedKiosks = new KioskConnections<WebSocket>();
const pendingRequests = new Map<string, {
  kioskId: string;
  socket: WebSocket;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  responseType?: "power-result";
}>();

// Admin debug subscribers: admin WS connections subscribed to a kiosk's
// journal/terminal output. Keyed by kiosk id → set of admin WebSockets.
const debugSubscribers = new Map<string, Set<WebSocket>>();

function addDebugSubscriber(kioskId: string, adminWs: WebSocket): void {
  let subs = debugSubscribers.get(kioskId);
  if (!subs) { subs = new Set(); debugSubscribers.set(kioskId, subs); }
  subs.add(adminWs);
  adminWs.on("close", () => {
    subs!.delete(adminWs);
    if (subs!.size === 0) {
      debugSubscribers.delete(kioskId);
      sendToKiosk(kioskId, { type: "journal-stop" });
      sendToKiosk(kioskId, { type: "terminal-close" });
    }
  });
}

function relayToDebugSubscribers(kioskId: string, message: string): void {
  const subs = debugSubscribers.get(kioskId);
  if (!subs) return;
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
  }
}

function parseCookieValue(header: string, name: string): string | null {
  for (const pair of header.split(";")) {
    const [k, ...rest] = pair.trim().split("=");
    if (k?.trim() === name) return rest.join("=").trim() || null;
  }
  return null;
}

// Per-kiosk message queue: if kiosk is offline, buffer messages here.
// Drain on reconnect. FIFO, cap at 100 messages per kiosk.
const MESSAGE_QUEUE_CAP = 100;
const offlineQueues = new Map<string, string[]>();

function sendToKiosk(kioskId: string, message: object, queueWhenOffline = true): boolean {
  const type = (message as Record<string, unknown>)["type"];
  if (type === "standby" || type === "wake") {
    // Power dispatch requires async validation and transport confirmation.
    // Reject synchronous callers rather than reporting an unconfirmed result.
    return false;
  }
  const k = connectedKiosks.get(kioskId);
  const validateLayout = k?.validateViewerLayout;
  if (validateLayout) {
    const msg = message as Record<string, unknown>;
    const layoutId = typeof msg["layout_id"] === "string" ? msg["layout_id"] : "";
    if (!androidViewerCommandAllowed(message, new Set([layoutId]))) return false;
    if (msg["type"] === "layout-switch") {
      if (!k || k.ws.readyState !== WebSocket.OPEN) return false;
      // The synchronous coordinator reports enqueueing; delivery happens only
      // after current assignment validation, on the same authenticated socket.
      void validateLayout(layoutId).then((allowed) => {
        if (allowed && connectedKiosks.get(kioskId)?.ws === k.ws && k.ws.readyState === WebSocket.OPEN) k.ws.send(JSON.stringify(message));
      }).catch(() => {});
      return true;
    }
  }
  const payload = JSON.stringify(message);
  if (!k || k.ws.readyState !== WebSocket.OPEN) {
    if (!queueWhenOffline) return false;
    // Queue for later delivery.
    let q = offlineQueues.get(kioskId);
    if (!q) { q = []; offlineQueues.set(kioskId, q); }
    q.push(payload);
    if (q.length > MESSAGE_QUEUE_CAP) q.shift(); // FIFO eviction
    return false;
  }
  try {
    k.ws.send(payload);
    return true;
  } catch {
    return false;
  }
}

function drainOfflineQueue(kioskId: string): void {
  const q = offlineQueues.get(kioskId);
  if (!q || q.length === 0) return;
  const k = connectedKiosks.get(kioskId);
  if (!k || k.ws.readyState !== WebSocket.OPEN) return;
  for (const msg of q) {
    try { sendToKiosk(kioskId, JSON.parse(msg), false); } catch { break; }
  }
  offlineQueues.delete(kioskId);
}

function requestKiosk<T = unknown>(kioskId: string, message: object, timeoutMs = 10000): Promise<T> {
  const requestId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const connection = connectedKiosks.get(kioskId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      reject(new Error("kiosk is not connected"));
      return;
    }
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("kiosk request timed out"));
    }, timeoutMs);
    pendingRequests.set(requestId, {
      kioskId,
      socket: connection.ws,
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    });
    const sent = sendToKiosk(kioskId, { ...message, request_id: requestId }, false);
    if (!sent) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      reject(new Error("kiosk is not connected"));
    }
  });
}

function sendPowerToKiosk(kioskId: string, message: object): Promise<boolean> {
  return withPowerStateLock(kioskId, () => dispatchPower(connectedKiosks, kioskId, message, 5_000, (connection, requestId) => {
    const result = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        resolve(false);
      }, 5_000);
      pendingRequests.set(requestId, {
        kioskId, socket: connection.ws, timer, responseType: "power-result",
        resolve: (value) => resolve(value === true), reject: () => resolve(false),
      });
    });
    return { result, cancel: () => {
      const pending = pendingRequests.get(requestId);
      if (pending) clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
    } };
  }));
}

function broadcastAll(message: object): void {
  const type = (message as Record<string, unknown>)["type"];
  for (const k of connectedKiosks.values()) {
    if (type === "standby" || type === "wake") void sendPowerToKiosk(k.id, message);
    else sendToKiosk(k.id, message, false);
  }
}

// ---- Plugin -----------------------------------------------------------------

export class Plugin extends BSBService<InstanceType<typeof Config>, typeof EventSchemas> {
  static override Config = Config;
  static override EventSchemas = EventSchemas;

  initBeforePlugins?: string[];
  initAfterPlugins?: string[];
  runBeforePlugins?: string[];
  runAfterPlugins?: string[];

  private httpServer?: HttpServer;
  private wss?: WebSocketServer;
  private pingInterval?: ReturnType<typeof setInterval>;
  private nodered?: NoderedBridge;
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
    const nodered = initNoderedBridge(
      { baseUrl: noderedUrl },
      { info: (m) => obs.log.info(m as any, {}), warn: (m) => obs.log.warn(m as any, {}) },
    );
    this.nodered = nodered;

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

    const httpServer = createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", connected_kiosks: connectedKiosks.size }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const wss = createCoordinatorWebSocketServer();

    httpServer.on("upgrade", async (req: IncomingMessage, socket, head) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      // Admin debug WS: /ws/admin/debug/:kioskId?token=<admin_api_key>
      // Subscribes to a kiosk's journal + terminal output stream.
      if (url.pathname.startsWith("/ws/admin/debug/")) {
        const kioskIdStr = url.pathname.split("/").pop() ?? "";
        const kioskId = String(kioskIdStr);
        if (kioskId === "") {
          socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
          socket.destroy();
          return;
        }
        // Auth: an explicit debug API key, or an admin session bound to the
        // selected tenant. The kiosk lookup below proves tenant ownership.
        const adminToken = url.searchParams.get("token");
        const cookieHeader = req.headers.cookie ?? "";
        try {
          const targetSlug = (url.searchParams.get("tenant")
            ?? parseCookieValue(cookieHeader, "bf_tenant")
            ?? "default").trim().toLowerCase();
          const targetTenant = await repo.getTenantBySlug(targetSlug);
          if (!targetTenant?.is_active) throw new Error("unknown or inactive tenant");
          let authed = false;
          if (adminToken) {
            await repo.adapter.setSearchPath(targetTenant.schema_name);
            const key = await auth.verifyApiKey(adminToken, null);
            if (key?.scopes.includes("admin") && key.scopes.includes("debug")) authed = true;
          }
          if (!authed && cookieHeader) {
            const cookieVal = parseCookieValue(cookieHeader, cookieName);
            if (cookieVal) {
              const result = await auth.resolveSession(cookieVal);
              const platformAdmin = result?.user.role === "admin" && result.tenant.slug === "default";
              if (result?.user.role === "admin" && result.user.totp_enabled && !result.session.totp_pending &&
                  (result.tenant.id === targetTenant.id || platformAdmin)) authed = true;
            }
          }
          if (!authed) throw new Error("unauthorized");
          await repo.adapter.setSearchPath(targetTenant.schema_name);
          const target = await repo.getKioskById(kioskId);
          if (!target || isAndroidViewer(target) || !kioskDebugEnabled(target)) throw new Error("kiosk does not support debug");
        } catch (authErr) {
          obs.log.warn("admin debug WS auth failed for kiosk {id}: {err} (cookie present: {hasCookie}, cookieName: {cn})", {
            id: kioskId,
            err: (authErr as Error).message,
            hasCookie: cookieHeader.length > 0,
            cn: cookieName,
          });
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (adminWs) => {
          addDebugSubscriber(kioskId, adminWs);
          obs.log.info("admin debug WS connected for kiosk {id}", { id: kioskId });
          // Relay admin → kiosk messages (terminal-auth, terminal-data, terminal-close, journal-start/stop).
          adminWs.on("message", (data) => {
            try {
              const msg = JSON.parse(data.toString()) as Record<string, unknown>;
              const relayTypes = ["journal-start", "journal-stop", "terminal-request",
                "terminal-auth", "terminal-data", "terminal-close"];
              if (relayTypes.includes(msg["type"] as string)) {
                sendToKiosk(kioskId, msg);
              }
            } catch { /* ignore */ }
          });
        });
        return;
      }

      if (url.pathname !== "/ws/kiosk") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      const token = url.searchParams.get("token");
      if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      try {
        const kiosk = await auth.verifyKioskKey(token);
        if (!kiosk) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        await repo.adapter.setSearchPath(kiosk.schema_name);
        const kioskData = await repo.getKioskById(kiosk.id);
        if (!kioskData?.enabled) {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }
        const viewer = isAndroidViewer(kioskData);
        wss.handleUpgrade(req, socket, head, (ws) => {
          const previous = connectedKiosks.get(kiosk.id);
          connectedKiosks.set(kiosk.id, {
            id: kiosk.id, name: kioskData.name, ws, lastPong: Date.now(),
            // Keep the assignment closure owned by its authenticated socket so
            // disconnect, replacement and disposal release it together.
            ...(viewer ? { validateViewerPower: (message: object) => repo.adapter.withSearchPath(kiosk.schema_name, async () => {
              const current = await repo.getKioskById(kiosk.id);
              if (!current?.enabled || !supportsAndroidStandby(current) || !ownsPowerSession(kiosk.id, ws)) return false;
              const displays = (await repo.listDisplaysForKiosk(current.id)).filter((display) => display.is_enabled);
              return displays.length === 1 && androidViewerCommandAllowed(message, undefined, { supported: true, displayId: displays[0]!.id });
            }) } : {}),
            ...(viewer ? { validateViewerLayout: (layoutId: string) => repo.adapter.withSearchPath(kiosk.schema_name, async () => {
              const current = await repo.getKioskById(kiosk.id);
              return Boolean(current?.enabled && isAndroidViewer(current) && (await viewerAssignment(repo, current)).layoutIds.has(layoutId));
            }) } : {}),
          });
          if (viewer) bindPowerSession(kiosk.id, ws, readPowerSample({
            power_session_id: url.searchParams.get("power_session_id"),
            power_revision: url.searchParams.has("power_revision") ? Number(url.searchParams.get("power_revision")) : undefined,
          }));
          else if (previous) unbindPowerSession(kiosk.id, previous.ws);
          if (previous && previous.ws !== ws) {
            for (const [requestId, pending] of pendingRequests) {
              if (pending.socket !== previous.ws) continue;
              pendingRequests.delete(requestId);
              clearTimeout(pending.timer);
              pending.reject(new Error("kiosk connection replaced"));
            }
            previous.ws.terminate();
          }
          obs.log.info("kiosk connected: {name}", { name: kioskData.name });
          ws.on("error", () => ws.terminate());
          ws.send(JSON.stringify({ type: "connected", kiosk_id: kiosk.id }));
          drainOfflineQueue(kiosk.id);
          nodered.forward(
            "kiosk.changed",
            {
              kiosk_id: kiosk.id,
              kiosk_name: kioskData.name,
              event: "connected",
              source: "server",
            },
            { tenant_id: kiosk.tenant_id, tenant_slug: kiosk.tenant_slug, tenant_name: kiosk.tenant_name },
          );

          ws.on("message", (data) => {
            if (connectedKiosks.get(kiosk.id)?.ws !== ws) return;
            try {
              const msg = JSON.parse(data.toString()) as Record<string, unknown>;
              if (msg["type"] === "pong") { connectedKiosks.pong(kiosk.id, ws); return; }
              if (msg["type"] === "power-result") {
                const sample = readPowerSample(msg);
                if (!ownsPowerSession(kiosk.id, ws) || !powerSampleAllowed(kiosk.id, sample)) return;
                acceptPowerResult(pendingRequests, kiosk.id, ws, msg, (accepted) => {
                  if (accepted) advancePowerSample(kiosk.id, sample!);
                });
                return;
              }
              if (viewer) return; // heartbeat carries viewer health; no proxy/debug/event responses
              if (
                msg["type"] === "onvif-soap-response"
                || msg["type"] === "camera-proxy-response"
                || msg["type"] === "onvif-action-response"
                || msg["type"] === "rotate-local-key-response"
                || msg["type"] === "iobox-control-response"
                || msg["type"] === "operator-enrollment-response"
                || msg["type"] === "operator-stations-response"
                || msg["type"] === "operator-station-revoke-response"
              ) {
                const requestId = typeof msg["request_id"] === "string" ? msg["request_id"] : "";
                const pending = pendingRequests.get(requestId);
                if (!pending || pending.responseType || pending.kioskId !== kiosk.id || pending.socket !== ws) return;
                pendingRequests.delete(requestId);
                clearTimeout(pending.timer);
                const error = typeof msg["error"] === "string" ? msg["error"] : "";
                if (error) {
                  pending.reject(new Error(error));
                } else {
                  pending.resolve(msg);
                }
                return;
              }
              // Relay debug messages (journal + terminal) to admin subscribers.
              const debugTypes = ["journal-line", "terminal-challenge", "terminal-granted",
                "terminal-denied", "terminal-data"];
              if (debugTypes.includes(msg["type"] as string)) {
                relayToDebugSubscribers(kiosk.id, data.toString());
                return;
              }
              if (msg["type"] === "status") {
                obs.log.info("kiosk status: {data}", { data: data.toString() });
                const cpu = typeof msg["cpu_temp_c"] === "number" ? msg["cpu_temp_c"] : null;
                const cpuLoad = typeof msg["cpu_load_percent"] === "number" ? msg["cpu_load_percent"] : null;
                const fanRpm = typeof msg["fan_rpm"] === "number" ? msg["fan_rpm"] : null;
                const fanPwm = typeof msg["fan_pwm"] === "number" ? msg["fan_pwm"] : null;
                const telemetry = {
                  kiosk_id: kiosk.id,
                  kiosk_name: kioskData.name,
                  cpu_temp_c: cpu,
                  cpu_load_percent: cpuLoad,
                  fan_rpm: fanRpm,
                  fan_pwm: fanPwm,
                  memory_total_mb: typeof msg["memory_total_mb"] === "number" ? msg["memory_total_mb"] : null,
                  memory_used_mb: typeof msg["memory_used_mb"] === "number" ? msg["memory_used_mb"] : null,
                  disk_total_mb: typeof msg["disk_total_mb"] === "number" ? msg["disk_total_mb"] : null,
                  disk_free_mb: typeof msg["disk_free_mb"] === "number" ? msg["disk_free_mb"] : null,
                  disk_used_percent: typeof msg["disk_used_percent"] === "number" ? msg["disk_used_percent"] : null,
                };
                nodered.forward(
                  "kiosk.changed",
                  {
                    ...telemetry,
                    event: "heartbeat",
                    source: "server",
                  },
                  { tenant_id: kiosk.tenant_id, tenant_slug: kiosk.tenant_slug, tenant_name: kiosk.tenant_name },
                );
                // Dedicated status topic — same payload sans the event marker
                // so bf-trigger-status can listen on a heartbeat-only channel
                // without filtering connect/disconnect noise out.
                nodered.forward(
                  "kiosk.status",
                  { ...telemetry, source: "server" },
                  { tenant_id: kiosk.tenant_id, tenant_slug: kiosk.tenant_slug, tenant_name: kiosk.tenant_name },
                );
              }
            } catch {
              // ignore malformed
            }
          });

          ws.on("close", () => {
            unbindPowerSession(kiosk.id, ws);
            if (!connectedKiosks.removeSocket(kiosk.id, ws)) return;
            for (const [requestId, pending] of pendingRequests) {
              if (pending.socket !== ws) continue;
              pendingRequests.delete(requestId);
              clearTimeout(pending.timer);
              pending.reject(new Error("kiosk disconnected"));
            }
            obs.log.info("kiosk disconnected: {name}", { name: kioskData.name });
            nodered.forward(
              "kiosk.changed",
              {
                kiosk_id: kiosk.id,
                kiosk_name: kioskData.name,
                event: "disconnected",
                source: "server",
              },
              { tenant_id: kiosk.tenant_id, tenant_slug: kiosk.tenant_slug, tenant_name: kiosk.tenant_name },
            );
          });
        });
      } catch (err) {
        obs.log.warn("ws upgrade error: {err}", { err: (err as Error).message });
        socket.destroy();
      }
    });

    httpServer.listen(this.config.port, this.config.host, () => {
      obs.log.info("coordinator-ws listening on {host}:{port}", {
        host: this.config.host,
        port: this.config.port,
      });
    });

    // Register coordinator API for other plugins to use
    setCoordinator({
      sendToKiosk,
      sendPowerToKiosk,
      requestKiosk,
      broadcastAll,
      notifyBundleChanged: () => broadcastAll({ type: "reload-bundle" }),
      notifyKioskBundleChanged: (kioskId: string) =>
        sendToKiosk(kioskId, { type: "reload-bundle" }),
    });

    this.httpServer = httpServer;
    this.wss = wss;

    // Ping connected kiosks every 30s
    this.pingInterval = setInterval(() => {
      connectedKiosks.terminateStale();
      const payload = JSON.stringify({ type: "ping", t: Date.now() });
      for (const k of connectedKiosks.values()) {
        try {
          if (k.ws.readyState === WebSocket.OPEN) k.ws.send(payload);
        } catch {
          // ignore
        }
      }
    }, 30_000);
  }

  async run(_obs: Observable): Promise<void> {}

  async dispose(): Promise<void> {
    if (this.pingInterval) clearInterval(this.pingInterval);
    for (const k of connectedKiosks.values()) {
      unbindPowerSession(k.id, k.ws);
      try { k.ws.close(); } catch { /* ignore */ }
    }
    connectedKiosks.clear();
    await new Promise<void>((resolve) => {
      if (this.wss) this.wss.close();
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
    await this.dbClose?.();
  }
}
