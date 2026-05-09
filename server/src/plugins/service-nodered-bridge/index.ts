/**
 * service-nodered-bridge — bidirectional HTTP bridge to Node-RED.
 *
 * Forwards events from the BSB bus to Node-RED HTTP-in endpoints,
 * and exposes callbacks for Node-RED to push back into the bus.
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
    noderedUrl: av.string().minLength(1).default("http://127.0.0.1:1880"),
  },
  { unknownKeys: "strip" },
);

export const Config = createConfigSchema(
  {
    name: "service-nodered-bridge",
    description: "HTTP bridge between BSB event bus and Node-RED.",
    tags: ["service", "nodered", "bridge"],
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

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super(cfg);
  }

  async init(_obs: Observable): Promise<void> {
    // TODO: set up outbound HTTP forwarder + inbound callback routes
  }

  async run(_obs: Observable): Promise<void> {}

  async dispose(): Promise<void> {}
}
