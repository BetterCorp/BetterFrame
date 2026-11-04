import * as av from "anyvali";
import {
  createConfigSchema,
  createEventSchemas,
  type BSBServiceConstructor,
  type Observable,
} from "@bsb/base";
import { BPService, BetterPortalConfigSchema, type BPServiceDefinition } from "@betterportal/plugin-bsb";
import type { AdminDeps } from "../service-admin-http/index.js";
import { getAdminRuntime } from "../../shared/admin/runtime.js";
import { bindExistingBpTenant, ensureBpTenant, type BpIdentity } from "../../shared/admin/bp-tenants.js";

export const Config = createConfigSchema(
  {
    name: "service-betterportal-frame",
    description: "BetterFrame administration inside BetterPortal",
    tags: ["service", "betterportal", "frame"],
  },
  av.object({
    host: av.string().default("127.0.0.1"),
    port: av.int().min(1).max(65535).default(18083),
    installationId: av.string().minLength(1),
    existingTenantBindings: av
      .array(av.object({ bpTenantId: av.string().minLength(1), frameTenantId: av.string().minLength(1) }))
      .default([]),
    betterportal: BetterPortalConfigSchema,
  }),
);
export const EventSchemas = createEventSchemas({
  emitEvents: {},
  onEvents: {},
  emitReturnableEvents: {},
  onReturnableEvents: {},
  emitBroadcast: {},
  onBroadcast: {},
});

export class Plugin extends BPService<InstanceType<typeof Config>, typeof EventSchemas> {
  static Config = Config;
  static EventSchemas = EventSchemas;
  initAfterPlugins = ["service-admin-http"];
  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super({ ...cfg, eventSchemas: EventSchemas });
  }
  protected definition(): BPServiceDefinition {
    return {
      manifest: {
        pluginId: "cloud.betterportal.frame",
        title: "BetterFrame",
        description: "Tenant-isolated camera, display and fleet administration.",
      },
    };
  }
  override async init(obs: Observable): Promise<void> {
    const runtime = getAdminRuntime();
    for (const binding of this.config.existingTenantBindings) {
      await bindExistingBpTenant(
        runtime.deps.repo,
        this.config.installationId,
        binding.bpTenantId,
        binding.frameTenantId,
      );
    }
    await super.init(obs);
  }
  async withTenant<T>(ctx: BpIdentity, operation: (deps: AdminDeps) => Promise<T>): Promise<T> {
    const deps = getAdminRuntime().deps;
    const tenant = await ensureBpTenant(
      deps.repo,
      this.config.installationId,
      ctx,
      deps.scheduleNoderedReconcile,
    );
    return deps.repo.adapter.withSearchPath(tenant.schema_name, () => operation(deps));
  }
}
export type PluginFeature = Pick<Plugin, "withTenant">;
