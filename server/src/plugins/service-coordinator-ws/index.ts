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
import * as av from "@anyvali/js";
import {
  BSBService,
  type BSBServiceConstructor,
  createConfigSchema,
  createEventSchemas,
  type Observable,
} from "@bsb/base";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

import type { DbConfig } from "../../shared/db/config.js";
import { initDb } from "../../shared/db/init.js";
import { initSecrets } from "../../shared/secrets.js";
import { createAuth } from "../../shared/auth.js";
import { setCoordinator } from "../../shared/coordinator-registry.js";
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

interface ConnectedKiosk {
  id: string;
  name: string;
  ws: WebSocket;
}

const connectedKiosks = new Map<string, ConnectedKiosk>();
const pendingRequests = new Map<string, {
  kioskId: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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

function sendToKiosk(kioskId: string, message: object): boolean {
  const k = connectedKiosks.get(kioskId);
  const payload = JSON.stringify(message);
  if (!k || k.ws.readyState !== WebSocket.OPEN) {
    // Queue for later delivery.
    let q = offlineQueues.get(kioskId);
    if (!q) { q = []; offlineQueues.set(kioskId, q); }
    q.push(payload);
    if (q.length > MESSAGE_QUEUE_CAP) q.shift(); // FIFO eviction
    return false;
  }
  k.ws.send(payload);
  return true;
}

function drainOfflineQueue(kioskId: string): void {
  const q = offlineQueues.get(kioskId);
  if (!q || q.length === 0) return;
  const k = connectedKiosks.get(kioskId);
  if (!k || k.ws.readyState !== WebSocket.OPEN) return;
  for (const msg of q) {
    try { k.ws.send(msg); } catch { break; }
  }
  offlineQueues.delete(kioskId);
}

function requestKiosk<T = unknown>(kioskId: string, message: object, timeoutMs = 10000): Promise<T> {
  const requestId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("kiosk request timed out"));
    }, timeoutMs);
    pendingRequests.set(requestId, {
      kioskId,
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    });
    const sent = sendToKiosk(kioskId, { ...message, request_id: requestId });
    if (!sent) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      reject(new Error("kiosk is not connected"));
    }
  });
}

function broadcastAll(message: object): void {
  const payload = JSON.stringify(message);
  for (const k of connectedKiosks.values()) {
    if (k.ws.readyState === WebSocket.OPEN) k.ws.send(payload);
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

    const wss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", async (req: IncomingMessage, socket, head) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      // Admin debug WS: /ws/admin/debug/:kioskId?token=<admin_api_key>
      // Subscribes to a kiosk's journal + terminal output stream.
      if (url.pathname.startsWith("/ws/admin/debug/")) {
        const kioskIdStr = url.pathname.split("/").pop() ?? "";
        const kioskId = String(kioskIdStr);
        if (!Number.isInteger(kioskId) || kioskId === "") {
          socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
          socket.destroy();
          return;
        }
        // Auth: try API key from query param, then session cookie.
        const adminToken = url.searchParams.get("token");
        const cookieHeader = req.headers.cookie ?? "";
        try {
          let authed = false;
          if (adminToken) {
            const key = await auth.verifyApiKey(adminToken, null);
            if (key) authed = true;
          }
          if (!authed && cookieHeader) {
            const cookieVal = parseCookieValue(cookieHeader, cookieName);
            if (cookieVal) {
              const result = await auth.resolveSession(cookieVal);
              if (result) authed = true;
            }
          }
          if (!authed) throw new Error("unauthorized");
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
        const kioskData = await repo.getKioskById(kiosk.id);
        if (!kioskData) {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          connectedKiosks.set(kiosk.id, { id: kiosk.id, name: kioskData.name, ws });
          obs.log.info("kiosk connected: {name}", { name: kioskData.name });
          ws.send(JSON.stringify({ type: "connected", kiosk_id: kiosk.id }));
          drainOfflineQueue(kiosk.id);
          nodered.forward("kiosk.changed", {
            kiosk_id: kiosk.id,
            kiosk_name: kioskData.name,
            event: "connected",
            source: "server",
          });

          ws.on("message", (data) => {
            try {
              const msg = JSON.parse(data.toString()) as Record<string, unknown>;
              if (msg["type"] === "pong") return;
              if (msg["type"] === "onvif-soap-response") {
                const requestId = typeof msg["request_id"] === "string" ? msg["request_id"] : "";
                const pending = pendingRequests.get(requestId);
                if (!pending || pending.kioskId !== kiosk.id) return;
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
                nodered.forward("kiosk.changed", {
                  ...telemetry,
                  event: "heartbeat",
                  source: "server",
                });
                // Dedicated status topic — same payload sans the event marker
                // so bf-trigger-status can listen on a heartbeat-only channel
                // without filtering connect/disconnect noise out.
                nodered.forward("kiosk.status", { ...telemetry, source: "server" });
              }
            } catch {
              // ignore malformed
            }
          });

          ws.on("close", () => {
            connectedKiosks.delete(kiosk.id);
            for (const [requestId, pending] of pendingRequests) {
              if (pending.kioskId !== kiosk.id) continue;
              pendingRequests.delete(requestId);
              clearTimeout(pending.timer);
              pending.reject(new Error("kiosk disconnected"));
            }
            obs.log.info("kiosk disconnected: {name}", { name: kioskData.name });
            nodered.forward("kiosk.changed", {
              kiosk_id: kiosk.id,
              kiosk_name: kioskData.name,
              event: "disconnected",
              source: "server",
            });
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
