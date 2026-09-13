import assert from "node:assert/strict";
import test from "node:test";
import { H3 } from "h3";
import { registerAdminRoutes } from "../src/plugins/service-admin-http/routes-admin.js";
import { getCoordinator, setCoordinator } from "../src/shared/coordinator-registry.js";

function fixture(capabilities: string[], delivered: boolean, enabled = true) {
  const commands: { id: string; message: object; queue?: boolean }[] = [];
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const events: unknown[][] = [];
  const audits: Record<string, unknown>[] = [];
  const display = { id: "display", kiosk_id: "kiosk", actual_power_state: "unknown" };
  const app = new H3();
  registerAdminRoutes(app, {
    repo: {
      getKioskById: async () => ({ id: "kiosk", capabilities, enabled }),
      getDisplayById: async () => display,
      listDisplaysForKiosk: async () => [display],
      updateDisplay: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); },
      insertAudit: async (entry: Record<string, unknown>) => { audits.push(entry); },
    },
    nodered: { forward: (...args: unknown[]) => { events.push(args); } },
  } as never);
  setCoordinator({
    ...getCoordinator(),
    sendToKiosk: (id, message, queue) => { commands.push({ id, message, queue }); return delivered; },
  });
  return { app, commands, updates, events, audits };
}

test("power routes reject unsupported or undelivered commands without reporting a state change", async (t) => {
  const original = getCoordinator();
  t.after(() => setCoordinator(original));
  for (const target of ["displays/display", "kiosks/kiosk"]) {
    for (const command of ["wake", "standby"]) {
      for (const mode of ["viewer", "offline-viewer", "undelivered", "disabled"]) {
        const viewer = mode.endsWith("viewer");
        const f = fixture(viewer ? ["android-viewer"] : ["linux"], mode === "viewer", mode !== "disabled");
        const response = await f.app.request(`http://bf.test/admin/${target}/power/${command}`, { method: "POST" });
        assert.equal(response.status, 409, `${mode}: ${target}/${command}`);
        assert.equal(response.headers.get("location"), null);
        assert.deepEqual(f.updates, []);
        assert.deepEqual(f.events, []);
        assert.deepEqual(f.audits, []);
        assert.equal(f.commands.length, mode === "undelivered" ? 1 : 0);
        if (mode === "undelivered") assert.equal(f.commands[0]?.queue, false);
      }
    }
  }
});

test("delivered desktop power commands preserve state, event and audit behavior", async (t) => {
  const original = getCoordinator();
  t.after(() => setCoordinator(original));
  for (const target of ["displays/display", "kiosks/kiosk"]) {
    for (const command of ["wake", "standby"]) {
      const f = fixture(["windows"], true);
      const response = await f.app.request(`http://bf.test/admin/${target}/power/${command}`, { method: "POST" });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), `/admin/${target}`);
      assert.deepEqual(f.commands, [{ id: "kiosk", message: {
        type: command, ...(target.startsWith("displays") ? { display_id: "display" } : {}),
      }, queue: false }]);
      assert.equal(f.updates.length, 1);
      assert.equal(f.updates[0]?.patch.actual_power_state, command === "wake" ? "awake" : "standby");
      assert.equal(f.events.length, 1);
      assert.equal(f.events[0]?.[0], "display.power.changed");
      assert.equal(f.audits.length, target.startsWith("kiosks") ? 1 : 0);
      if (f.audits.length) assert.equal(f.audits[0]?.action, `display.${command}`);
    }
  }
});
