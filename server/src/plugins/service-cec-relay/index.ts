/**
 * service-cec-relay — translates CEC commands to ws messages.
 *
 * Receives CEC control requests from the admin API or Node-RED and
 * relays them to the authoritative kiosk via the coordinator WS channel.
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

const ConfigSchema = av.object({}, { unknownKeys: "strip" });

export const Config = createConfigSchema(
  {
    name: "service-cec-relay",
    description: "Relay CEC commands to the authoritative kiosk.",
    tags: ["service", "cec", "relay"],
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
  initAfterPlugins?: string[] = ["service-coordinator-ws"];
  runBeforePlugins?: string[];
  runAfterPlugins?: string[];

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super(cfg);
  }

  async init(_obs: Observable): Promise<void> {
    // TODO: subscribe to CEC command events, relay via coordinator
  }

  async run(_obs: Observable): Promise<void> {}

  async dispose(): Promise<void> {}
}
