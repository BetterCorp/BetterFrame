/**
 * service-coordinator-ws — WebSocket hub for live kiosk channel.
 *
 * Kiosks connect here to receive real-time layout switches, power
 * commands, and status pings. Port 18082 behind the Angie proxy.
 */
import * as av from "@anyvali/js";
import {
  BSBService,
  type BSBServiceConstructor,
  createConfigSchema,
  createEventSchemas,
  type Observable,
} from "@bsb/base";

// ---- Config -----------------------------------------------------------------

const ConfigSchema = av.object(
  {
    host: av.string().default("127.0.0.1"),
    port: av.int().min(1).max(65535).default(18082),
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
  initAfterPlugins?: string[] = ["service-store", "service-auth"];
  runBeforePlugins?: string[];
  runAfterPlugins?: string[];

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super(cfg);
  }

  async init(_obs: Observable): Promise<void> {
    // TODO: create ws server, handle kiosk auth + message routing
  }

  async run(_obs: Observable): Promise<void> {}

  async dispose(): Promise<void> {
    // TODO: close ws server
  }
}
