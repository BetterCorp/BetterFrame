/**
 * service-bundle — label-scoped bundle generation for kiosks.
 *
 * Queries layouts/cameras/labels for a kiosk's label set, encrypts ONVIF
 * passwords with the cluster key, and returns a versioned JSON bundle
 * the kiosk caches locally.
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
    name: "service-bundle",
    description: "Label-aware bundle generation for kiosks.",
    tags: ["service", "bundle", "kiosk"],
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
    // TODO: implement bundle query + cluster-encrypt
  }

  async run(_obs: Observable): Promise<void> {}

  async dispose(): Promise<void> {}
}
