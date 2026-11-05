import { createError } from "h3";
import type { AdminDeps } from "../../plugins/service-admin-http/index.js";
import type { BpIdentity } from "./bp-tenants.js";
import { getCoordinator } from "../coordinator-registry.js";
import { withPowerStateLock } from "../power-state-order.js";
import { sendPowerCommand } from "./power.js";
import { bpAudit } from "./bp-audit.js";

export async function changePower(
  deps: AdminDeps,
  ctx: BpIdentity,
  id: string,
  state: "on" | "standby",
  kind: "kiosks" | "displays",
): Promise<void> {
  if (kind === "kiosks" && !(await deps.repo.getKioskById(id)))
    throw createError({ statusCode: 404, statusMessage: "Kiosk not found" });
  const display =
    kind === "displays" ? await deps.repo.getDisplayById(id) : null;
  if (kind === "displays" && !display)
    throw createError({ statusCode: 404, statusMessage: "Display not found" });
  const kioskId = display?.kiosk_id ?? (kind === "kiosks" ? id : undefined);
  if (!kioskId)
    throw createError({
      statusCode: 409,
      statusMessage: "Display has no kiosk",
    });
  await withPowerStateLock(kioskId, async () => {
    const result = await sendPowerCommand(
      deps,
      kioskId,
      state,
      kind === "displays" ? id : undefined,
    );
    if (result instanceof Response) {
      const error = (await result.json()) as { error: string };
      throw createError({
        statusCode: result.status,
        statusMessage: error.error,
      });
    }
    for (const target of result.displayIds)
      await deps.repo.updateDisplay(target, {
        actual_power_state: state === "on" ? "awake" : "standby",
        actual_power_state_at: new Date().toISOString(),
      });
    const tenant = deps.bpTenant;
    if (tenant && !deps.sandboxMode)
      deps.nodered.forward(
        "display.power.changed",
        {
          display_id: result.displayIds[0] ?? null,
          kiosk_id: kioskId,
          state,
          source: "server",
        },
        {
          tenant_id: tenant.id,
          tenant_slug: tenant.slug,
          tenant_name: tenant.name,
        },
      );
    await bpAudit(deps, ctx, `frame.${kind}.power.${state}`, id);
  });
}
export async function switchLayout(
  deps: AdminDeps,
  ctx: BpIdentity,
  displayId: string,
  layoutId: string,
): Promise<void> {
  const display = await deps.repo.getDisplayById(displayId);
  if (!display)
    throw createError({ statusCode: 404, statusMessage: "Display not found" });
  if (!display.is_enabled || !display.kiosk_id)
    throw createError({
      statusCode: 409,
      statusMessage: "Display is disabled or unassigned",
    });
  const attached = await deps.repo.listLayoutsForDisplay(displayId);
  if (!attached.some((layout) => layout.id === layoutId))
    throw createError({
      statusCode: 404,
      statusMessage: "Layout is not assigned to this display",
    });
  if (deps.sandboxMode)
    throw createError({
      statusCode: 409,
      statusMessage:
        "Live device commands are disabled in this test deployment",
    });
  if (
    !getCoordinator().sendToKiosk(
      display.kiosk_id,
      { type: "layout-switch", display_id: displayId, layout_id: layoutId },
      false,
    )
  )
    throw createError({ statusCode: 409, statusMessage: "Kiosk is offline" });
  await bpAudit(deps, ctx, "frame.displays.layout", displayId);
}
