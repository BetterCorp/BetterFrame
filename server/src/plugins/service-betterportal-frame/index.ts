import * as av from "anyvali";
import {
  createConfigSchema,
  createEventSchemas,
  type BSBServiceConstructor,
  type Observable,
} from "@bsb/base";
import { FrameTenantConfigSchemas, userIsolationEnabled } from "./config.js";
import { assignExistingBpResources, withBpUserAccess } from "../../shared/admin/bp-access.js";
import {
  BPService,
  BetterPortalConfigSchema,
  type BPServiceDefinition,
} from "@betterportal/plugin-bsb";
import type { AdminDeps } from "../service-admin-http/index.js";
import { getAdminRuntime } from "../../shared/admin/runtime.js";
import {
  bindExistingBpTenant,
  ensureBpTenant,
  type BpIdentity,
} from "../../shared/admin/bp-tenants.js";

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
      .array(
        av.object({
          bpTenantId: av.string().minLength(1),
          frameTenantId: av.string().minLength(1),
        }),
      )
      .default([]),
    existingResourceOwners: av
      .array(
        av.object({
          bpTenantId: av.string().minLength(1),
          migrationId: av.string().minLength(1),
          issuer: av.string().minLength(1),
          subject: av.string().minLength(1),
        }),
      )
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
        configSchemas: FrameTenantConfigSchemas,
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
    for (const assignment of this.config.existingResourceOwners) {
      const binding = await runtime.deps.repo.adapter.get<{
        schema_name: string;
      }>(
        "SELECT t.schema_name FROM public.bp_tenant_bindings b JOIN public.tenants t ON t.id = b.frame_tenant_id WHERE b.installation_id = ? AND b.bp_tenant_id = ? AND b.state = 'ready' AND t.is_active",
        [this.config.installationId, assignment.bpTenantId],
      );
      if (!binding) throw new Error("Ownership adoption requires an existing ready tenant binding");
      await assignExistingBpResources(
        runtime.deps.repo,
        binding.schema_name,
        assignment.migrationId,
        assignment,
      );
    }
    await super.init(obs);
  }
  protected override async validateTenantApp(tenantId: string, appId: string) {
    const config = this.getPortalConfig();
    return {
      allowed:
        !!config?.tenants.some((t) => t.id === tenantId && t.active) &&
        !!config.apps.some((a) => a.id === appId && a.tenantId === tenantId),
    };
  }
  async withTenant<T>(ctx: BpIdentity, operation: (deps: AdminDeps) => Promise<T>): Promise<T> {
    const deps = getAdminRuntime().deps;
    const tenant = await ensureBpTenant(
      deps.repo,
      this.config.installationId,
      ctx,
      deps.scheduleNoderedReconcile,
    );
    // Read the tenant scope only: an app override must never disable this tenant boundary.
    const isolate = userIsolationEnabled(this.effectiveServiceConfig(ctx.tenant.id));
    return withBpUserAccess(deps, ctx, tenant, isolate, operation);
  }
}
export type PluginFeature = Pick<Plugin, "withTenant">;
