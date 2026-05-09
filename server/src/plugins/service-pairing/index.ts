/**
 * service-pairing — 8-char code state machine for kiosk pairing.
 *
 * Kiosk shows code on screen, admin enters it in UI, server delivers
 * kiosk_key + cluster_key + bundle_url via one-shot poll.
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
    codeTtlSeconds: av.int().min(60).max(3600).default(600),
  },
  { unknownKeys: "strip" },
);

export const Config = createConfigSchema(
  {
    name: "service-pairing",
    description: "Kiosk pairing code state machine.",
    tags: ["service", "pairing", "kiosk"],
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
  initAfterPlugins?: string[] = ["service-store", "service-secrets"];
  runBeforePlugins?: string[];
  runAfterPlugins?: string[];

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super(cfg);
  }

  async init(_obs: Observable): Promise<void> {
    // TODO: implement initiate/claim/poll state machine
  }

  async run(_obs: Observable): Promise<void> {}

  async dispose(): Promise<void> {}
}
