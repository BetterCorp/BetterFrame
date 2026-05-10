/**
 * service-coordinator-ws — WebSocket hub for live kiosk channel.
 *
 * Uses raw Node.js WebSocket server (ws package via h3's optional crossws).
 * For v0.1, uses a standalone HTTP server + ws upgrade.
 *
 * Kiosks connect with ?token=<kiosk_key>. Server pushes:
 *   - layout-switch, power, reload-bundle, ping
 */
import * as av from "@anyvali/js";
import {
  BSBService,
  type BSBServiceConstructor,
  createConfigSchema,
  createEventSchemas,
  type Observable,
} from "@bsb/base";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { getRepo } from "../../shared/plugin-registry.js";
import { initSecrets } from "../../shared/secrets.js";
import { createAuth, type AuthApi } from "../../shared/auth.js";

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

// ---- Plugin -----------------------------------------------------------------

export class Plugin extends BSBService<InstanceType<typeof Config>, typeof EventSchemas> {
  static override Config = Config;
  static override EventSchemas = EventSchemas;

  initBeforePlugins?: string[];
  initAfterPlugins?: string[] = ["service-store"];
  runBeforePlugins?: string[];
  runAfterPlugins?: string[];

  private httpServer?: ReturnType<typeof createServer>;
  private pingInterval?: ReturnType<typeof setInterval>;

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super(cfg);
  }

  async init(obs: Observable): Promise<void> {
    // Placeholder — full WS implementation requires 'ws' package or crossws.
    // For now, start a basic HTTP server that responds to health checks.
    // WS upgrade will be added when crossws or ws is installed.
    const server = createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.listen(this.config.port, this.config.host, () => {
      obs.log.info("coordinator-ws listening on {host}:{port}", {
        host: this.config.host,
        port: this.config.port,
      });
    });

    this.httpServer = server;
  }

  async run(_obs: Observable): Promise<void> {}

  async dispose(): Promise<void> {
    if (this.pingInterval) clearInterval(this.pingInterval);
    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
