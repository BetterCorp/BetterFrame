import assert from "node:assert/strict";
import test from "node:test";
import { switchLayout } from "../src/shared/admin/bp-workflows.js";
import { getCoordinator, setCoordinator } from "../src/shared/coordinator-registry.js";
import type { AdminDeps } from "../src/plugins/service-admin-http/index.js";
import type { BpIdentity } from "../src/shared/admin/bp-tenants.js";

const identity = {
  tenant: { id: "bp-tenant" },
  app: { id: "bp-app" },
  user: { sub: "member", iss: "https://auth.test", roles: ["writer"] },
} as BpIdentity;
function fixture(
  mode: "delivered" | "offline" | "sandbox" | "unassigned" | "disabled" | "unattached",
) {
  const events: unknown[][] = [];
  const order: string[] = [];
  const deps = {
    sandboxMode: mode === "sandbox",
    bpTenant: { id: "frame-tenant", slug: "tenant-slug", name: "Tenant name" },
    repo: {
      getDisplayById: async () => ({
        id: "display",
        kiosk_id: mode === "unassigned" ? null : "kiosk",
        is_enabled: mode !== "disabled",
      }),
      listLayoutsForDisplay: async () =>
        mode === "unattached" ? [] : [{ id: "layout", name: "Reception" }],
      insertAudit: async () => {
        order.push("audit");
      },
    },
    nodered: {
      forward: (...args: unknown[]) => {
        order.push("notification");
        events.push(args);
      },
    },
  } as unknown as AdminDeps;
  setCoordinator({
    ...getCoordinator(),
    sendToKiosk: (id, message, queue) => {
      assert.equal(id, "kiosk");
      assert.deepEqual(message, {
        type: "layout-switch",
        display_id: "display",
        layout_id: "layout",
      });
      assert.equal(queue, false);
      order.push("dispatch");
      return mode !== "offline";
    },
  });
  return { deps, events, order };
}
test("BP layout delivery forwards the tenant-scoped Node-RED event without kiosk telemetry", async (t) => {
  const original = getCoordinator();
  t.after(() => setCoordinator(original));
  const f = fixture("delivered");
  await switchLayout(f.deps, identity, "display", "layout");
  assert.deepEqual(f.events, [
    [
      "layout.changed",
      {
        display_id: "display",
        kiosk_id: "kiosk",
        layout_id: "layout",
        layout_name: "Reception",
        source: "server",
      },
      { tenant_id: "frame-tenant", tenant_slug: "tenant-slug", tenant_name: "Tenant name" },
    ],
  ]);
  assert.deepEqual(f.order, ["dispatch", "notification", "audit"]);
});
test("BP layout rejection never emits a Node-RED change notification", async (t) => {
  const original = getCoordinator();
  t.after(() => setCoordinator(original));
  for (const mode of ["offline", "sandbox", "unassigned", "disabled", "unattached"] as const) {
    const f = fixture(mode);
    await assert.rejects(switchLayout(f.deps, identity, "display", "layout"));
    assert.deepEqual(f.events, [], mode);
    assert.deepEqual(f.order, mode === "offline" ? ["dispatch"] : [], mode);
  }
});
