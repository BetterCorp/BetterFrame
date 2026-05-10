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
import { WebSocketServer, WebSocket } from "ws";

import { getRepo } from "../../shared/plugin-registry.js";
import { initSecrets } from "../../shared/secrets.js";
import { createAuth } from "../../shared/auth.js";
import { setCoordinator } from "../../shared/coordinator-registry.js";

// ---- Config -----------------------------------------------------------------

const ConfigSchema = av.object(
  {
    host: av.string().default("0.0.0.0"),
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
  id: number;
  name: string;
  ws: WebSocket;
}

const connectedKiosks = new Map<number, ConnectedKiosk>();

function sendToKiosk(kioskId: number, message: object): boolean {
  const k = connectedKiosks.get(kioskId);
  if (!k || k.ws.readyState !== WebSocket.OPEN) return false;
  k.ws.send(JSON.stringify(message));
  return true;
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
  initAfterPlugins?: string[] = ["service-store"];
  runBeforePlugins?: string[];
  runAfterPlugins?: string[];

  private httpServer?: HttpServer;
  private wss?: WebSocketServer;
  private pingInterval?: ReturnType<typeof setInterval>;

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
        const kioskData = repo.getKioskById(kiosk.id);
        if (!kioskData) {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          connectedKiosks.set(kiosk.id, { id: kiosk.id, name: kioskData.name, ws });
          obs.log.info("kiosk connected: {name}", { name: kioskData.name });
          ws.send(JSON.stringify({ type: "connected", kiosk_id: kiosk.id }));

          ws.on("message", (data) => {
            try {
              const msg = JSON.parse(data.toString());
              if (msg.type === "pong") return;
              if (msg.type === "status") {
                obs.log.info("kiosk status: {data}", { data: data.toString() });
              }
            } catch {
              // ignore malformed
            }
          });

          ws.on("close", () => {
            connectedKiosks.delete(kiosk.id);
            obs.log.info("kiosk disconnected: {name}", { name: kioskData.name });
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
      broadcastAll,
      notifyBundleChanged: () => broadcastAll({ type: "reload-bundle" }),
      notifyKioskBundleChanged: (kioskId: number) =>
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
    return new Promise((resolve) => {
      if (this.wss) this.wss.close();
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
